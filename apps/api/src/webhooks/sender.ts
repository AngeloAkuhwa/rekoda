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
 *   No redirects. `node:https` does not follow them, and a 302 to
 *   `http://169.254.169.254` is the classic way a validated https URL
 *   becomes a request to a cloud metadata service. A redirect is reported
 *   as the failure it is.
 *
 *   A hard timeout, so a merchant's hung endpoint holds a worker for ten
 *   seconds rather than forever. Measured over the whole attempt, DNS and
 *   TLS included, not as socket idleness.
 *
 *   The response body is never read. Nothing about it is useful and reading
 *   it lets an endpoint stream megabytes into the sender.
 *
 *   THE ADDRESS IS CHECKED AT CONNECT TIME (PR-134). `destination.ts`
 *   supplies the `lookup` this request resolves through, so the socket can
 *   only be handed a publicly-routable address. That is also why this uses
 *   `node:https` rather than `fetch`: the global fetch has nowhere to put a
 *   `lookup`, so its destination cannot be constrained without swapping the
 *   whole dispatcher for one, and a check that runs anywhere other than
 *   inside the connection is a check DNS can move out from under.
 */
import { request as httpsRequest } from 'node:https';
import { NOT_PUBLIC, publicOnlyLookup, refusalForUrl } from './destination.js';

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
    /* The syntactic refusals again at send time, not only at registration:
     * rows predating this guard exist, and an endpoint is read fresh from
     * the table on every attempt. */
    const refusal = refusalForUrl(input.url);
    if (refusal) throw new WebhookSendFailed(refusal, null);

    return new Promise<WebhookSendResult>((resolve, reject) => {
      const body = Buffer.from(input.body, 'utf8');
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
      };

      const request = httpsRequest(
        input.url,
        {
          method: 'POST',
          headers: {
            ...input.headers,
            'content-type': 'application/json',
            'content-length': body.byteLength,
          },
          /* The whole point of this file's rewrite: the socket may only be
           * handed a publicly-routable address (destination.ts). */
          lookup: publicOnlyLookup,
        },
        (response) => {
          /* Read nothing, and let the socket go. `resume()` drains without
           * buffering, so a chatty endpoint cannot stream megabytes here. */
          response.resume();
          const status = response.statusCode ?? 0;

          /* A 3xx is not a success and not a retry-worthy transport error:
           * it is an endpoint asking to be followed somewhere this sender
           * will not go. `node:https` never follows one on its own.
           * Reported with its status so the merchant sees why. */
          if (status >= 300 && status < 400) {
            finish(() =>
              reject(
                new WebhookSendFailed(
                  'endpoint answered a redirect, which is not followed',
                  status,
                ),
              ),
            );
            return;
          }
          if (status < 200 || status >= 300) {
            finish(() => reject(new WebhookSendFailed(`endpoint answered ${status}`, status)));
            return;
          }
          finish(() => resolve({ status }));
        },
      );

      /* One hard deadline over the whole attempt - resolution, TLS and the
       * answer - rather than `https`'s idle-socket timeout, which a slow
       * trickle resets forever. */
      const timer = setTimeout(() => {
        finish(() => {
          request.destroy();
          reject(new WebhookSendFailed('endpoint did not answer in time', null));
        });
      }, this.timeoutMs);

      request.on('error', (error) => {
        finish(() => reject(new WebhookSendFailed(describe(error), null)));
      });
      request.end(body);
    });
  }
}

/**
 * What a failure is allowed to say.
 *
 * Deliberately NOT `error.cause`, and deliberately not the OS message for
 * a connection error. Node reports a refused connection and a failed
 * resolution with text that names the address and port it tried, and
 * handing that back to the merchant who chose the address turns a delivery
 * log into a network scanner's console. The merchant gets the fact; the
 * operator has the logs.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return 'the request failed';
  if (error.name === 'WebhookDestinationRefused') return NOT_PUBLIC;
  const code = (error as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'the endpoint name did not resolve';
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'ETIMEDOUT':
      return 'the endpoint did not accept the connection';
    default:
      break;
  }
  /* TLS failures are worth naming, because they are the merchant's to fix
   * and say nothing about our network. */
  if (
    code?.startsWith('ERR_TLS') ||
    code?.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  ) {
    return 'the endpoint has a certificate this sender will not accept';
  }
  return 'the request failed';
}
