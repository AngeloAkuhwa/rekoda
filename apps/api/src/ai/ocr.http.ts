import { TextExtractionUnavailable, type ExtractedText, type TextExtraction } from './ocr.js';

/**
 * The self-hosted OCR sidecar, by `fetch`.
 *
 * One POST of one file, so no SDK, and the same shape as the transcription
 * sidecar because it is the same kind of thing: a process we run, on a
 * private network, that exists so a merchant's photograph never has to reach
 * anybody else.
 *
 * The timeout sits between the model's and the transcriber's. A receipt is
 * one page rather than two minutes of audio, but a phone photograph taken in
 * a shop is large and skewed, and a merchant who just sent one is waiting.
 */
export class HttpTextExtraction implements TextExtraction {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 30_000,
  ) {}

  async extract(image: Buffer, mimeType: string): Promise<ExtractedText> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(image)], { type: mimeType }), 'receipt');

      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/extract`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TextExtractionUnavailable(`sidecar answered ${response.status}`);
      }

      const body = (await response.json()) as { text?: unknown; confidence?: unknown };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      /* An empty answer is a failure rather than an empty receipt. A blank
       * string handed onward would be interpreted as a message the merchant
       * never sent. */
      if (!text) throw new TextExtractionUnavailable('sidecar returned no text');

      return {
        text,
        confidence: typeof body.confidence === 'number' ? body.confidence : null,
      };
    } catch (error) {
      if (error instanceof TextExtractionUnavailable) throw error;
      throw new TextExtractionUnavailable(describe(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The reason, never the image and never what it said. */
function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'extraction timed out';
  return error instanceof Error ? error.name : 'unknown transport failure';
}

/**
 * No OCR sidecar configured.
 *
 * Refuses rather than being absent, and refuses with the type the caller
 * already handles: a deployment without OCR answers a photograph honestly.
 *
 * This is the class that makes ADR 0024's no-fallback clause real. The
 * tempting shape here is a second implementation that posts the image to a
 * vision model when `OCR_URL` is unset, and it would work, and it would put a
 * merchant's customers in front of a third party the first day the sidecar
 * was late being deployed. There is no such class and there must not be one.
 */
export class NoTextExtractionConfigured implements TextExtraction {
  extract(): Promise<never> {
    return Promise.reject(new TextExtractionUnavailable('OCR_URL is not set'));
  }
}
