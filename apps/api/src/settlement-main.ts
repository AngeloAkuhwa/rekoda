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
import { bootChecks, createDb, isEntrypoint } from '@rekoda/db';
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
  const health = createServer((req, res) => {
    const ok = req.method === 'GET' && (req.url ?? '').split('?')[0] === '/health';
    const body = JSON.stringify(
      ok
        ? { status: 'ok', process: 'settlement', release: config.release, commit: config.commit }
        : { statusCode: 404, message: 'not found' },
    );
    res.writeHead(ok ? 200 : 404, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
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
      await closeDb();
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
