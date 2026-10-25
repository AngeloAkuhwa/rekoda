import { Logger } from '@nestjs/common';
import type { EmailSender, OutboundEmail } from './email.port.js';

/** Resend's one send endpoint. Fixed: no variable can point production at another host. */
export const RESEND_SEND_URL = 'https://api.resend.com/emails';

export interface ResendSenderOptions {
  apiKey: string;
  /** The verified sending address, as `billing@domain` or `Name <billing@domain>`. */
  from: string;
  /** Per-request budget; a slow provider fails the send rather than holding a request open. */
  timeoutMs?: number;
  /** Injected by tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Transactional email through Resend (OWN-49, OWN-51).
 *
 * Failure discipline matches the WhatsApp sender: the response body is never
 * read into a log or an error, because a provider can echo the recipient, and
 * the recipient is a merchant's billing address. The status is enough to act
 * on. The API key never leaves the Authorization header.
 */
export class ResendEmailSender implements EmailSender {
  readonly available = true;
  private readonly log = new Logger('ResendEmailSender');
  private readonly apiKey: string;
  private readonly from: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendSenderOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: OutboundEmail): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      };
      // Resend de-duplicates a retried request that carries the same key.
      if (message.idempotencyKey) headers['idempotency-key'] = message.idempotencyKey;

      const response = await this.fetchImpl(RESEND_SEND_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`resend send failed with ${response.status}`);
    } catch (error) {
      const reason =
        error instanceof Error && error.message.startsWith('resend send failed')
          ? error.message
          : `resend request failed: ${error instanceof Error ? error.name : 'unknown'}`;
      this.log.warn(reason);
      throw new Error(reason);
    } finally {
      clearTimeout(timer);
    }
  }
}
