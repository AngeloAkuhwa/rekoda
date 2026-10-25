import { Logger } from '@nestjs/common';
import { emailSuppressionKey } from '@rekoda/core';
import { emailSuppressionsRepo, type Db } from '@rekoda/db';
import type { EmailSender, OutboundEmail } from './email.port.js';

/** Thrown, without sending, when the recipient bounced for good or marked Rekoda mail as spam. */
export class EmailSuppressedError extends Error {
  constructor() {
    super('the recipient address is suppressed');
    this.name = 'EmailSuppressedError';
  }
}

/**
 * Refuses to mail an address that bounced permanently or complained (N7, OWN-49): sending to it
 * again damages the shared sending reputation. The check is by address hash, so nothing here
 * learns or logs the address. It decorates the real sender and changes nothing else.
 */
export class SuppressingEmailSender implements EmailSender {
  private readonly log = new Logger(SuppressingEmailSender.name);

  constructor(
    private readonly inner: EmailSender,
    private readonly db: Db,
  ) {}

  get available(): boolean {
    return this.inner.available;
  }

  async send(message: OutboundEmail): Promise<void> {
    if (await emailSuppressionsRepo.isSuppressed(this.db, emailSuppressionKey(message.to))) {
      this.log.warn('an email was not sent: the recipient address is suppressed');
      throw new EmailSuppressedError();
    }
    await this.inner.send(message);
  }
}
