import { Logger } from '@nestjs/common';
import type { ResendConfig } from '../config.js';
import { EmailSendError, type EmailSender, type OutboundEmail } from './email.port.js';

/**
 * Resend, by `fetch` (OWN-49). The sender and reply-to come from configuration.
 *
 * Neither the recipient nor the body is ever logged or put in an error:
 * Resend echoes them on some failures, and a confirmation mail carries a link
 * that proves a mailbox. The status class is enough to act on.
 */
export class ResendEmailSender implements EmailSender {
  readonly available = true;
  private readonly log = new Logger(ResendEmailSender.name);

  constructor(
    private readonly config: ResendConfig,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(message: OutboundEmail): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.config.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
          ...(message.idempotencyKey ? { 'idempotency-key': message.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(this.config.replyTo ? { reply_to: this.config.replyTo } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new EmailSendError(classify(response.status), response.status);
    } catch (error) {
      if (error instanceof EmailSendError) {
        this.log.warn(`resend send refused: ${error.failure}`);
        throw error;
      }
      this.log.warn(`resend request failed: ${error instanceof Error ? error.name : 'unknown'}`);
      throw new EmailSendError('unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
}

function classify(status: number): EmailSendError['failure'] {
  if (status === 401 || status === 403) return 'unauthorised';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  return 'rejected';
}
