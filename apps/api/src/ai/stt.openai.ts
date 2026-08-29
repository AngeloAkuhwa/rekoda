import OpenAI, { toFile } from 'openai';
import { TranscriptionUnavailable, type SpeechToText, type Transcript } from './stt.js';

/**
 * The transcriber (ADR 0032): OpenAI, the launch architecture's only one.
 *
 * Audio goes to OpenAI's transcription API as a processor, under API terms
 * that exclude training on inputs, solely to come back as text — and that
 * text is tokenised by the privacy gateway before any reasoning model sees
 * it. There is no self-hosted engine and no fallback; /ai-privacy names
 * this processor in the same words.
 *
 * `whisper-1` is the default on purpose: it is the transcription model that
 * REPORTS THE AUDIO DURATION (`verbose_json`), and `voice_seconds` is an
 * allowance a merchant paid for — the meter takes the provider's number,
 * never an estimate from a byte count.
 */
export class OpenAiSpeechToText implements SpeechToText {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    timeoutMs = 60_000,
    baseUrl?: string,
  ) {
    // `maxRetries: 0` for the same reason as every provider client here: the
    // job runner owns retry, with backoff and a dead-letter state.
    this.client = new OpenAI({
      apiKey,
      timeout: timeoutMs,
      maxRetries: 0,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<Transcript> {
    let response: { text?: unknown; duration?: unknown };
    try {
      const file = await toFile(new Uint8Array(audio), fileNameFor(mimeType), {
        type: mimeType,
      });
      response = (await this.client.audio.transcriptions.create({
        file,
        model: this.model,
        response_format: 'verbose_json',
      })) as { text?: unknown; duration?: unknown };
    } catch (error) {
      /* A timeout may have been billed — the audio went out and the work
       * may have finished after we stopped waiting. Flagged so the caller
       * writes a reconciliation row; everything else billed nothing. */
      throw new TranscriptionUnavailable(describe(error), {
        maybeBilled: isTimeout(error),
      });
    }

    const text = typeof response.text === 'string' ? response.text.trim() : '';
    if (!text) throw new TranscriptionUnavailable('transcriber returned no text');

    const duration = Number(response.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      /* No duration means no honest meter reading. Refused rather than
       * guessed: billing a merchant off an estimate is the one thing the
       * voice_seconds contract forbids, and whisper-1 always reports one. */
      throw new TranscriptionUnavailable('transcriber reported no duration');
    }

    return {
      text,
      /* Rounded UP. A 0.4-second "yes" is still a voice note somebody sent,
       * and a meter that rounds those to zero sells an unlimited allowance
       * to anybody who speaks quickly. */
      seconds: Math.max(1, Math.ceil(duration)),
      confidence: null,
      /* Who charged us and on which rate card. The duration the cost is
       * computed from is `seconds` above — the provider's own number. */
      usage: { provider: 'openai', model: this.model },
    };
  }
}

/** The API infers format from the filename; WhatsApp voice notes are ogg. */
function fileNameFor(mimeType: string): string {
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'note.mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'note.m4a';
  if (mimeType.includes('wav')) return 'note.wav';
  if (mimeType.includes('webm')) return 'note.webm';
  return 'note.ogg';
}

/** The reason, never the audio and never a merchant's words. */
function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'transcription timed out';
  if (error instanceof OpenAI.APIError) return `transcriber answered ${error.status}`;
  return error instanceof Error ? error.name : 'unknown transport failure';
}

/** A request that went out and never came back — the maybe-billed case. */
function isTimeout(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionTimeoutError) return true;
  return error instanceof Error && error.name === 'AbortError';
}
