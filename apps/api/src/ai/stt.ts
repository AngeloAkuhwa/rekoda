/**
 * Turning a voice note into a sentence (ADR 0005, ADR 0008, ADR 0027).
 *
 * A port, like the model and the sender, and for a sharper reason than
 * either: the transcriber is the one dependency whose LOCATION decides what
 * /ai-privacy may claim. ADR 0027 made hosted transcription the launch
 * configuration — audio goes to a processor under API terms that exclude
 * training, comes back as text, and that text is tokenised before any
 * reasoning model sees it. The privacy pages say exactly that; the day a
 * deployment sets `STT_URL` and runs the AfriSpeech sidecar (ADR 0008 —
 * tuned for African-accented English, where stock models run 30-45% WER),
 * they may say the stronger sentence again. The seam is written down here
 * so neither claim can drift from what the config actually does.
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
