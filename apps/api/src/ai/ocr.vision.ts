import Anthropic from '@anthropic-ai/sdk';
import { TextExtractionUnavailable, type ExtractedText, type TextExtraction } from './ocr.js';

/**
 * Hosted extraction: the vision model as the text reader (ADR 0027).
 *
 * The launch configuration. The pipeline ADR 0024 fixed is unchanged —
 * photo → TEXT extraction → PII gateway → reasoning model — what changed is
 * which engine performs the extraction step: the receipt image goes to
 * Anthropic as a processor, under API terms that exclude training on
 * inputs, with ONE job — transcribe what the paper says, verbatim. The
 * transcript then walks the same gateway every typed sentence walks before
 * any model is asked to reason about it. This is the launch
 * architecture's only reader (ADR 0032): no self-hosted engine, no
 * fallback, and /ai-privacy names this processor.
 */
const TRANSCRIBE_SYSTEM =
  'You transcribe documents. Output every piece of text visible in the image, ' +
  'verbatim, preserving line breaks. Do not interpret, summarise, translate or ' +
  'add anything that is not printed on the page. If the image contains no ' +
  'legible text, output nothing at all.';

/** The image types the vision API accepts; anything else is refused here. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** A receipt is a page of short lines; this is headroom, not a target. */
const MAX_TRANSCRIPT_TOKENS = 2_048;

export class VisionTextExtraction implements TextExtraction {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
    timeoutMs = 30_000,
    baseUrl?: string,
  ) {
    this.client = new Anthropic({
      apiKey,
      timeout: timeoutMs,
      maxRetries: 0,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  async extract(image: Buffer, mimeType: string): Promise<ExtractedText> {
    if (!IMAGE_TYPES.has(mimeType)) {
      throw new TextExtractionUnavailable(`cannot read ${mimeType}`);
    }

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_TRANSCRIPT_TOKENS,
        system: TRANSCRIBE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: image.toString('base64'),
                },
              },
              { type: 'text', text: 'Transcribe this document.' },
            ],
          },
        ],
      });
    } catch (error) {
      /* A timeout is the one failure where "it failed" and "it was free"
       * can differ: the image may have been processed after we stopped
       * waiting. Flagged so the caller writes a reconciliation row; a
       * refused connection or a 4xx billed nothing and stays unflagged. */
      throw new TextExtractionUnavailable(describe(error), {
        maybeBilled: isTimeout(error),
      });
    }

    /* The bill for the read, handed to whoever will write the cost row.
     * The response model id, not the configured one: it is the id the
     * invoice will carry. */
    const usage = {
      provider: 'anthropic' as const,
      model: response.model,
      tokens: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        ...(response.usage.cache_creation_input_tokens
          ? { cacheWriteTokens: response.usage.cache_creation_input_tokens }
          : {}),
        ...(response.usage.cache_read_input_tokens
          ? { cacheReadTokens: response.usage.cache_read_input_tokens }
          : {}),
      },
    };

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!text) {
      /* An unreadable page still billed tokens — the failure carries the
       * bill, so the caller can record what was spent reading nothing. */
      throw new TextExtractionUnavailable('the page had no legible text', { usage });
    }

    /* Null, honestly: a language model does not report a per-character
     * confidence the way an OCR engine does, and inventing one would give
     * the caller a number that means nothing. */
    return { text, confidence: null, usage };
  }
}

/** The reason, never the image and never what was printed on it. */
function describe(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `vision engine answered ${error.status}`;
  return error instanceof Error ? error.name : 'unknown transport failure';
}

/** A request that went out and never came back — the maybe-billed case. */
function isTimeout(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return true;
  return error instanceof Error && error.name === 'AbortError';
}
