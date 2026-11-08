/**
 * Staging test-business tools (G-119 / OWN-77), the API half of a two-layer fence.
 *
 * Every operation is refused, writing nothing, unless ALL of these hold:
 *   1. REKODA_STAGING_TOOLS=1 (config; a bad value refused the boot);
 *   2. the Paystack key is a TEST key and the §47 confirmation is unset (config refused the boot
 *      otherwise; re-checked here so a future config change cannot loosen it silently);
 *   3. the database carries the staging marker (written by the owner on the staging host only);
 *   4. for anything but designation, the business is a designated test business;
 *   5. the caller holds `ops:staging` (the controller).
 * The database repeats 3 and 4 inside `staging_move_date` and the fault functions, so even a wrong
 * flag on production moves nothing. Date moves go through the OD-37 sanctioned writer; every
 * action is audited append-only. Not a general bypass: three dates, two one-shot faults.
 */
import { Inject, Injectable } from '@nestjs/common';
import { stagingToolsRepo, withBusiness, type Db } from '@rekoda/db';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB } from '../db/db.module.js';
import { chargeGate } from '../billing/paystack-key.js';

export type StagingRefusal =
  | 'disabled'
  | 'not_staging'
  | 'not_test_business'
  | 'no_business'
  | 'changed'
  | 'invalid'
  | 'already_armed'
  | 'no_action'
  | 'already_reverted';

export class StagingRefused extends Error {
  constructor(
    readonly reason: StagingRefusal,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class StagingToolsService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
  ) {}

  /** Conditions 1 to 3. Throws before anything is read or written for a business. */
  private async assertEnabled(): Promise<void> {
    const gate = chargeGate(this.config);
    if (
      !this.config.stagingTools ||
      !gate.ok ||
      gate.kind !== 'test' ||
      this.config.paystackPlatformConfirmed
    ) {
      throw new StagingRefused('disabled', 'the staging tools are not enabled on this deployment');
    }
    if (!(await stagingToolsRepo.isStagingDatabase(this.db))) {
      throw new StagingRefused('not_staging', 'this database is not marked as staging');
    }
  }

  async designate(businessId: string, operator: string, reason: string) {
    await this.assertEnabled();
    const outcome = await withBusiness(this.db, businessId, async (tx) => {
      const exists = await stagingToolsRepo.currentDate(tx, businessId, 'trial_end');
      if (!exists) throw new StagingRefused('no_business', 'no such business');
      return stagingToolsRepo.designateTestBusiness(tx, { businessId, operator, reason });
    });
    if (outcome === 'not_staging') {
      throw new StagingRefused('not_staging', 'this database is not marked as staging');
    }
    return { designated: true as const, already: outcome === 'already' };
  }

  async moveDate(
    businessId: string,
    input: {
      field: stagingToolsRepo.StagingDateField;
      expected: Date | null;
      to: Date;
      reason: string;
    },
    operator: string,
  ) {
    await this.assertEnabled();
    const actionId = await this.inTestBusiness(businessId, (tx) =>
      stagingToolsRepo.moveDate(tx, { businessId, ...input, operator }),
    );
    return { applied: true as const, actionId };
  }

  async revert(businessId: string, actionId: string, operator: string, reason: string) {
    await this.assertEnabled();
    const revertId = await this.inTestBusiness(businessId, async (tx) => {
      const action = await stagingToolsRepo.actionById(tx, businessId, actionId);
      if (!action || action.action !== 'move_date' || !action.field || !action.before) {
        throw new StagingRefused('no_action', 'no date move with that id for this business');
      }
      return stagingToolsRepo.moveDate(tx, {
        businessId,
        field: action.field as stagingToolsRepo.StagingDateField,
        expected: action.after,
        to: action.before,
        operator,
        reason,
        reverts: action.id,
      });
    });
    return { reverted: true as const, actionId: revertId };
  }

  async armFault(
    businessId: string,
    kind: stagingToolsRepo.StagingFaultKind,
    operator: string,
    reason: string,
  ) {
    await this.assertEnabled();
    const outcome = await this.inTestBusiness(businessId, (tx) =>
      stagingToolsRepo.armFault(tx, { businessId, kind, operator, reason }),
    );
    if (outcome === 'already_armed') {
      throw new StagingRefused('already_armed', 'a fault is already armed for this business');
    }
    return { armed: true as const, kind };
  }

  async actions(businessId: string) {
    await this.assertEnabled();
    return this.inTestBusiness(businessId, (tx) => stagingToolsRepo.actionsFor(tx, businessId));
  }

  /** Condition 4, then the work, in one tenant-pinned transaction; database refusals translated. */
  private async inTestBusiness<T>(
    businessId: string,
    work: (tx: Parameters<Parameters<typeof withBusiness>[2]>[0]) => Promise<T>,
  ): Promise<T> {
    try {
      return await withBusiness(this.db, businessId, async (tx) => {
        if (!(await stagingToolsRepo.isTestBusiness(tx, businessId))) {
          throw new StagingRefused('not_test_business', 'not a designated test business');
        }
        return work(tx);
      });
    } catch (error) {
      throw translate(error);
    }
  }
}

/** A refusal raised by `staging_move_date` (the database half), as the API's own. */
function translate(error: unknown): unknown {
  if (error instanceof StagingRefused) return error;
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const message = cause?.message ?? '';
  if (/unique|duplicate key/i.test(message) || cause?.code === '23505') {
    return new StagingRefused('already_reverted', 'that move has already been reverted');
  }
  switch (cause?.code) {
    case '42501':
      return new StagingRefused(
        /not marked as staging/.test(message) ? 'not_staging' : 'not_test_business',
        message.replace(/^staging_move_date: /, ''),
      );
    case '40001':
      return new StagingRefused('changed', 'the value changed since it was read; read it again');
    case '22023':
      return new StagingRefused('invalid', message.replace(/^staging_move_date: /, ''));
    default:
      return error;
  }
}
