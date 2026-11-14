/**
 * The settlement runner (OD-51.2): the two jobs that settle a Rekoda charge, on the settlement
 * credential and nothing else.
 *
 * It claims ONLY the settlement kinds, and every database statement it makes (the claim, the
 * lease renewal, the handler's transaction, its completion, a failure's record, the reclaim of its
 * own stalled jobs) runs as `rekoda_settlement`. That role holds exactly what these two jobs need
 * (migration 0217) and does not act with the application's rights, so this runner needs no
 * application or worker pool, and the general worker needs no settlement credential.
 *
 * In production it runs in its own process (`settlement-main.ts`). In development and the
 * integration suites the general runner attaches it (`buildRunner`), so one process can play both.
 */
import { jobsRepo, type Db } from '@rekoda/db';
import type { ApiConfig } from '../config.js';
import type { PaymentProviderPort } from '../payments/provider.port.js';
import { applyNoChargeUpgradeHandler } from '../jobs/apply-no-charge-upgrade.handler.js';
import { processBillingChargeHandler } from '../jobs/process-billing-charge.handler.js';
import { JobRunner, type RunnerOptions } from '../jobs/runner.js';

/** The two kinds, by the names the queue stores (`JobKind.ProcessBillingCharge` and
 * `JobKind.ApplyNoChargeUpgrade`); the same list the database's queue policies hold. */
const [PROCESS_BILLING_CHARGE, APPLY_NO_CHARGE_UPGRADE] = jobsRepo.SETTLEMENT_JOB_KINDS;

export interface SettlementRunnerDeps {
  /** The platform's payment provider: every payment is verified with it, by this runner. */
  provider: PaymentProviderPort;
  config: Pick<ApiConfig, 'vaultKey' | 'planCatalogueReads'>;
}

export function buildSettlementRunner(
  settlementDb: Db,
  deps: SettlementRunnerDeps,
  options: Omit<RunnerOptions, 'claim'> = {},
): JobRunner {
  const runner = new JobRunner(settlementDb, settlementDb, {
    workerId: `settlement-${process.pid}`,
    ...options,
    claim: { only: jobsRepo.SETTLEMENT_JOB_KINDS },
  });
  runner.register(
    PROCESS_BILLING_CHARGE,
    processBillingChargeHandler({ provider: deps.provider, config: deps.config }),
  );
  runner.register(APPLY_NO_CHARGE_UPGRADE, applyNoChargeUpgradeHandler({ config: deps.config }));
  return runner;
}
