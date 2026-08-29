import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { DB, WORKER_DB } from './db/db.module.js';
import { bootChecks, type Db } from '@rekoda/db';
import { MAX_IMAGE_BYTES } from '@rekoda/core';
import { publicApi } from '@rekoda/contracts';
import { CONFIG, isProductionEnv, loadConfig, type ApiConfig } from './config.js';

function trustedProxies(): boolean | string[] {
  const raw = process.env['REKODA_TRUSTED_PROXIES']?.trim();
  if (!raw) {
    /* Trust-all is a development-only default: it believes any
     * X-Forwarded-For, which lets a direct caller reset every per-IP bucket
     * with a spoofed header per request. Production must name its proxies -
     * and "production" is anything not explicitly dev or test, so a typo'd
     * NODE_ENV fails CLOSED into requiring the proxy list rather than open. */
    if (isProductionEnv(process.env)) {
      throw new Error(
        'REKODA_TRUSTED_PROXIES is required in production: set it to your ' +
          'proxy/load-balancer addresses or CIDRs, or the per-IP rate limit ' +
          'is defeated by a forged X-Forwarded-For.',
      );
    }
    return true;
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The most a webhook body may be, in bytes.
 *
 * Meta and Paystack payloads are a few kilobytes; nothing legitimate is
 * close to this. The webhooks are exempt from the per-IP limiter (their
 * traffic arrives from a handful of provider IPs), so this cap is what keeps
 * an anonymous flood cheap: a body over it is refused at `onRequest`, before
 * a byte is parsed or an HMAC computed.
 */
const WEBHOOK_MAX_BYTES = 128 * 1024;
const WEBHOOK_PATHS = new Set(['/webhooks/meta', '/webhooks/paystack']);

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    /**
     * `trustProxy: true` believes ANY X-Forwarded-For, which lets a caller
     * who can reach this process directly mint a fresh client address per
     * request and reset every per-IP bucket. REKODA_TRUSTED_PROXIES narrows
     * trust to the deployment's actual proxy addresses (comma-separated IPs
     * or CIDRs); unset keeps the permissive default for development, and
     * production deployments must set it.
     */
    /* An explicit body limit, not the framework default: the statement CSV
     * contract allows 2 MB (reports-api.ts), and the un-set Fastify default
     * is 1 MB, so a year-long statement was already being rejected. Set it
     * once, intentionally, a hair above the largest legitimate JSON body. */
    new FastifyAdapter({ trustProxy: trustedProxies(), bodyLimit: 2 * 1024 * 1024 + 64 * 1024 }),
    /**
     * `rawBody` keeps the exact bytes of each request alongside the parsed
     * body, which the Meta webhook needs: `X-Hub-Signature-256` is an HMAC
     * over what was actually sent, and `JSON.parse` then `JSON.stringify` is
     * not the identity function — key order, whitespace and unicode escaping
     * all move, so hashing a re-serialisation fails for every legitimate
     * request.
     *
     * Nest's own option rather than a hand-registered content-type parser:
     * registering one before `init()` collides with the JSON parser Nest
     * installs itself, and Fastify refuses the duplicate.
     */
    { bufferLogs: true, rawBody: true },
  );

  /**
   * Per-IP rate limiting, which the per-phone limits do NOT cover.
   *
   * The phone limits stop one number being brute-forced. They do nothing about
   * a caller walking through thousands of DIFFERENT numbers, and once delivery
   * runs over WhatsApp each of those requests spends real money on a template
   * message. That makes an unauthenticated `POST /v1/auth/otp/request` a way to
   * bill Rekoda by the request, which is a cost attack rather than a
   * credential one — and invisible to every limit keyed on the phone.
   *
   * `trustProxy` is on above, so the key is the forwarded client address
   * rather than the load balancer's.
   *
   * HONEST LIMITATION: this counter lives in memory, so the ceiling is per
   * instance — three replicas mean three times the limit. That is a real gap
   * at scale and it is fixed by giving this a shared store (the same Redis the
   * job queue will want), not by tightening the number. It is still worth
   * having now: it turns an unbounded spend into a bounded one.
   */
  const config = app.get<ApiConfig>(CONFIG);

  /**
   * Production invariants, before a single request is served (remediation
   * A5/A6). The role check makes FORCE ROW LEVEL SECURITY real — a
   * credential that can bypass RLS turns every policy decorative — and the
   * key fingerprints refuse a process holding the wrong VAULT_KEY or
   * MATCH_KEY, which would otherwise split the estate: old secrets
   * unreadable, new ones written under an impostor. Both fail the boot,
   * loudly, in front of the operator.
   */
  const db = app.get<Db>(DB);
  await bootChecks.assertRoleCannotBypassRls(db, 'application');
  const workerDb = app.get<Db | null>(WORKER_DB);
  if (workerDb) await bootChecks.assertRoleCannotBypassRls(workerDb, 'worker');
  await bootChecks.assertKeyUnchanged(db, 'VAULT_KEY', config.vaultKey);
  await bootChecks.assertKeyUnchanged(db, 'MATCH_KEY', config.matchKey);

  /**
   * Product photos, and nothing else.
   *
   * The ceiling is set here rather than per route so that a body larger than
   * a product photo is refused by the parser before it reaches any handler:
   * checking a size after buffering is checking it too late. `files: 1`
   * because every upload in the product is one photo, and an endpoint that
   * quietly accepted twenty would be a way to fill a bucket with one request.
   */
  await app.register(multipart, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 4 },
    /**
     * Truncate at the ceiling rather than throw at it.
     *
     * Either way the parser stops reading there, so memory is bounded the
     * same. The difference is what the merchant gets: throwing produces a
     * bare 413 that no contract can parse, and a person who has just picked
     * a five megabyte photo on their phone is told "that did not go through"
     * with no idea why. Truncating lets the handler see it was cut off and
     * answer with the limit, which is the sentence they can act on.
     */
    throwFileSizeLimit: false,
  });

  /**
   * A hard ceiling on webhook bodies, enforced before anything reads them.
   *
   * The two webhook routes are exempt from the per-IP limiter above, so this
   * `onRequest` guard is what keeps an anonymous flood from being free: a
   * body over the cap is refused before it is parsed or a signature computed.
   *
   * The cap is only meaningful if it cannot be sidestepped by omitting the
   * header. The global adapter bodyLimit is 2 MB - sixteen times this cap -
   * so a chunked request with no Content-Length would otherwise buffer and
   * JSON-parse 2 MB on the one unauthenticated surface, per request, uncounted.
   * Meta and Paystack are well-behaved clients that always declare a length;
   * a webhook that does not is refused with 411, and one that overstates the
   * cap with 413. A caller cannot understate it either - the length is
   * required to be present AND in range before the body is read.
   */
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (request, reply, done) => {
      const url = (request.url ?? '').split('?')[0] ?? '';
      /* POST only: the GET on these paths is Meta's subscription handshake,
       * which carries no body and no Content-Length by design. */
      if (WEBHOOK_PATHS.has(url) && request.method === 'POST') {
        const header = request.headers['content-length'];
        if (header === undefined) {
          void reply.code(411).send({ statusCode: 411, error: 'Length Required' });
          return;
        }
        const declared = Number(header);
        if (!Number.isFinite(declared) || declared > WEBHOOK_MAX_BYTES) {
          void reply.code(413).send({ statusCode: 413, error: 'Payload Too Large' });
          return;
        }
      }
      done();
    });

  /**
   * Every public-API response says which version answered it, and says so
   * whatever happened (canonical spec §27).
   *
   * `onSend` rather than an interceptor or a filter, because those two miss
   * each other's cases: an interceptor never runs when a guard refuses, and
   * a filter never runs on success. A version header that is present on 200
   * and absent on 401 is worse than none, since an integrator debugging a
   * refusal is exactly who needs to know which version they reached.
   *
   * The same hook carries the retirement notice. The day a version is
   * deprecated, `PUBLIC_API_RETIREMENTS` gains a row and every client
   * learns it from the responses they are already making, on the standard
   * `Deprecation` and `Sunset` headers.
   */
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (request, reply, payload, done) => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (path === '/api' || path.startsWith('/api/')) {
        const version = path.split('/')[2] ?? '';
        const served = publicApi.isPublicApiVersion(version)
          ? version
          : publicApi.CURRENT_PUBLIC_API_VERSION;
        void reply.header(publicApi.v1.PUBLIC_VERSION_HEADER, served);

        const retirement = publicApi.PUBLIC_API_RETIREMENTS[served];
        if (retirement) {
          void reply.header('deprecation', retirement.deprecatedAt);
          void reply.header('sunset', retirement.sunsetAt);
        }
      }
      done(null, payload);
    });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    /* The health endpoint is polled by the platform, not by callers. The
     * webhooks are exempt for a harder reason: Meta and Paystack deliver
     * EVERY merchant's traffic from a handful of source addresses, so a
     * per-IP ceiling would start refusing the platform's own inbound at a
     * few hundred active merchants — and a webhook Meta sees fail repeatedly
     * is a webhook Meta disables. Both routes verify an HMAC signature
     * before doing anything, which is a stronger gate than any counter. */
    allowList: (request) =>
      request.url === '/health' ||
      request.url === '/webhooks/meta' ||
      request.url === '/webhooks/paystack',
    keyGenerator: (request) => request.ip,
    /* The public API gets the public envelope. A client that branches on
     * `error.code` must not meet a different body just because the refusal
     * came from the per-IP limiter rather than from its key's ceiling. */
    errorResponseBuilder: (request, context) => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      if (path === '/api' || path.startsWith('/api/')) {
        return publicApi.v1.publicErrorResponse.parse({
          error: {
            code: 'rate_limited',
            message: 'too many requests, try again shortly',
            retryAfterSeconds: Math.max(1, Math.ceil(Number(context.ttl ?? 60_000) / 1_000)),
          },
        });
      }
      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Too many requests. Try again shortly.',
      };
    },
  });

  // No ValidationPipe: request shapes are parsed with the zod schemas in
  // `@rekoda/contracts`, which `apps/web` parses against too. A second
  // class-validator layer over `unknown` DTOs would validate nothing while
  // looking like it validated everything.
  // Credentials travel in the Authorization header, never a cross-site cookie,
  // so the origin list stays an allowlist rather than a reflection.
  app.enableCors({ origin: config.corsOrigins, credentials: false });
  app.enableShutdownHooks();
  return app;
}

/* Boot only when run directly — the integration tests import createApp. */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // Validate the environment BEFORE Nest starts, so a missing secret is a
  // one-line startup error instead of a stack trace inside a DI factory.
  const config = loadConfig();
  const app = await createApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  new Logger('bootstrap').log(`Rekoda API listening on :${config.port}`);
}
