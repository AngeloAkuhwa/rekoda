import { SendFailed, type MessageSender, type OutboundMessage, type SendResult } from './sender.js';

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
  private failNext: Error | null = null;

  /** Make the next send fail, as an outage or a revoked token would. */
  failWith(error: Error = new SendFailed('stub outage')): void {
    this.failNext = error;
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = null;
  }

  /** The text as the merchant would have seen it. */
  get lastText(): string | null {
    return this.sent[this.sent.length - 1]?.text ?? null;
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
}
