/**
 * How long a voice note runs, read from the audio itself.
 *
 * The webhook does not say. Meta's media object carries an id, a mime type
 * and a hash, and the media endpoint adds a file size; none of them is a
 * duration. That absence was read once as "the transcriber is the only thing
 * that knows", which made the length limit unenforceable and turned it into a
 * reservation window instead. It was the wrong conclusion: the bytes are
 * already downloaded before anything is spent, and a container that stores
 * audio stores how much of it there is.
 *
 * So the limit is a real limit again. A note longer than the merchant's
 * maximum is refused before a transcription provider is called at all, which
 * is what makes it cost protection rather than cost reporting.
 *
 * A PORT, because the parsing below is one implementation of a question that
 * has several: an ffprobe sidecar answers it too, and a deployment that would
 * rather run one should not have to touch the handler.
 */
export interface AudioMetadataProbe {
  /**
   * Duration in whole seconds, rounded UP.
   *
   * Null means the container could not be read. It never means zero: a
   * caller that cannot tell "silent" from "unreadable" will bill one as the
   * other, and the recovery for the two is not the same.
   *
   * Rounding up is deliberate and is the only direction that is safe in both
   * places this number is used. Against the limit, a note a fraction over is
   * over. Against the allowance, the merchant is charged the second they
   * started rather than the one they finished.
   */
  duration(bytes: Buffer, mimeType: string): Promise<number | null>;
}

export const AUDIO_METADATA_PROBE = Symbol('AudioMetadataProbe');

/* ── containers ───────────────────────────────────────────────────────────── */

/**
 * OGG, which is what a WhatsApp voice note actually is.
 *
 * An Ogg stream is a sequence of pages, each carrying a granule position: the
 * running sample count at the end of that page. The last page of the stream
 * therefore holds the total, and the duration is that divided by the sample
 * rate. Opus always reports granules at 48 kHz whatever it encoded at, which
 * is what makes this exact rather than an estimate.
 *
 * Searched backwards from the end, because the last page is the one that
 * matters and a voice note is small enough that the whole buffer is in hand.
 */
function oggSeconds(bytes: Buffer): number | null {
  for (let at = bytes.length - 27; at >= 0; at -= 1) {
    if (
      bytes[at] !== 0x4f ||
      bytes[at + 1] !== 0x67 ||
      bytes[at + 2] !== 0x67 ||
      bytes[at + 3] !== 0x53
    ) {
      continue;
    }
    /* Granule position is 64-bit little-endian at offset 6. All ones is the
     * "no position here" marker, which a header page uses. */
    const granule = bytes.readBigUInt64LE(at + 6);
    if (granule === 0xffff_ffff_ffff_ffffn) continue;
    if (granule === 0n) continue;
    return Math.ceil(Number(granule) / 48_000);
  }
  return null;
}

/**
 * MP4 and M4A, which is what an iPhone forwards.
 *
 * The `mvhd` box carries a timescale and a duration in that scale. Version 0
 * writes both as 32-bit, version 1 as 64-bit, and the version byte is the
 * first byte of the box body. Scanning for the box rather than walking the
 * box tree: the tree walk is more correct and this is a bounded buffer with
 * one `mvhd` in it.
 */
function mp4Seconds(bytes: Buffer): number | null {
  const at = bytes.indexOf('mvhd', 0, 'ascii');
  if (at < 0) return null;
  const version = bytes[at + 4];
  try {
    if (version === 1) {
      const timescale = bytes.readUInt32BE(at + 24);
      const duration = bytes.readBigUInt64BE(at + 28);
      if (!timescale) return null;
      return Math.ceil(Number(duration) / timescale);
    }
    const timescale = bytes.readUInt32BE(at + 16);
    const duration = bytes.readUInt32BE(at + 20);
    if (!timescale) return null;
    return Math.ceil(duration / timescale);
  } catch {
    return null;
  }
}

/** AMR frame sizes in bytes, indexed by mode. Each frame is 20 ms. */
const AMR_FRAME_BYTES = [12, 13, 15, 17, 19, 20, 26, 31, 5, 0, 0, 0, 0, 0, 0, 0];

/**
 * AMR narrowband, which is what an older Android forwards.
 *
 * A header, then frames whose size is a function of the mode in their first
 * byte. Counting them is the duration, at twenty milliseconds each.
 */
function amrSeconds(bytes: Buffer): number | null {
  const header = '#!AMR\n';
  if (bytes.subarray(0, header.length).toString('ascii') !== header) return null;
  let at = header.length;
  let frames = 0;
  while (at < bytes.length) {
    const mode = (bytes[at]! >> 3) & 0x0f;
    const size = AMR_FRAME_BYTES[mode] ?? 0;
    if (size === 0) break;
    at += size + 1;
    frames += 1;
  }
  return frames === 0 ? null : Math.ceil((frames * 20) / 1_000);
}

