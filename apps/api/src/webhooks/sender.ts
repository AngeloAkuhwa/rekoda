/**
 * The one place Rekoda makes an outbound request to an address a MERCHANT
 * chose (PR-112).
 *
 * That sentence is why this is a port with a narrow implementation rather
 * than a `fetch` inside the sweep. Everything a merchant supplies is
 * attacker-controlled from the platform's point of view — not because
 * merchants are attackers, but because one compromised account should not
 * become a request-forgery machine pointed at the estate's own network.
 *
 * The rules the implementation keeps, and why each exists:
 *
 *   HTTPS only. Enforced by the column's CHECK, the contract's refinement
 *   and again here, because a plaintext callback puts a merchant's books on
 *   the wire in clear.
 *
 *   No redirects. `redirect: 'manual'` — a 302 to `http://169.254.169.254`
 *   is the classic way a validated https URL becomes a request to a cloud
 *   metadata service. A redirect is reported as the failure it is.
 *
 *   A hard timeout, so a merchant's hung endpoint holds a worker for ten
 *   seconds rather than forever.
 *
 *   The response body is never read. Nothing about it is useful and reading
 *   it lets an endpoint stream megabytes into the sender.
 */
export interface WebhookSendResult {
  status: number;
}

export class WebhookSendFailed extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface WebhookSender {
  send(input: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<WebhookSendResult>;
}

export const WEBHOOK_SENDER = Symbol('WEBHOOK_SENDER');

export class HttpWebhookSender implements WebhookSender {
  constructor(private readonly timeoutMs = 10_000) {}

  async send(input: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<WebhookSendResult> {
    if (!input.url.startsWith('https://')) {
      throw new WebhookSendFailed('endpoint is not https', null);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(input.url, {
        method: 'POST',
        body: input.body,
        headers: { ...input.headers, 'content-type': 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });

      /* A 3xx is not a success and not a retry-worthy transport error: it is
       * an endpoint asking to be followed somewhere this sender will not
       * go. Reported with its status so the merchant sees why. */
      if (response.status >= 300 && response.status < 400) {
        throw new WebhookSendFailed(
          'endpoint answered a redirect, which is not followed',
          response.status,
        );
      }
      if (!response.ok) {
        throw new WebhookSendFailed(`endpoint answered ${response.status}`, response.status);
      }
      return { status: response.status };
    } catch (error) {
      if (error instanceof WebhookSendFailed) throw error;
      throw new WebhookSendFailed(describe(error), null);
    } finally {
      clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'endpoint did not answer in time' : error.message;
  }
  return 'the request failed';
}
