import { TranscriptionUnavailable, type SpeechToText, type Transcript } from './stt.js';

/**
 * The self-hosted AfriSpeech sidecar, by `fetch`.
 *
 * One POST of one file, so no SDK. The audio goes over a private network to a
 * process we run, which is the whole point: it is the only way "audio never
 * leaves Rekoda" can be said out loud.
 *
 * The timeout is generous compared to the model's, because a two-minute voice
 * note genuinely takes longer to transcribe than a sentence takes to read, and
 * a merchant who recorded one is waiting for a reply rather than typing the
 * next thing.
 */
export class HttpSpeechToText implements SpeechToText {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 60_000,
  ) {}

  async transcribe(audio: Buffer, mimeType: string): Promise<Transcript> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), 'note.ogg');

      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/transcribe`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TranscriptionUnavailable(`sidecar answered ${response.status}`);
      }

      const body = (await response.json()) as {
        text?: unknown;
        seconds?: unknown;
        confidence?: unknown;
      };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) throw new TranscriptionUnavailable('sidecar returned no text');

      return {
        text,
        /* Rounded UP. A 0.4-second "yes" is still a voice note somebody sent,
         * and a meter that rounds those to zero sells an unlimited allowance
         * to anybody who speaks quickly. */
        seconds: Math.max(1, Math.ceil(Number(body.seconds) || 0)),
        confidence: typeof body.confidence === 'number' ? body.confidence : null,
      };
    } catch (error) {
      if (error instanceof TranscriptionUnavailable) throw error;
      throw new TranscriptionUnavailable(describe(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The reason, never the audio and never a merchant's words. */
function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'transcription timed out';
  return error instanceof Error ? error.name : 'unknown transport failure';
}

/**
 * No sidecar configured.
 *
 * Refuses rather than being absent, and refuses with the type the caller
 * already handles as an outage — a deployment without STT should answer a
 * voice note honestly, not crash the job that received it.
 */
export class NoSpeechToTextConfigured implements SpeechToText {
  transcribe(): Promise<never> {
    return Promise.reject(new TranscriptionUnavailable('STT_URL is not set'));
  }
}
