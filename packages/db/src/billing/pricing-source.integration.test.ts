/**
 * OD-51.6 (migration 0215): one authoritative pricing source, in the database.
 *
 *   * `billing_pricing_source` holds the source in force; every runtime role reads it, none writes
 *     it, and only the table owner switches it (with the previous value kept);
 *   * a charge may name only the source in force when it is opened, and never changes it;
 *   * a process whose own setting (or, on the constant path, compiled figures) differs from the
 *     source in force is refused at boot (`assertPricingSource`).
 *
 * Every assertion runs on a live connection as that principal. What settlement does with the
 * recorded source is in `apps/api/src/billing/pricing-source.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { pricingConstantsFingerprint } from '@rekoda/core';
import { withBusiness, type Db } from '../client.js';
import { bootChecks } from '../index.js';
import { setPricingSourceInForce, showPricingSource } from '../pricing-source.js';
import { setPricingSource } from '../testing.js';
import {
  appDb,
  outcome,
  ownerDb,
  PRINCIPALS,
  seedBusiness,
  urls,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const RUNTIME = ['app', 'worker', 'settlement', 'operator'] as const;
const FINGERPRINT = pricingConstantsFingerprint();

let seq = 0;
const open = (businessId: string, source: string | null, db: Db = appDb) => {
  seq += 1;
  const reference = `RKD-PACK-20261112-${String(900_000 + seq)}`;
  return outcome(
    withBusiness(db, businessId, (tx) =>
      tx.execute(sql`
        INSERT INTO subscription_charges
          (business_id, kind, pack_id, quantity, amount_k, reference, pricing_source)
        VALUES (${businessId}::uuid, 'add_on', 'documents_50', 1, 200000, ${reference}, ${source})`),
    ),
  ).then((answer) => ({ answer, reference }));
};

describe('OD-51.6: the pricing source in force is one row in the database (0215)', () => {
  it('is seeded as the catalogue, readable by every runtime role and writable by none', async () => {
    for (const principal of RUNTIME) {
      const db = PRINCIPALS[principal]();
      expect(await bootChecks.pricingSourceInForce(db)).toEqual({
        mode: 'catalogue',
        constantsFingerprint: null,
      });
      for (const statement of [
        sql`UPDATE billing_pricing_source SET mode = 'constants', constants_fingerprint = ${FINGERPRINT}`,
        sql`DELETE FROM billing_pricing_source`,
        sql`INSERT INTO billing_pricing_source (id, mode) VALUES (true, 'catalogue')`,
        sql`INSERT INTO billing_pricing_source_history (mode, set_at, set_by, reason) VALUES ('constants', now(), 'x', 'y')`,
        sql`DELETE FROM billing_pricing_source_history`,
      ]) {
        expect(await outcome(db.execute(statement)), principal).toMatch(
          /^42501 permission denied for table billing_pricing_source/,
        );
      }
      expect(
        await outcome(
          db.execute(
            sql`SELECT rekoda_private.set_pricing_source('constants', ${FINGERPRINT}, 'me', 'because')`,
          ),
        ),
        principal,
      ).toMatch(/^42501 permission denied for (schema rekoda_private|function set_pricing_source)/);
    }
    expect(await bootChecks.pricingSourceInForce(ownerDb)).toMatchObject({ mode: 'catalogue' });
  });

  it('the owner switches it with who and why, and every previous value is kept', async () => {
    const bad = (mode: string | null, fp: string | null, actor: string, reason: string) =>
      outcome(
        ownerDb.execute(
          sql`SELECT rekoda_private.set_pricing_source(${mode}, ${fp}, ${actor}, ${reason})`,
        ),
      );
    expect(await bad('constants', null, 'ops', 'r')).toMatch(/^22023 /); // constants needs its fingerprint
    expect(await bad('catalogue', FINGERPRINT, 'ops', 'r')).toMatch(/^22023 /);
    expect(await bad('prices.json', null, 'ops', 'r')).toMatch(/^22023 /);
    expect(await bad('catalogue', null, ' ', 'r')).toMatch(/^22023 /);
    expect(await bad('catalogue', null, 'ops', '')).toMatch(/^22023 /);

    const switched = await setPricingSourceInForce(urls.owner, {
      mode: 'constants',
      actor: 'release:ada',
      reason: 'catalogue migration under repair',
    });
    expect(switched).toMatchObject({
      mode: 'constants',
      constantsFingerprint: FINGERPRINT,
      setBy: 'release:ada',
      reason: 'catalogue migration under repair',
      thisReleaseConstantsFingerprint: FINGERPRINT,
    });
    expect(await showPricingSource(urls.owner)).toMatchObject({ mode: 'constants' });
    await setPricingSourceInForce(urls.owner, {
      mode: 'catalogue',
      actor: 'release:ada',
      reason: 'repair finished',
    });
    const history = await ownerDb.execute<{ mode: string; set_by: string }>(
      sql`SELECT mode, set_by FROM billing_pricing_source_history ORDER BY id`,
    );
    expect([...history]).toEqual([
      { mode: 'catalogue', set_by: 'migration:0215' },
      { mode: 'constants', set_by: 'release:ada' },
    ]);
    /* A runtime credential cannot run the switch through the command either. */
    await expect(
      setPricingSourceInForce(urls.app, { mode: 'constants', actor: 'x', reason: 'y' }),
    ).rejects.toThrow(/table owner/);
    await expect(
      setPricingSourceInForce(urls.owner, { mode: 'prices.json', actor: 'x', reason: 'y' }),
    ).rejects.toThrow(/catalogue or constants/);
  });

  it('a charge may name only the source in force, whoever opens it', async () => {
    const businessId = await seedBusiness();
    expect((await open(businessId, 'catalogue')).answer).toBe('allowed');
    for (const principal of ['app', 'settlement'] as const) {
      expect((await open(businessId, 'constants', PRINCIPALS[principal]())).answer).toMatch(
        /^42501 .*priced from the pricing source in force \(catalogue\), not constants/,
      );
    }
    /* A charge that names none is priced from the source in force at settlement. */
    expect((await open(businessId, null)).answer).toMatch(/^(allowed|23505 )/);

    await setPricingSource(urls, 'constants');
    const other = await seedBusiness();
    expect((await open(other, 'catalogue')).answer).toMatch(
      /^42501 .*priced from the pricing source in force \(constants\), not catalogue/,
    );
    expect((await open(other, 'constants')).answer).toBe('allowed');
    expect((await open(other, 'prices.json')).answer).toMatch(/^(23514|42501) /);
  });

  it('the source a charge recorded never changes for a runtime role', async () => {
    const businessId = await seedBusiness();
    const { reference } = await open(businessId, 'catalogue');
    await setPricingSource(urls, 'constants');
    for (const principal of RUNTIME) {
      for (const next of ['constants', null]) {
        expect(
          await outcome(
            withBusiness(PRINCIPALS[principal](), businessId, (tx) =>
              tx.execute(
                sql`UPDATE subscription_charges SET pricing_source = ${next} WHERE reference = ${reference}`,
              ),
            ),
          ),
          principal,
        ).toMatch(/^42501 /);
      }
    }
    const [row] = await ownerDb.execute<{ pricing_source: string }>(
      sql`SELECT pricing_source FROM subscription_charges WHERE reference = ${reference}`,
    );
    expect(row!.pricing_source).toBe('catalogue');
  });

  it('a process set to another source, or carrying other compiled figures, is refused at boot', async () => {
    const own = (mode: 'catalogue' | 'constants', constantsFingerprint = FINGERPRINT) => ({
      mode,
      constantsFingerprint,
    });
    await expect(
      bootChecks.assertPricingSource(appDb, 'api', own('catalogue')),
    ).resolves.toBeUndefined();
    await expect(bootChecks.assertPricingSource(appDb, 'api', own('constants'))).rejects.toThrow(
      /REKODA_PLAN_CATALOGUE_READS=0.*the pricing source in force is "catalogue".*Refusing to start/s,
    );

    await setPricingSource(urls, 'constants');
    for (const principal of ['app', 'worker', 'settlement'] as const) {
      const db = PRINCIPALS[principal]();
      await expect(
        bootChecks.assertPricingSource(db, principal, own('constants')),
      ).resolves.toBeUndefined();
      await expect(bootChecks.assertPricingSource(db, principal, own('catalogue'))).rejects.toThrow(
        /the pricing source in force is "constants"/,
      );
      /* The same setting on a release whose compiled prices differ. */
      await expect(
        bootChecks.assertPricingSource(db, principal, own('constants', 'f'.repeat(64))),
      ).rejects.toThrow(/compiled prices that differ.*Refusing to start/s);
    }
  });

  it('the compiled fingerprint is a stable 64-character digest of the price tables', () => {
    expect(FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    expect(pricingConstantsFingerprint()).toBe(FINGERPRINT);
  });
});
