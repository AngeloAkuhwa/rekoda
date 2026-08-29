/**
 * Reading a duration out of the bytes, which is what makes the voice limit a
 * limit rather than a report.
 *
 * Every buffer below is built by hand rather than fixtured, so the test says
 * what the container actually claims and a reader can check the arithmetic
 * without a hex editor.
 */
import { describe, expect, it } from 'vitest';
import { ContainerAudioProbe } from './audio-duration.js';

const probe = new ContainerAudioProbe();

/** An Ogg page whose granule position is `samples`. Opus counts at 48 kHz. */
function oggPage(samples: bigint, segments = 1): Buffer {
  const page = Buffer.alloc(27 + segments);
  page.write('OggS', 0, 'ascii');
  page.writeUInt8(0, 4); // version
  page.writeUInt8(0, 5); // header type
  page.writeBigUInt64LE(samples, 6);
  page.writeUInt32LE(1, 14); // serial
  page.writeUInt32LE(0, 18); // sequence
  page.writeUInt32LE(0, 22); // checksum, unchecked by a duration read
  page.writeUInt8(segments, 26);
  return page;
}

describe('OGG, which is what a WhatsApp voice note is', () => {
  it('reads the total from the last page granule', async () => {
    // 48,000 samples per second; 17 seconds is 816,000.
    const audio = Buffer.concat([oggPage(0n), oggPage(816_000n)]);
    expect(await probe.duration(audio, 'audio/ogg')).toBe(17);
  });

  it('takes the LAST page, not the first', async () => {
    const audio = Buffer.concat([oggPage(48_000n), oggPage(240_000n)]);
    expect(await probe.duration(audio, 'audio/ogg')).toBe(5);
  });

  /* Rounding up in both directions it is used: a note a fraction over the
   * limit is over it, and a merchant is charged the second they started. */
  it('rounds a part second up', async () => {
    const audio = Buffer.concat([oggPage(48_001n)]);
    expect(await probe.duration(audio, 'audio/ogg')).toBe(2);
  });

  it('ignores a header page that carries no position', async () => {
    const header = oggPage(0n);
    header.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 6);
    const audio = Buffer.concat([oggPage(96_000n), header]);
    expect(await probe.duration(audio, 'audio/ogg')).toBe(2);
  });

  it('reads the codec mime type the same way', async () => {
    expect(await probe.duration(oggPage(48_000n), 'audio/ogg; codecs=opus')).toBe(1);
  });
});

describe('MP4 and M4A', () => {
  function mvhd(timescale: number, duration: number): Buffer {
    const box = Buffer.alloc(120);
    box.write('mvhd', 0, 'ascii');
    box.writeUInt8(0, 4); // version 0
    box.writeUInt32BE(timescale, 16);
    box.writeUInt32BE(duration, 20);
    return box;
  }

  it('divides the duration by the timescale', async () => {
    expect(await probe.duration(mvhd(600, 18_000), 'audio/mp4')).toBe(30);
  });

  it('reads a 64-bit version 1 header', async () => {
    const box = Buffer.alloc(120);
    box.write('mvhd', 0, 'ascii');
    box.writeUInt8(1, 4);
    box.writeUInt32BE(1_000, 24);
    box.writeBigUInt64BE(45_000n, 28);
    expect(await probe.duration(box, 'audio/mp4')).toBe(45);
  });

  it('refuses a zero timescale rather than dividing by it', async () => {
    expect(await probe.duration(mvhd(0, 18_000), 'audio/mp4')).toBeNull();
  });
});

describe('AMR', () => {
  /** `frames` frames at mode 7, which is 31 bytes plus the header byte. */
  function amr(frames: number): Buffer {
    const parts = [Buffer.from('#!AMR\n', 'ascii')];
    for (let i = 0; i < frames; i += 1) {
      const frame = Buffer.alloc(32);
      frame.writeUInt8(7 << 3, 0);
      parts.push(frame);
    }
    return Buffer.concat(parts);
  }

  it('counts frames at twenty milliseconds each', async () => {
    // 250 frames × 20 ms = 5,000 ms.
    expect(await probe.duration(amr(250), 'audio/amr')).toBe(5);
  });

  it('refuses a file without the AMR header', async () => {
    expect(await probe.duration(Buffer.alloc(64), 'audio/amr')).toBeNull();
  });
});

describe('MP3', () => {
  /** A 128 kbps 44.1 kHz MPEG-1 Layer III frame header, then padding. */
  function mp3(bytes: number): Buffer {
    const audio = Buffer.alloc(bytes);
    audio.writeUInt8(0xff, 0);
    audio.writeUInt8(0xfb, 1); // MPEG-1, Layer III, no CRC
    audio.writeUInt8(0x90, 2); // 128 kbps, 44.1 kHz
    audio.writeUInt8(0x00, 3);
    return audio;
  }

  it('estimates from the bitrate when there is no Xing tag', async () => {
    // 128 kbps is 16,000 bytes a second; 160,000 bytes is 10 seconds.
    expect(await probe.duration(mp3(160_000), 'audio/mpeg')).toBe(10);
  });

  it('prefers the exact frame count when a Xing tag carries one', async () => {
    const audio = mp3(4_096);
    audio.write('Xing', 40, 'ascii');
    audio.writeUInt32BE(0x01, 44); // frames flag
    audio.writeUInt32BE(345, 48); // 345 × 1,152 / 44,100 = 9.01 s
    expect(await probe.duration(audio, 'audio/mpeg')).toBe(10);
  });
});

describe('AAC in ADTS', () => {
  /** `frames` ADTS frames of `length` bytes at 44.1 kHz. */
  function adts(frames: number, length = 400): Buffer {
    const parts: Buffer[] = [];
    for (let i = 0; i < frames; i += 1) {
      const frame = Buffer.alloc(length);
      frame.writeUInt8(0xff, 0);
      frame.writeUInt8(0xf1, 1);
      frame.writeUInt8((4 << 2) as number, 2); // 44.1 kHz
      frame.writeUInt8(((length >> 11) & 0x03) as number, 3);
      frame.writeUInt8((length >> 3) & 0xff, 4);
      frame.writeUInt8(((length & 0x07) << 5) as number, 5);
      parts.push(frame);
    }
    return Buffer.concat(parts);
  }

  it('counts 1,024 samples a frame', async () => {
    // 431 frames × 1,024 / 44,100 = 10.01 s.
    expect(await probe.duration(adts(431), 'audio/aac')).toBe(11);
  });
});

/**
 * The failure cases, which matter more than the successes: every one of them
 * must be null rather than zero. A caller that reads zero transcribes for
 * free; a caller that reads null asks the merchant to send it again.
 */
describe('what it refuses to guess at', () => {
  it('returns null for a mime type it does not know', async () => {
    expect(await probe.duration(Buffer.from('anything'), 'audio/flac')).toBeNull();
  });

  it('returns null for an empty buffer', async () => {
    expect(await probe.duration(Buffer.alloc(0), 'audio/ogg')).toBeNull();
  });

  it('returns null for bytes that are not the container they claim', async () => {
    expect(await probe.duration(Buffer.from('not an ogg stream at all'), 'audio/ogg')).toBeNull();
  });

  it('never returns zero, which would read as a free transcription', async () => {
    const zeroGranule = oggPage(0n);
    expect(await probe.duration(zeroGranule, 'audio/ogg')).toBeNull();
  });
});
