import {
  SendFailed,
  type InboundMedia,
  type MessageSender,
  type OutboundAuthCode,
  type OutboundDocument,
  type OutboundMessage,
  type SendResult,
} from './sender.js';

/**
 * A sender that records instead of sending.
 *
 * Shipped beside the real one because three suites need it, and because the
 * assertions that matter are about the text handed to `send` — specifically
 * that it is rehydrated there and nowhere earlier. A test that could not see
 * the outgoing string could not check that.
 */
export class StubSender implements MessageSender {
  readonly sent: OutboundMessage[] = [];
  /** Documents, kept apart from text so a test can assert on either. */
  readonly documents: OutboundDocument[] = [];
  /** Codes, kept apart again: a test asserting sign-in must not match a reply. */
  readonly authCodes: OutboundAuthCode[] = [];
  private failNext: Error | null = null;
  private failDocuments: Error | null = null;

  /** Make the next TEXT send fail, as an outage or a revoked token would. */
  failWith(error: Error = new SendFailed('stub outage')): void {
    this.failNext = error;
  }

  /**
   * Fail every document send until reset.
   *
   * Separate from `failWith`, and persistent, because a one-shot failure is
   * consumed by whichever send happens first — in practice the text reply that
   * precedes the document, which is not the failure the test meant to arrange.
   */
  failDocumentsWith(error: Error = new SendFailed('stub outage')): void {
    this.failDocuments = error;
  }

  reset(): void {
    this.sent.length = 0;
    this.documents.length = 0;
    this.authCodes.length = 0;
    this.media.clear();
    this.failNext = null;
    this.failDocuments = null;
  }

  /** The text as the merchant would have seen it. */
  get lastText(): string | null {
    return this.sent[this.sent.length - 1]?.text ?? null;
  }

  /** The last document sent, as the merchant would have received it. */
  get lastDocument(): OutboundDocument | null {
    return this.documents[this.documents.length - 1] ?? null;
  }

  send(message: OutboundMessage): Promise<SendResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    this.sent.push(message);
    return Promise.resolve({ providerMessageId: `wamid.STUB${this.sent.length}` });
  }

  /** Media a test arranged for this id to return. */
  readonly media = new Map<string, InboundMedia>();

  fetchMedia(mediaId: string): Promise<InboundMedia> {
    const found = this.media.get(mediaId);
    if (!found) return Promise.reject(new SendFailed(`no stub media for ${mediaId}`));
    return Promise.resolve(found);
  }

  sendAuthCode(code: OutboundAuthCode): Promise<SendResult> {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    this.authCodes.push(code);
    return Promise.resolve({ providerMessageId: `wamid.OTP${this.authCodes.length}` });
  }

  sendDocument(document: OutboundDocument): Promise<SendResult> {
    if (this.failDocuments) return Promise.reject(this.failDocuments);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    this.documents.push(document);
    return Promise.resolve({ providerMessageId: `wamid.DOC${this.documents.length}` });
  }
}