/** MPEG-1/2 Layer III bitrates in kbps, by version and bitrate index. */
const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_RATES_V1 = [44_100, 48_000, 32_000, 0];
const MP3_RATES_V2 = [22_050, 24_000, 16_000, 0];

/**
 * MP3, from the first frame header.
 *
 * A Xing or Info tag would give an exact frame count for a variable-bitrate
 * file; without one the honest answer is bytes divided by bitrate, which is
 * exact for constant bitrate and an approximation otherwise. Approximate is
 * acceptable HERE and nowhere else in this file, because MP3 reaches Rekoda
 * only as a forwarded attachment rather than as a recorded voice note, and
 * the number is being compared against a limit rather than posted to a
 * ledger.
 */
function mp3Seconds(bytes: Buffer): number | null {
  for (let at = 0; at < Math.min(bytes.length - 4, 200_000); at += 1) {
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) continue;
    const versionBits = (bytes[at + 1]! >> 3) & 0x03;
    if (versionBits === 1) continue;
    const isV1 = versionBits === 3;
    const bitrateIndex = (bytes[at + 2]! >> 4) & 0x0f;
    const rateIndex = (bytes[at + 2]! >> 2) & 0x03;
    const kbps = (isV1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex] ?? 0;
    const sampleRate = (isV1 ? MP3_RATES_V1 : MP3_RATES_V2)[rateIndex] ?? 0;
    if (!kbps || !sampleRate) continue;

    const xing = bytes.indexOf('Xing', at, 'ascii');
    const info = bytes.indexOf('Info', at, 'ascii');
    const tag = xing >= 0 ? xing : info;
    if (tag >= 0 && tag < at + 200) {
      const flags = bytes.readUInt32BE(tag + 4);
      if (flags & 0x01) {
        const frames = bytes.readUInt32BE(tag + 8);
        const samplesPerFrame = isV1 ? 1_152 : 576;
        return Math.ceil((frames * samplesPerFrame) / sampleRate);
      }
    }
    return Math.ceil((bytes.length - at) / ((kbps * 1_000) / 8));
  }
  return null;
}

/**
 * AAC in an ADTS stream: every frame carries 1,024 samples, so the duration
 * is the frame count over the sample rate. Frame length lives in the header,
 * which is what lets the stream be walked without decoding it.
 */
const AAC_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
  7_350, 0, 0, 0,
];

function aacSeconds(bytes: Buffer): number | null {
  let at = 0;
  while (at + 7 < bytes.length) {
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xf0) !== 0xf0) {
      at += 1;
      continue;
    }
    const sampleRate = AAC_RATES[(bytes[at + 2]! >> 2) & 0x0f] ?? 0;
    if (!sampleRate) return null;
    let frames = 0;
    let cursor = at;
    while (cursor + 7 < bytes.length) {
      if (bytes[cursor] !== 0xff || (bytes[cursor + 1]! & 0xf0) !== 0xf0) break;
      const length =
        ((bytes[cursor + 3]! & 0x03) << 11) | (bytes[cursor + 4]! << 3) | (bytes[cursor + 5]! >> 5);
      if (length < 7) break;
      cursor += length;
      frames += 1;
    }
    return frames === 0 ? null : Math.ceil((frames * 1_024) / sampleRate);
  }
  return null;
}

/**
 * The probe Rekoda ships: the five containers Meta accepts for audio, read in
 * process, with no sidecar to deploy and no binary to trust.
 *
 * The mime type chooses the reader and the bytes decide the answer. A mime
 * type nobody recognises returns null rather than guessing, because a wrong
 * duration is worse than no duration: one refuses a note the merchant could
 * have sent, the other transcribes one they could not afford.
 */
export class ContainerAudioProbe implements AudioMetadataProbe {
  duration(bytes: Buffer, mimeType: string): Promise<number | null> {
    const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
    const seconds = readDuration(bytes, type);
    /* A container that parses to nothing is unreadable, not instantaneous. */
    return Promise.resolve(seconds !== null && seconds > 0 ? seconds : null);
  }
}

function readDuration(bytes: Buffer, type: string): number | null {
  if (bytes.length === 0) return null;
  switch (type) {
    case 'audio/ogg':
    case 'audio/opus':
      return oggSeconds(bytes);
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return mp4Seconds(bytes);
    case 'audio/amr':
      return amrSeconds(bytes);
    case 'audio/mpeg':
    case 'audio/mp3':
      return mp3Seconds(bytes);
    case 'audio/aac':
      return aacSeconds(bytes);
    default:
      return null;
  }
}
