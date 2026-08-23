import { Logger } from '@nestjs/common';
import { redactForLog } from '@rekoda/core/privacy';
import {
  SendFailed,
  type InboundMedia,
  type MessageSender,
  type OutboundAuthCode,
  type OutboundBillingNotice,
  type OutboundDocument,
  type OutboundRetentionNotice,
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
 * `sendAuthCode` and `sendBillingNotice` are the exceptions, and both exist
 * because there is no window to reply inside: the phone asking for a code has
 * by definition not messaged the business number, and a merchant whose card
 * failed may not have messaged it in days. Both are template messages.
 */
/** The most media one download may buffer: WhatsApp's own media cap, rounded. */
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

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
    /** Meta-approved UTILITY template for grace reminders. Null means silence. */
    private readonly billingTemplate: string | null = null,
    private readonly billingTemplateLocale = 'en',
    /** Meta-approved UTILITY template for retention warnings. */
    private readonly retentionTemplate: string | null = null,
    private readonly retentionTemplateLocale = 'en',
    /**
     * Graph's host. Injectable for the same reason the Paystack adapter's is:
     * the claims worth having about an adapter are about what goes over the
     * wire, and asserting those needs a server that can be listened to.
     */
    private readonly baseUrl = 'https://graph.facebook.com',
  ) {}

  /**
   * A retention warning, as a utility template.
   *
   * Refuses loudly when none is configured, like every other template send
   * here. The sweep catches that and does NOT proceed to delete: a schedule
   * that promises notice cannot delete somebody it failed to notify.
   */
  async sendRetentionNotice(notice: OutboundRetentionNotice): Promise<SendResult> {
    if (!this.retentionTemplate) {
      throw new SendFailed('no retention template configured (META_RETENTION_TEMPLATE)');
    }
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: notice.to,
      type: 'template',
      template: {
        name: this.retentionTemplate,
        language: { code: this.retentionTemplateLocale },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: notice.daysLeft },
              { type: 'text', text: notice.deletesOn },
            ],
          },
        ],
      },
    });
  }

  /**
   * A grace-period reminder, as a utility template.
   *
   * Refuses loudly when none is configured, exactly as `sendAuthCode` does.
   * The sweep catches that and records the reminder anyway, so the dashboard
   * still tells the merchant where they stand while the template is pending
   * approval. What must not happen is a free-form text that Meta rejects and
   * a sweep that reports it sent something.
   */
  async sendBillingNotice(notice: OutboundBillingNotice): Promise<SendResult> {
    if (!this.billingTemplate) {
      throw new SendFailed('no billing template configured (META_BILLING_TEMPLATE)');
    }
    return this.post({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: notice.to,
      type: 'template',
      template: {
        name: this.billingTemplate,
        language: { code: this.billingTemplateLocale },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: notice.daysLeft },
              { type: 'text', text: notice.endsOn },
            ],
          },
        ],
      },
    });
  }

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

  /**
   * Media, in two steps, because that is what Meta requires in this direction
   * too: `/{media-id}` returns a short-lived URL, and the bytes come from
   * there. The second request carries the access token as well, because the
   * URL is on a different host and is not itself a credential.
   */
  async fetchMedia(mediaId: string): Promise<InboundMedia> {
    const meta = (await this.request(`/${mediaId}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.accessToken}` },
    })) as { url?: string; mime_type?: string };

    if (!meta.url) throw new SendFailed('meta media lookup returned no url');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(meta.url, {
        headers: { authorization: `Bearer ${this.accessToken}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new SendFailed(`meta media download answered ${response.status}`);
      /**
       * Bounded by COUNTING as it streams, not by trusting Content-Length.
       * The header check alone let a chunked or lying response buffer its
       * whole body into worker memory before the size was known; reading the
       * stream chunk by chunk and aborting the moment the running total
       * crosses the cap makes the ceiling real for any response shape. The
       * cheap header check stays as an early-out for an honest large file.
       */
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_MEDIA_BYTES) throw new SendFailed('meta media larger than accepted');
      const body = response.body;
      if (!body) throw new SendFailed('meta media download had no body');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > MAX_MEDIA_BYTES) {
          controller.abort();
          throw new SendFailed('meta media larger than accepted');
        }
        chunks.push(Buffer.from(chunk));
      }
      return {
        bytes: Buffer.concat(chunks),
        mimeType: meta.mime_type ?? response.headers.get('content-type') ?? 'audio/ogg',
      };
    } catch (error) {
      if (error instanceof SendFailed) throw error;
      throw new SendFailed(redactForLog(String((error as Error)?.name ?? 'download failed')));
    } finally {
      clearTimeout(timer);
    }
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
      const response = await fetch(`${this.baseUrl}/${this.graphVersion}${path}`, {
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

  fetchMedia(): Promise<never> {
    return Promise.reject(new SendFailed('META_ACCESS_TOKEN is not set'));
  }

  sendDocument(): Promise<never> {
    return Promise.reject(new SendFailed('META_ACCESS_TOKEN is not set'));
  }

  sendBillingNotice(): Promise<never> {
    return Promise.reject(new SendFailed('META_ACCESS_TOKEN is not set'));
  }

  sendRetentionNotice(): Promise<never> {
    return Promise.reject(new SendFailed('META_ACCESS_TOKEN is not set'));
  }
}
