/**
 * Reading a photograph of a receipt (ADR 0024 pipeline, ADR 0032 engine).
 *
 * A port, for the sharpest reason any port here has: this seam IS the
 * boundary between raw pixels and text the gateway can protect. The
 * pipeline is
 *
 *     document photo -> extraction (Claude vision) -> PII tokenisation -> reasoning model
 *
 * and the mechanics matter: the privacy gateway tokenises TEXT and cannot
 * tokenise an image, so the extraction step necessarily works on the raw
 * page — the launch architecture sends it to Anthropic as a
 * transcription-only processor, /ai-privacy says so in plain words, and
 * the REASONING model still only ever sees the tokenised transcript.
 *
 * THERE IS NO FALLBACK ENGINE. Not when the reader is slow, not when it
 * is down, not when a photograph is hard to read: a request that cannot
 * reach the ONE configured engine is refused, never rerouted somewhere
 * the privacy page does not name — a boundary that acquires an exception
 * the first time it is inconvenient was never a boundary. "We could not
 * read it" is a sentence a merchant can act on.
 */
export interface ExtractedText {
  /**
   * What the page said. RAW merchant text: it goes through the gateway before
   * any model sees it, exactly as a voice transcript does.
   */
  readonly text: string;
  /**
   * The engine's own confidence, 0 to 1, when it reports one.
   *
   * Null rather than a default, because "we do not know" and "we are certain"
   * must not be the same value to whoever reads this next. A low number is
   * worth telling the merchant about: a misread amount is worse than no
   * amount.
   */
  readonly confidence: number | null;
  /**
   * What the HOSTED engine consumed, when a hosted engine did the reading.
   *
   * Absent for stubs, which spend nothing. Present, it is what the
   * caller needs
   * to write the `usage_events` row that puts hosted OCR inside the margin
   * view instead of outside it.
   */
  readonly usage?: ExtractionUsage;
}

export interface ExtractionUsage {
  /** Who charged us for the read. Widens as verifier providers arrive. */
  readonly provider: 'anthropic' | 'openai';
  readonly model: string;
  readonly tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
  };
}

export interface TextExtraction {
  extract(image: Buffer, mimeType: string): Promise<ExtractedText>;
}

/**
 * The engine could not be reached, or could not read the page.
 *
 * One type for both, because the merchant-facing answer is the same and
 * because the alternative - a caller that distinguishes them - is a caller
 * one refactor away from treating "could not read" as permission to send the
 * image somewhere that can.
 */
export class TextExtractionUnavailable extends Error {
  override readonly name = 'TextExtractionUnavailable';
  /**
   * True when a HOSTED engine may have billed us anyway — a timeout after
   * the request went out, where "the call failed" and "the call was free"
   * are different claims. The caller writes a `priced: false` reconciliation
   * row for these, so the invoice has something to tie to. It changes
   * nothing about the merchant-facing answer and enables no fallback.
   */
  readonly maybeBilled: boolean;
  /**
   * Set when a HOSTED engine answered, billed us, and the answer was still
   * unusable — a page with no legible text. The provider money was spent,
   * so the caller records it and keeps the daily slot counted, exactly as
   * it would for a successful read. Distinct from `maybeBilled`: this one
   * is certain, and it comes with the token counts to price.
   */
  readonly usage?: ExtractionUsage;

  constructor(message: string, opts?: { maybeBilled?: boolean; usage?: ExtractionUsage }) {
    super(message);
    this.maybeBilled = opts?.maybeBilled ?? false;
    if (opts?.usage) this.usage = opts.usage;
  }
}

export const TEXT_EXTRACTION = Symbol('TextExtraction');

/**
 * Document reading is not enabled in this deployment.
 *
 * Refuses with the type the caller already handles: a photograph is
 * answered honestly and its bytes go nowhere. This class is also what
 * keeps the no-fallback rule real — there is no branch anywhere that
 * sends the image somewhere else when reading is off or failing.
 */
export class NoTextExtractionConfigured implements TextExtraction {
  extract(): Promise<never> {
    return Promise.reject(new TextExtractionUnavailable('image AI is not enabled'));
  }
}
