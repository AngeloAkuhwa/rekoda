import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import rateLimit from '@fastify/rate-limit';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { CONFIG, loadConfig, type ApiConfig } from './config.js';

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
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
