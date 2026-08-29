import { TextExtractionUnavailable, type ExtractedText, type TextExtraction } from './ocr.js';

/**
 * An OCR engine that answers from a script.
 *
 * The behaviour worth testing on the receipt path belongs to the code AROUND
 * the reader: that the image is never stored, that the text goes through the
 * gateway before any model sees it, and above all that a failure produces an
 * honest reply rather than a second route for the photograph. None of that
 * needs a real engine.
 */
export class StubTextExtraction implements TextExtraction {
  /** Every call it received, so a test can assert what was NOT kept. */
  readonly calls: Array<{ bytes: number; mimeType: string }> = [];
  private next: ExtractedText | null = null;
  private failure: Error | null = null;

  static reading(text: string, confidence = 0.91): StubTextExtraction {
    const stub = new StubTextExtraction();
    stub.answerWith({ text, confidence });
    return stub;
  }

  answerWith(extracted: ExtractedText): void {
    this.next = extracted;
    this.failure = null;
  }

  failWith(error: Error = new TextExtractionUnavailable('stub reader down')): void {
    this.failure = error;
  }

  reset(): void {
    this.calls.length = 0;
    this.next = null;
    this.failure = null;
  }

  extract(image: Buffer, mimeType: string): Promise<ExtractedText> {
    this.calls.push({ bytes: image.byteLength, mimeType });
    if (this.failure) return Promise.reject(this.failure);
    if (!this.next) return Promise.reject(new TextExtractionUnavailable('stub has no script'));
    return Promise.resolve(this.next);
  }
}
