import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { CONFIG, loadConfig, type ApiConfig } from './config.js';

export async function createApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bufferLogs: true },
  );

  const config = app.get<ApiConfig>(CONFIG);
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
