import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { MAX_IMAGE_BYTES } from '@rekoda/core';
import { CONFIG, loadConfig, type ApiConfig } from './config.js';

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
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

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    // The health endpoint is polled by the platform, not by callers.
    allowList: (request) => request.url === '/health',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Too many requests. Try again shortly.',
    }),
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
