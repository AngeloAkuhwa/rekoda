/**
 * The recovery drill (S1, PR-107), against real PostgreSQL and the real
 * `pg_dump` / `pg_restore` binaries.
 *
 * The backup runbook's first rule is "a backup that has not been
 * restore-drilled does not count as a backup." This is that drill, as a
 * test: seed a business whose books balance, take a real `pg_dump -Fc`,
 * restore it into a FRESH database with `pg_restore`, and prove the §31
 * integrity invariants still hold in the restored copy - the ledger
 * balances per business, and no paid invoice lost its money trail. A backup
 * that restores to a database which no longer ties is not a recovery; it is
 * a second incident.
 *
 * It exercises the actual tooling the runbook names, so the day the dump
 * format, a role grant, or an RLS policy stops surviving the round trip,
 * this fails in CI rather than at 2am against production.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  createDb,
  customersRepo,
  identity,
  issueRepo,
  settleRepo,
  withBusiness,
  type Db,
} from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

/** The owner URL, parsed into the pieces the pg CLIs and a scratch db need. */
function ownerParts() {
  const u = new URL(urls.owner);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    database: u.pathname.replace(/^\//, ''),
    env: {
      ...process.env,
      PGHOST: u.hostname,
      PGPORT: u.port || '5432',
      PGUSER: decodeURIComponent(u.username),
      ...(u.password ? { PGPASSWORD: decodeURIComponent(u.password) } : {}),
    } as NodeJS.ProcessEnv,
  };
}

async function seedBalancedBusiness(): Promise<string> {
  const user = await identity.upsertUserByPhone(db, '+2348195000001');
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const customer = await customersRepo.createCustomerWithIdentities(db, business.id, 'CHI', []);
  const sale = await withBusiness(db, business.id, (tx) =>
    issueRepo.issueSale(tx, {
      businessId: business.id,
      customerId: customer.id,
      customerToken: 'CHI',
      items: [{ name: 'wig', quantity: 1, unitPriceK: 50_000 }],
      subtotalK: 50_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 50_000,
      paidK: 0,
      balanceDueK: 50_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: 'drill-1',
      actor: 'owner',
    }),
  );
  /* Settled through the real path, so the paid invoice carries its payment,
   * its allocation and its receipt - exactly what invariant 3 checks for. */
  await withBusiness(db, business.id, (tx) =>
    settleRepo.recordMerchantPayment(tx, {
      businessId: business.id,
      invoiceId: sale.invoiceId,
      amountK: 50_000,
      method: 'cash',
      sourceType: 'chat',
      sourceId: 'drill-pay-1',
      actor: 'owner',
    }),
  );
  return business.id;
}

describe('the recovery drill (S1, PR-107)', () => {
  it('a real dump and restore preserves the ledger and every money trail', async () => {
    const businessId = await seedBalancedBusiness();
    const parts = ownerParts();
    const scratchName = `rekoda_drill_${process.pid}`;
    const workDir = mkdtempSync(join(tmpdir(), 'rekoda-drill-'));
    const dumpFile = join(workDir, 'rekoda.dump');

    const admin = postgres(urls.owner, { max: 1, onnotice: () => {} });
    try {
      /* A real custom-format dump of the whole database - schema, data,
       * grants, policies - exactly what the runbook's `pg_dump -Fc` takes. */
      execFileSync('pg_dump', ['-Fc', '-f', dumpFile, parts.database], { env: parts.env });

      /* A fresh, empty target. DROP first in case a prior aborted run left
       * one behind; CREATE cannot run inside a transaction, hence `unsafe`. */
      await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
      await admin.unsafe(`CREATE DATABASE ${scratchName}`);

      /* The restore the runbook names, into the scratch database. --no-owner
       * because the dump's objects are owned by the cluster's roles and the
       * drill only proves the DATA survives, not a role migration. */
      execFileSync('pg_restore', ['--no-owner', '--dbname', scratchName, dumpFile], {
        env: parts.env,
      });

      /* Now interrogate the RESTORED copy directly, as the owner, and assert
       * the §31 invariants the integrity probes watch for. */
      const scratchUrl = new URL(urls.owner);
      scratchUrl.pathname = `/${scratchName}`;
      const restored = postgres(scratchUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        /* Invariant 2: every posted journal balances, per business. */
        const unbalanced = await restored`
          SELECT business_id
          FROM ledger_entries
          GROUP BY business_id, transaction_id
          HAVING sum(debit_k) <> sum(credit_k)
        `;
        expect(unbalanced.length).toBe(0);

        /* Invariant 3: no paid invoice without its allocations or credits. */
        const orphanPaid = await restored`
          SELECT i.id FROM invoices i
          WHERE i.status = 'paid'
            AND NOT EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.invoice_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM customer_credit_applications ca WHERE ca.invoice_id = i.id)
        `;
        expect(orphanPaid.length).toBe(0);

        /* And the business, its paid invoice and its receipt actually made
         * it across - a drill that restored an empty database would pass the
         * two checks above vacuously. */
        const [biz] =
          await restored`SELECT count(*)::int AS n FROM businesses WHERE id = ${businessId}::uuid`;
        expect(biz?.['n']).toBe(1);
        const [paid] =
          await restored`SELECT count(*)::int AS n FROM invoices WHERE business_id = ${businessId}::uuid AND status = 'paid'`;
        expect(paid?.['n']).toBe(1);
        const [receipts] =
          await restored`SELECT count(*)::int AS n FROM receipts WHERE business_id = ${businessId}::uuid`;
        expect(receipts?.['n']).toBe(1);
      } finally {
        await restored.end();
      }
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName}`);
      await admin.end();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 120_000);
});
