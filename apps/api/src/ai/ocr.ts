/**
 * Reading a photograph of a receipt (ADR 0024, decision C9).
 *
 * A port, for the sharpest reason any port here has: this seam IS the privacy
 * boundary. The pipeline Angelo chose is
 *
 *     receipt photo -> self-hosted OCR -> PII tokenisation -> model
 *
 * and the reason is mechanical rather than aesthetic. The privacy gateway
 * tokenises TEXT and cannot tokenise an image, so a photograph sent to a model
 * provider would put a customer's name, phone and address in front of a third
 * party intact. Running OCR first, inside infrastructure we control, produces
 * exactly the input type the gateway already knows how to protect.
 *
 * THERE IS NO RAW-IMAGE FALLBACK. Not when OCR is slow, not when it is down,
 * not when a photograph is hard to read. ADR 0024 says it plainly: a privacy
 * boundary that acquires an exception the first time it is inconvenient was
 * never a boundary. If visual layout ever matters, the route is OCR bounding
 * boxes, redact the regions holding personal data, then send the redacted
 * image - never the original.
 *
 * That is why the failure type below exists and why the handler answers with
 * it. "We could not read it" is a sentence a merchant can act on. Sending
 * their customer's address to an American model provider because our sidecar
 * was busy is not.
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
}

export const TEXT_EXTRACTION = Symbol('TextExtraction');
