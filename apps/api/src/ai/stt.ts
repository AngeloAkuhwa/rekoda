/**
 * Turning a voice note into a sentence (ADR 0032).
 *
 * A port, like the model and the sender, and for a sharper reason than
 * either: the transcriber is the one dependency whose IDENTITY decides what
 * /ai-privacy may claim. The launch architecture has exactly one engine —
 * OpenAI, when voice transcription is enabled — and no self-hosted
 * alternative and no fallback: audio goes to that processor under API terms
 * that exclude training, comes back as text, and that text is tokenised
 * before any reasoning model sees it. The privacy pages say exactly that,
 * and the seam is written down here so the claim cannot drift from what the
 * configuration actually does.
 */
export interface Transcript {
  /** What was said. Raw merchant text: tokenise before it reaches a model. */
  readonly text: string;
  /**
   * How long the audio ran, in whole seconds.
   *
   * Metered, so it is the provider's number rather than ours: `VOICE_MINUTES`
   * is an allowance a merchant paid for, counted in seconds, and estimating
   * it from a byte count would bill them for our compression settings. It is
   * also the figure the reservation is trued up against, so a wrong number
   * here is a wrong bill.
   */
  readonly seconds: number;
  /**
   * The engine's own confidence, 0 to 1, when it reports one.
   *
   * Null rather than a default, because "we do not know" and "we are certain"
   * must not be the same value to whoever reads this next.
   */
  readonly confidence: number | null;
  /**
   * Which HOSTED engine did the transcribing, when a hosted engine did.
   *
   * Absent for stubs, which spend nothing. Present, it is what the caller
   * needs to price the call —
   * the duration is already on `seconds` above, so this only has to say who
   * charged us and on which model's rate card.
   */
  readonly usage?: TranscriptionUsage;
}

export interface TranscriptionUsage {
  readonly provider: 'openai';
  readonly model: string;
}

export interface SpeechToText {
  transcribe(audio: Buffer, mimeType: string): Promise<Transcript>;
}

/** The transcriber could not be reached. Nothing was transcribed, nothing billed. */
export class TranscriptionUnavailable extends Error {
  override readonly name = 'TranscriptionUnavailable';
  /**
   * True when a HOSTED transcriber may have billed us anyway — a timeout
   * after the audio went out. The caller writes a `priced: false`
   * reconciliation row for these so the invoice has something to tie to.
   */
  readonly maybeBilled: boolean;
  /**
   * True when the provider ANSWERED — billed — and the answer was still
   * unusable (no text, no duration). Certain spend, unlike `maybeBilled`;
   * the daily seconds ceiling keeps its reservation for both, because the
   * ceiling bounds spend, not success.
   */
  readonly billed: boolean;

  constructor(message: string, opts?: { maybeBilled?: boolean; billed?: boolean }) {
    super(message);
    this.maybeBilled = opts?.maybeBilled ?? false;
    this.billed = opts?.billed ?? false;
  }
}

export const SPEECH_TO_TEXT = Symbol('SpeechToText');

/**
 * Voice transcription is not enabled in this deployment.
 *
 * Refuses rather than being absent, and refuses with the type the caller
 * already handles as an outage — a deployment without transcription answers
 * a voice note honestly, it does not crash the job that received it, and it
 * sends the audio nowhere.
 */
export class NoSpeechToTextConfigured implements SpeechToText {
  transcribe(): Promise<never> {
    return Promise.reject(new TranscriptionUnavailable('voice transcription is not enabled'));
  }
}
