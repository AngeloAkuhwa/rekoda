/**
 * The dedicated settlement process (OD-51.2): `node dist/settlement-main.js`.
 *
 * It exists so the general background worker never holds the settlement database credential. It
 * holds that one credential (the `rekoda_settlement` role), the platform Paystack key and the
 * vault key, runs the two jobs that settle a Rekoda charge, and serves nothing but a health check
 * on loopback. No job payload, operator request or other process's word makes a charge paid here:
 * every payment is verified with the provider by this process, and every price is recomputed from
 * the source the charge recorded, before anything is applied.
 *
 * Before it claims a job it checks, live against the database, that the credential it was given
 * is exactly `rekoda_settlement`, cannot bypass row-level security, does not act with the
 * application's rights and cannot become any other principal, and that it prices from the source
 * in force. A process started with the wrong credential or setting refuses to run.
 */
import { createServer } from 'node:http';
import { pricingConstantsFingerprint } from '@rekoda/core';
import { bootChecks, createDb, isEntrypoint, sql } from '@rekoda/db';
import { PaystackProvider } from './payments/paystack.provider.js';
import type { PaymentProviderPort } from './payments/provider.port.js';
import { loadSettlementConfig } from './settlement/config.js';
import { buildSettlementRunner } from './settlement/runner.js';

export async function startSettlementProcess(
  env: NodeJS.ProcessEnv = process.env,
  /** Tests pass a stub provider; production always builds the Paystack adapter. */
  provider?: PaymentProviderPort,
): Promise<{ port: number; close: () => Promise<void> }> {
  const config = loadSettlementConfig(env);
  /* One above the lanes: each lane holds a connection across the provider's verify call, and the
   * reclaim pass must never wait behind a full set of slow verifies. */
  const { db, close: closeDb } = createDb(config.settlementDatabaseUrl, {
    max: config.concurrency * 2 + 2,
  });
  try {
    await bootChecks.assertRoleCannotBypassRls(db, 'settlement');
    await bootChecks.assertDatabasePrincipal(db, 'settlement', 'rekoda_settlement');
    await bootChecks.assertPricingSource(db, 'settlement', {
      mode: config.planCatalogueReads ? 'catalogue' : 'constants',
      constantsFingerprint: pricingConstantsFingerprint(),
    });
    if (config.isProduction) await bootChecks.assertNoTestFixtureWriter(db);
  } catch (error) {
    await closeDb();
    throw error;
  }

  const runner = buildSettlementRunner(
    db,
    {
      provider: provider ?? new PaystackProvider(config.paystackSecretKey, config.paystackBaseUrl),
      config: { vaultKey: config.vaultKey, planCatalogueReads: config.planCatalogueReads },
    },
    { concurrency: config.concurrency },
  );
  runner.start();

  /* Loopback only: the compose health check runs inside this container, and nothing on any
   * network can reach this process. */
  /* Healthy means able to settle: the database answers on this process's own credential. A
   * process that lost its database (a revoked login, a network split) reports 503, so compose
   * restarts it and the staging check sees it, instead of a runner failing every job quietly. */
  const databaseAnswers = async (): Promise<boolean> => {
    try {
      await Promise.race([
        db.execute(sql`SELECT 1`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000).unref()),
      ]);
      return true;
    } catch {
      return false;
    }
  };
  const health = createServer((req, res) => {
    const send = (status: number, payload: unknown): void => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
    };
    if (req.method !== 'GET' || (req.url ?? '').split('?')[0] !== '/health') {
      send(404, { statusCode: 404, message: 'not found' });
      return;
    }
    void databaseAnswers().then((up) =>
      send(up ? 200 : 503, {
        status: up ? 'ok' : 'error',
        process: 'settlement',
        database: up ? 'ok' : 'unreachable',
        release: config.release,
        commit: config.commit,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    health.once('error', reject);
    health.listen(config.port, '127.0.0.1', () => resolve());
  });
  const address = health.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(
    `[settlement] job runner started (${config.concurrency} lanes, release ${config.release}); ` +
      `health on 127.0.0.1:${port}; Paystack key ${config.paystackSecretKey ? 'set' : 'not set'}`,
  );
  return {
    port,
    close: async () => {
      await runner.stop();
      await new Promise<void>((resolve) => health.close(() => resolve()));
      /* Bounded: after a database outage a query stranded on a dead connection would otherwise
       * keep the pool, and so the process, open until compose kills it. */
      await Promise.race([
        closeDb(),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
      ]);
    },
  };
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  try {
    const running = await startSettlementProcess();
    const stop = (): void => {
      void running.close().then(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    console.error(
      `[settlement] refusing to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
