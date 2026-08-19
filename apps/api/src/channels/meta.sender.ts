import { Logger } from '@nestjs/common';
import { redactForLog } from '@rekoda/core/privacy';
import { SendFailed, type MessageSender, type OutboundMessage, type SendResult } from './sender.js';

/**
 * WhatsApp Cloud API, by `fetch`.
 *
 * No SDK for one POST. The request is four fields and the response is one id;
 * a dependency here would buy retry logic the job runner already owns and a
 * surface area we would have to keep pinned.
 *
 * Every message this sends is a **service reply inside the 24-hour window** —
 * it is always an answer to something the merchant just said. That is the
 * cheap path (currently ₦0 Meta-side, chargeable from 1 Oct 2026 — see
 * pricing-model.md) and it needs no template approval. Anything outside that
 * window is a template message and a different code path, deliberately not
 * this one.
 */
export class MetaSender implements MessageSender {
  private readonly log = new Logger(MetaSender.name);

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly graphVersion = 'v21.0',
    private readonly timeoutMs = 10_000,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.graphVersion}/${this.phoneNumberId}/messages`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.to,
          type: 'text',
          // Link previews off: a merchant's message can contain a URL, and an
          // unfurled preview is a second network fetch of an untrusted address.
          text: { preview_url: false, body: message.text },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        /**
         * The body is NOT logged. Meta echoes the request on some errors, and
         * the request body is a rehydrated message — the one string in the
         * system carrying a real customer name. Status and code are enough to
         * act on.
         */
        throw new SendFailed(`meta send failed with ${response.status}`);
      }

      const body = (await response.json()) as { messages?: Array<{ id?: string }> };
      return { providerMessageId: body.messages?.[0]?.id ?? null };
    } catch (error) {
      if (error instanceof SendFailed) throw error;
      const reason = error instanceof Error ? error.name : 'unknown';
      this.log.warn(`meta send failed: ${redactForLog(reason)}`);
      throw new SendFailed(`meta send failed: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * No credentials, so no sending.
 *
 * Fails the same way a provider outage does, which is what it is from the
 * merchant's side. The alternative — refusing to boot — would stop a developer
 * running the stack to look at a page, and every inbound message is still
 * recorded whether or not a reply leaves.
 */
export class NoSenderConfigured implements MessageSender {
  send(): Promise<never> {
    return Promise.reject(new SendFailed('META_ACCESS_TOKEN is not set'));
  }
}
