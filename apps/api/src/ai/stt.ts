/**
 * Turning a voice note into a sentence (ADR 0005, ADR 0008).
 *
 * A port, like the model and the sender, and for a sharper reason than
 * either: the transcriber is the one dependency whose LOCATION is a promise
 * we make in marketing. "Audio never leaves Rekoda" is only true while this
 * points at our own sidecar, so the seam that makes it swappable is also the
 * seam where that promise could be quietly broken. It is written down here
 * rather than left to whoever edits the config.
 *
 * ADR 0008: the sidecar runs `intronhealth/afrispeech-whisper-medium-all`,
 * because stock `large-v3` is 30 to 45% WER on African-accented English and a
 * bookkeeper that mishears "fifty" as "fifteen" is worse than no bookkeeper.
 * A hosted transcriber is for the M3 benchmark comparator only.
 */
export interface Transcript {
  /** What was said. Raw merchant text: tokenise before it reaches a model. */
  readonly text: string;
  /**
   * How long the audio ran, in whole seconds.
   *
   * Metered, so it is the provider's number rather than ours: `voice_seconds`
   * is an allowance a merchant paid for, and estimating it from a byte count
   * would bill them for our compression settings.
   */
  readonly seconds: number;
  /**
   * The sidecar's own confidence, 0 to 1, when it reports one.
   *
   * Null rather than a default, because "we do not know" and "we are certain"
   * must not be the same value to whoever reads this next.
   */
  readonly confidence: number | null;
}

export interface SpeechToText {
  transcribe(audio: Buffer, mimeType: string): Promise<Transcript>;
}

/** The sidecar could not be reached. Nothing was transcribed, nothing billed. */
export class TranscriptionUnavailable extends Error {
  override readonly name = 'TranscriptionUnavailable';
}

export const SPEECH_TO_TEXT = Symbol('SpeechToText');
