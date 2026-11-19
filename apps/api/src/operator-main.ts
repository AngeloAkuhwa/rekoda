/**
 * The dedicated operator process (OD-51.1): `node dist/operator-main.js`.
 *
 * It exists so the general API never holds the billing-operator database credential. It holds
 * that one credential and nothing else (no application, worker or settlement credential, no vault
 * key, no provider key), verifies every operator's identity itself against its own token audience,
 * and serves only the two operator plan operations.
 *
 * Before it listens it checks, live against the database, that the credential it was given is
 * exactly `rekoda_billing_operator`, cannot bypass row-level security, and cannot become any
 * other principal. A process started with the wrong credential refuses to serve.
 */
import { bootChecks, createDb, isEntrypoint } from '@rekoda/db';
import { loadOperatorConfig } from './operator-plane/config.js';
import { buildOperatorServer } from './operator-plane/server.js';

export async function startOperatorProcess(env: NodeJS.ProcessEnv = process.env): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const config = loadOperatorConfig(env);
  const { db, close: closeDb } = createDb(config.operatorDatabaseUrl, { max: 4 });
  try {
    await bootChecks.assertRoleCannotBypassRls(db, 'operator');
    await bootChecks.assertDatabasePrincipal(db, 'operator', 'rekoda_billing_operator');
    if (config.isProduction) await bootChecks.assertNoTestFixtureWriter(db);
  } catch (error) {
    await closeDb();
    throw error;
  }
  const server = buildOperatorServer({
    operatorDb: db,
    auth: { operatorAuth: config.operatorAuth, operatorSecret: config.operatorSecret },
    release: config.release,
    commit: config.commit,
    onError: (reason) => console.error(`[operator] request failed: ${reason}`),
  });
  /* Bounded, so a slow or silent client cannot hold a connection open. */
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(
    `[operator] listening on ${config.host}:${port} (release ${config.release}); ` +
      `identity: ${config.operatorAuth ? 'verified tokens' : 'development secret'}`,
  );
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDb();
    },
  };
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  try {
    const running = await startOperatorProcess();
    const stop = (): void => {
      void running.close().then(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    console.error(
      `[operator] refusing to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
