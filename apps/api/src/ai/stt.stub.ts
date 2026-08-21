import { TranscriptionUnavailable, type SpeechToText, type Transcript } from './stt.js';

/**
 * A transcriber that answers from a script.
 *
 * The behaviour worth testing on the voice path belongs to the code AROUND
 * the sidecar — that audio is never stored, that seconds are metered against
 * the allowance, that the transcript goes through the same tokenising and the
 * same gates a typed sentence does. None of that needs a real model, and a
 * real one in CI would be slow, non-deterministic and impossible without a
 * GPU.
 */
export class StubSpeechToText implements SpeechToText {
  /** Every call it received, so a test can assert what was NOT kept. */
  readonly calls: Array<{ bytes: number; mimeType: string }> = [];
  private next: Transcript | null = null;
  private failure: Error | null = null;

  static saying(text: string, seconds = 4): StubSpeechToText {
    const stub = new StubSpeechToText();
    stub.answerWith({ text, seconds, confidence: 0.94 });
    return stub;
  }

  answerWith(transcript: Transcript): void {
    this.next = transcript;
    this.failure = null;
  }

  failWith(error: Error = new TranscriptionUnavailable('stub sidecar down')): void {
    this.failure = error;
  }

  reset(): void {
    this.calls.length = 0;
    this.next = null;
    this.failure = null;
  }

  transcribe(audio: Buffer, mimeType: string): Promise<Transcript> {
    this.calls.push({ bytes: audio.byteLength, mimeType });
    if (this.failure) return Promise.reject(this.failure);
    if (!this.next) return Promise.reject(new TranscriptionUnavailable('stub has no script'));
    return Promise.resolve(this.next);
  }
}
