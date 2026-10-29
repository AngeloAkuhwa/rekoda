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
  /**
   * Display name shown before Rekoda's own verified sender address (N1: `Business via Rekoda`).
   * The address itself never changes, so a message cannot impersonate a merchant's domain.
   */
  fromName?: string;
  /** A monitored address replies go to, when it differs from the sender. */
  replyTo?: string;
  /** A stable key for one logical message, so a provider can drop a retried duplicate. */
  idempotencyKey?: string;
}

/**
 * Thrown when the outcome of a send cannot be told: the request timed out, the connection dropped,
 * or the provider answered with a server error after it may have accepted the message. The mail may
 * have gone, so a caller must not treat it as "never sent" (do not void the link, do not blindly
 * resend with a new key). Retrying with the SAME idempotency key is safe where the provider
 * de-duplicates on it.
 */
export class EmailDeliveryUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailDeliveryUncertainError';
  }
}

/** Thrown when the provider definitely refused the message (a non-retryable 4xx): it was not sent. */
export class EmailRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailRefusedError';
  }
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
  /**
   * The next N sends report an uncertain outcome. With `acceptedBeforeUncertain` the provider DID
   * take the message (a lost response); otherwise it did not.
   */
  uncertainNext = 0;
  acceptedBeforeUncertain = false;
  /** Every send attempt, accepted or not, so a test can count what was tried. */
  attempts = 0;
  private readonly seenKeys = new Set<string>();
  async send(message: OutboundEmail): Promise<void> {
    this.attempts += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('mock email sender failure');
    }
    /* Like Resend: a repeat of a request with the same idempotency key is dropped, not sent again. */
    const duplicate =
      message.idempotencyKey !== undefined && this.seenKeys.has(message.idempotencyKey);
    if (this.uncertainNext > 0) {
      this.uncertainNext -= 1;
      if (this.acceptedBeforeUncertain && !duplicate) {
        if (message.idempotencyKey !== undefined) this.seenKeys.add(message.idempotencyKey);
        this.outbox.push(message);
      }
      throw new EmailDeliveryUncertainError('mock email sender: outcome unknown');
    }
    if (duplicate) return;
    if (message.idempotencyKey !== undefined) this.seenKeys.add(message.idempotencyKey);
    this.outbox.push(message);
  }
}
