import { Logger } from '@nestjs/common';
import { redactForLog } from '@rekoda/core/privacy';
import {
  SendFailed,
  type MessageSender,
  type OutboundAuthCode,
  type OutboundDocument,
  type OutboundMessage,
  type SendResult,
} from './sender.js';

/**
 * WhatsApp Cloud API, by `fetch`.
 *
 * No SDK for one POST. The request is four fields and the response is one id;
 * a dependency here would buy retry logic the job runner already owns and a
 * surface area we would have to keep pinned.
 *
 * Almost every message this sends is a **service reply inside the 24-hour
 * window** — an answer to something the merchant just said. That is the cheap
 * path (currently ₦0 Meta-side, chargeable from 1 Oct 2026 — see
 * pricing-model.md) and it needs no template approval.
 *
 * `sendAuthCode` is the one exception, and it exists because sign-in has no
 * choice: the phone asking for a code has by definition not messaged the
 * business number, so there is no window to reply inside. It is a template
 * message, priced as authentication, and it is the only one here.
 */
export class MetaSender implements MessageSender {
  private readonly log = new Logger(MetaSender.name);

  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly graphVersion = 'v21.0',
    private readonly timeoutMs = 10_000,
    /** Meta-approved authentication template. Null means sign-in cannot send. */
    private readonly otpTemplate: string | null = null,
    private readonly otpTemplateLocale = 'en',
  ) {}

  /**
   * The sign-in code, as an authentication template.
   *
   * The code appears twice on purpose. Meta's copy-code authentication
   * template puts it in the body text AND in the button that copies it, and
   * the API wants a parameter for each; sending only one is rejected as a
   * parameter-count mismatch rather than silently rendering half a message.
   *
   * Refuses loudly when no template is configured. The alternative was a
   * free-form text that Meta rejects with 131047, swallowed by the caller,
   * which is how a sign-in flow passes every test and reaches nobody.
   */
  async sendAuthCode(code: OutboundAuthCode): Promise<SendResult> {
    if (!this.otpTemplate) {
      throw new SendFailed('no authentication template configured (META_OTP_TEMPLATE)');
    }
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: code.to,
      type: 'template',
      template: {
        name: this.otpTemplate,
        language: { code: this.otpTemplateLocale },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code.code }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: code.code }],
          },
        ],
      },
    });
  }

  /**
   * A document, in two steps, because that is what Meta requires.
   *
   * Upload the bytes to `/media`, which returns an id; then send a message
   * referencing that id. The alternative — a `link` to the file — would need
   * the PDF to be publicly reachable, and a merchant's invoice on a public URL
   * is exactly what the unguessable storage key exists to avoid. Uploading
   * means the bytes go to Meta and nowhere else.
   */
  async sendDocument(document: OutboundDocument): Promise<SendResult> {
    const mediaId = await this.uploadMedia(document);
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: document.to,
      type: 'document',
      document: {
        id: mediaId,
        filename: document.filename,
        ...(document.caption === undefined ? {} : { caption: document.caption }),
      },
    });
  }

  private async uploadMedia(document: OutboundDocument): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', document.contentType);
    form.append(
      'file',
      new Blob([new Uint8Array(document.bytes)], { type: document.contentType }),
      document.filename,
    );

    const body = await this.request(`/${this.phoneNumberId}/media`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.accessToken}` },
      body: form,
    });

    const id = (body as { id?: string }).id;
    if (!id) throw new SendFailed('meta media upload returned no id');
    return id;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'text',
      // Link previews off: a merchant's message can contain a URL, and an
      // unfurled preview is a second network fetch of an untrusted address.
      text: { preview_url: false, body: message.text },
    });
  }

  private async post(payload: Record<string, unknown>): Promise<SendResult> {
    const body = await this.request(`/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const messages = (body as { messages?: Array<{ id?: string }> }).messages;
    return { providerMessageId: messages?.[0]?.id ?? null };
  }

  /**
   * One place that talks to Graph, so the timeout and the error discipline are
   * not re-decided per call site.
   */
  private async request(path: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`https://graph.facebook.com/${this.graphVersion}${path}`, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        /**
         * The response body is NOT logged. Meta echoes the request on some
         * errors, and our request body is a rehydrated message — the one
         * string in the system carrying a real customer name. Status is enough
         * to act on.
         */
        throw new SendFailed(`meta ${path} failed with ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof SendFailed) throw error;
      const reason = error instanceof Error ? error.name : 'unknown';
      this.log.warn(`meta request failed: ${redactForLog(reason)}`);
      throw new SendFailed(`meta request failed: ${reason}`);
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

  sendAuthCode(): Promise<never> {
    return Promise.reject(new SendFailed('META_ACCESS_TOKEN is not set'));
  }

  sendDocument(): Promise<never> {
    return Promise.reject(new SendFailed('META_ACCESS_TOKEN is not set'));
  }
}
