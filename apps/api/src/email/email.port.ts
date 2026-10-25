/**
 * Transactional email (G-102 slice 2b, OWN-51).
 *
 * A port, like PAYMENT_PROVIDER: callers send through it and never know which
 * sender is bound: the honest "none", the in-memory mock, or Resend
 * (`resend.sender.ts`).
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  /** A stable key for one logical message, so a provider can drop a retried duplicate. */
  idempotencyKey?: string;
}

export interface EmailSender {
  /** False when nothing can be sent, so a caller can say so instead of pretending. */
  readonly available: boolean;
  /** Resolves when the message was handed over; throws when it was not. */
  send(message: OutboundEmail): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EmailSender');

/** No sender configured: refuses honestly rather than dropping mail on the floor. */
export class NoEmailSender implements EmailSender {
  readonly available = false;
  async send(): Promise<void> {
    throw new Error('no email sender is configured');
  }
}

/** Development and tests: keeps what was "sent" so a test can read the link. */
export class MockEmailSender implements EmailSender {
  readonly available = true;
  readonly outbox: OutboundEmail[] = [];
  /** Set to make the next send fail, as an unreachable provider would. */
  failNext = false;
  async send(message: OutboundEmail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mock email sender failure');
    }
    this.outbox.push(message);
  }
}
