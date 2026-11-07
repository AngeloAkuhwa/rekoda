/**
 * Operator-initiated erasure of one email address (OD-39, migration 0191).
 *
 * Pinned here: only an operator with `ops:privacy` reaches it; the shared cross-business counter
 * loses that address's rows (and only those), so the shared allowance starts again; a named
 * business's billing email is cleared only when it is that address, its open confirmation links
 * die with it, and no other business is touched; nothing financial goes; the address appears in no
 * receipt, audit row or response; a repeat is harmless; a failure part-way commits nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billingEmailAddressKeyFor, encryptFacet } from '@rekoda/core/vault';
import {
  createDb,
  customersRepo,
  identity,
  issueRepo,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { MockEmailSender } from '../email/email.port.js';
import { BillingEmailService } from '../billing/billing-email.service.js';
import { OPERATOR_SCOPES_KEY } from '../auth/operator.guard.js';
import { EmailErasureController } from './email-erasure.controller.js';
import {
  EmailErasureService,
  ErasureBusinessNotFound,
  ErasureSealUnreadable,
} from './email-erasure.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
const OPERATOR_SECRET = `operator-${testKey('operator')}`;

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let ownerDb: Db;
let closeOwner: () => Promise<void>;
let config: ApiConfig;
let mail: MockEmailSender;
let app: NestFastifyApplication;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  process.env['REKODA_OPERATOR_SECRET'] = OPERATOR_SECRET;
  process.env['REKODA_RATE_LIMIT_MAX'] = '100000';
  delete process.env['NODE_ENV'];
  config = {
    ...loadConfig(),
    paystackSecretKey: 'sk_test_x',
    paystackPlatformConfirmed: true,
    webUrl: 'https://app.rekoda.test',
  };
  const { createApp } = await import('../main.js');
  app = await createApp();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await closeOwner?.();
  await closeApp?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  mail = new MockEmailSender();
});

const EMAIL = 'ada@shop.example.ng';
const emails = () => new BillingEmailService(config, appDb, mail);
const erasure = () => new EmailErasureService(config, appDb);
const OPERATOR = 'operator:test-subject';

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481760${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Erasure Test Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const rowsOf = async <T extends Record<string, unknown>>(db: Db, statement: string): Promise<T[]> =>
  [...(await db.execute<T>(sql.raw(statement)))] as T[];

/** Wait until some backend is blocked on an advisory lock (read as the owner). */
async function waitForBlockedAdvisoryLock(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await rowsOf<{ n: number }>(
      ownerDb,
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
    );
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the erasure never waited on the address lock');
}

const counterRows = async (address = EMAIL): Promise<number> => {
  const key = billingEmailAddressKeyFor(address, config.matchKey);
  const rows = await ownerDb.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM billing_email_address_requests WHERE address_key = ${key}`,
  );
  return [...rows][0]!.n;
};

const billingEmailState = (businessId: string) =>
  withBusiness(appDb, businessId, (tx) => subscriptionsRepo.billingEmailState(tx, businessId));

const openLinks = (businessId: string) =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = await tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM billing_email_verifications
          WHERE business_id = ${businessId}::uuid AND consumed_at IS NULL`,
    );
    return [...rows][0]!.n;
  });

const setAddress = (businessId: string, address: string) =>
  withBusiness(appDb, businessId, (tx) =>
    subscriptionsRepo.setBillingEmailSealed(
      tx,
      businessId,
      encryptFacet(address, config.vaultKey, `billing-email:${businessId}`),
      new Date(),
    ),
  );

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/ops/privacy/email-erasure',
    payload: body as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('who may erase (OD-39)', () => {
  it('declares ops:privacy, and refuses a caller with no operator identity without changing anything', async () => {
    const scopes = new Reflector().get<string[]>(
      OPERATOR_SCOPES_KEY,
      EmailErasureController.prototype.erase,
    );
    expect(scopes).toEqual(['ops:privacy']);

    const a = await seedBusiness();
    expect((await emails().requestVerification(a, EMAIL)).state).toBe('sent');
    for (const headers of [{}, { 'x-rekoda-operator-secret': 'wrong' }]) {
      const res = await post({ address: EMAIL, reason: 'erasure_request' }, headers);
      expect(res.statusCode).toBe(401);
    }
    // A merchant's own session is not an operator identity.
    const merchant = await post(
      { address: EMAIL, reason: 'erasure_request' },
      { authorization: 'Bearer not-an-operator' },
    );
    expect(merchant.statusCode).toBe(401);
    expect(await counterRows()).toBe(1);
  });

  it('erases for an operator, answering without the address', async () => {
    const a = await seedBusiness();
    expect((await emails().requestVerification(a, EMAIL)).state).toBe('sent');
    const res = await post(
      { address: '  ADA@shop.example.ng ', reason: 'limit_cleared' },
      { 'x-rekoda-operator-secret': OPERATOR_SECRET },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      erased: true,
      counterRowsRemoved: 1,
      billingEmail: 'not_requested',
    });
    expect(res.body).not.toMatch(/ada@/i);
    expect(await counterRows()).toBe(0);
  });

  it('refuses a bad body without echoing it, and an unknown business with 404', async () => {
    const bad = await post(
      { address: EMAIL, reason: 'because ada@shop.example.ng asked' },
      { 'x-rekoda-operator-secret': OPERATOR_SECRET },
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain('ada@');
    const missing = await post(
      {
        address: EMAIL,
        reason: 'erasure_request',
        businessId: '00000000-0000-4000-8000-000000000000',
      },
      { 'x-rekoda-operator-secret': OPERATOR_SECRET },
    );
    expect(missing.statusCode).toBe(404);
  });
});

describe('the shared counter (OWN-58, OWN-66)', () => {
  it("restores the address's shared allowance for every business, and leaves other addresses counted", async () => {
    const [a, b] = [await seedBusiness(), await seedBusiness()];
    expect((await emails().requestVerification(a, EMAIL)).state).toBe('sent');
    expect((await emails().requestVerification(b, 'chidi@shop.example.ng')).state).toBe('sent');
    // Inside the 60 seconds the address is refused to another business.
    const c = await seedBusiness();
    expect((await emails().requestVerification(c, EMAIL)).state).toBe('rate_limited');

    const result = await erasure().erase({ address: EMAIL, reason: 'limit_cleared' }, OPERATOR);
    expect(result).toEqual({ erased: true, counterRowsRemoved: 1, billingEmail: 'not_requested' });
    expect(await counterRows('chidi@shop.example.ng')).toBe(1);

    // The address is free again for the business that was refused.
    expect((await emails().requestVerification(c, EMAIL)).state).toBe('sent');
  });

  it('is safe to repeat: nothing more is removed, and each run is receipted', async () => {
    const a = await seedBusiness();
    expect((await emails().requestVerification(a, EMAIL)).state).toBe('sent');
    expect(
      (await erasure().erase({ address: EMAIL, reason: 'erasure_request' }, OPERATOR))
        .counterRowsRemoved,
    ).toBe(1);
    expect(
      (await erasure().erase({ address: EMAIL, reason: 'erasure_request' }, OPERATOR))
        .counterRowsRemoved,
    ).toBe(0);
    const receipts = await rowsOf<{ counter_rows_removed: number }>(
      ownerDb,
      'SELECT counter_rows_removed FROM email_address_erasures ORDER BY created_at',
    );
    expect(receipts.map((r) => r.counter_rows_removed)).toEqual([1, 0]);
  });

  it('waits for an uncommitted claim of the same address, then removes it (the claim lock)', async () => {
    const key = billingEmailAddressKeyFor(EMAIL, config.matchKey);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let claimed!: () => void;
    const claimOpen = new Promise<void>((resolve) => (claimed = resolve));
    const claim = appDb.transaction(async (tx) => {
      await subscriptionsRepo.claimBillingEmailAddress(tx, key, {
        maxPerHour: 5,
        cooldownMs: 60_000,
      });
      claimed();
      await held; // keep the claim, and its address lock, uncommitted
    });
    await claimOpen;
    const erasing = erasure().erase({ address: EMAIL, reason: 'limit_cleared' }, OPERATOR);
    // Without the advisory lock the erasure would finish now, missing the uncommitted row.
    await waitForBlockedAdvisoryLock();
    release();
    await claim;
    expect((await erasing).counterRowsRemoved).toBe(1);
    expect(await counterRows()).toBe(0);
  });
});

describe("a named business's billing email", () => {
  it('is cleared when it is the address, with its proof and open links, and audited without it', async () => {
    const a = await seedBusiness();
    expect((await emails().requestVerification(a, EMAIL)).state).toBe('sent');
    const token = /token=([^\s]+)/.exec(mail.outbox[0]!.text)![1]!;
    expect(await openLinks(a)).toBe(1);

    const result = await erasure().erase(
      { address: 'Ada@Shop.Example.NG', reason: 'erasure_request', businessId: a },
      OPERATOR,
    );
    expect(result).toEqual({ erased: true, counterRowsRemoved: 1, billingEmail: 'cleared' });

    const state = await billingEmailState(a);
    expect(state.sealed).toBeNull();
    expect(state.verifiedAt).toBeNull();
    expect(await openLinks(a)).toBe(0);
    // The link mailed before the erasure can no longer prove anything.
    expect((await emails().confirm(a, decodeURIComponent(token))).state).not.toBe('verified');

    const audit = await rowsOf<{ action: string; actor: string; new_value: unknown }>(
      ownerDb,
      `SELECT action, actor, new_value FROM audit_events WHERE business_id = '${a}' AND action = 'billing_email_erased'`,
    );
    expect(audit).toEqual([
      { action: 'billing_email_erased', actor: OPERATOR, new_value: { erased: true } },
    ]);
    const receipt = await rowsOf<{
      billing_email_cleared: boolean;
      reason: string;
      operator: string;
    }>(ownerDb, 'SELECT billing_email_cleared, reason, operator FROM email_address_erasures');
    expect(receipt).toEqual([
      { billing_email_cleared: true, reason: 'erasure_request', operator: OPERATOR },
    ]);

    // Nowhere the erasure wrote does the address appear.
    const written = await rowsOf<{ dump: string }>(
      ownerDb,
      `SELECT (SELECT coalesce(string_agg(row_to_json(e)::text, ''), '') FROM email_address_erasures e)
            || (SELECT coalesce(string_agg(row_to_json(x)::text, ''), '') FROM audit_events x
                WHERE x.business_id = '${a}') AS dump`,
    );
    expect(written[0]!.dump.toLowerCase()).not.toContain('ada@');
  });

  it('is left alone when it is a different address; the counter is still erased', async () => {
    const a = await seedBusiness();
    await setAddress(a, 'chidi@shop.example.ng');
    const before = await billingEmailState(a);
    const result = await erasure().erase(
      { address: EMAIL, reason: 'erasure_request', businessId: a },
      OPERATOR,
    );
    expect(result.billingEmail).toBe('different_address');
    const after = await billingEmailState(a);
    expect(after.sealed).toBe(before.sealed);
    expect(after.revision).toBe(before.revision);
  });

  it('refuses, changing nothing, when the stored seal cannot be opened (never a false success)', async () => {
    const a = await seedBusiness();
    await withBusiness(appDb, a, (tx) =>
      subscriptionsRepo.setBillingEmailSealed(
        tx,
        a,
        encryptFacet(EMAIL, testKey('another-vault-key'), `billing-email:${a}`),
        new Date(),
      ),
    );
    expect((await emails().requestVerification(await seedBusiness(), EMAIL)).state).toBe('sent');
    const before = await billingEmailState(a);
    await expect(
      erasure().erase({ address: EMAIL, reason: 'erasure_request', businessId: a }, OPERATOR),
    ).rejects.toBeInstanceOf(ErasureSealUnreadable);
    const after = await billingEmailState(a);
    expect(after.sealed).toBe(before.sealed);
    expect(after.revision).toBe(before.revision);
    expect(await counterRows()).toBe(1);
    const res = await post(
      { address: EMAIL, reason: 'erasure_request', businessId: a },
      { 'x-rekoda-operator-secret': OPERATOR_SECRET },
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toMatch(/ada@/i);
    expect(await counterRows()).toBe(1);
  });

  it('reports not_on_file when the business has none', async () => {
    const a = await seedBusiness();
    const result = await erasure().erase(
      { address: EMAIL, reason: 'erasure_request', businessId: a },
      OPERATOR,
    );
    expect(result.billingEmail).toBe('not_on_file');
  });

  it('never touches another business holding the same address (tenant boundary)', async () => {
    const [a, b] = [await seedBusiness(), await seedBusiness()];
    await setAddress(a, EMAIL);
    await setAddress(b, EMAIL);
    await erasure().erase({ address: EMAIL, reason: 'erasure_request', businessId: a }, OPERATOR);
    expect((await billingEmailState(a)).sealed).toBeNull();
    expect((await billingEmailState(b)).sealed).not.toBeNull();
  });

  it('keeps financial records, suppressions and opt-outs', async () => {
    const a = await seedBusiness();
    await setAddress(a, EMAIL);
    const customer = await customersRepo.createCustomerWithIdentities(appDb, a, 'X91', []);
    await withBusiness(appDb, a, async (tx) => {
      await issueRepo.issueSale(tx, {
        businessId: a,
        customerId: customer.id,
        customerToken: 'CUSTOMER_X91',
        items: [{ name: 'gown', quantity: 1, unitPriceK: 5_000_000 }],
        subtotalK: 5_000_000,
        discountK: 0,
        deliveryFeeK: 0,
        vatK: 0,
        totalK: 5_000_000,
        paidK: 0,
        balanceDueK: 5_000_000,
        method: 'transfer',
        sourceType: 'chat',
        sourceId: 'draft-erasure',
        actor: 'system',
      });
      await tx.execute(
        sql`INSERT INTO customer_email_optouts (business_id, address_hash)
            VALUES (${a}::uuid, ${createHash('sha256').update(EMAIL).digest('hex')})`,
      );
    });
    await rowsOf(
      ownerDb,
      `INSERT INTO email_suppressions (address_hash, reason) VALUES ('${createHash('sha256').update(EMAIL).digest('hex')}', 'bounced')`,
    );
    const counts = async () =>
      rowsOf<{ suppressions: number; optouts: number; ledger: number; invoices: number }>(
        ownerDb,
        `SELECT (SELECT count(*)::int FROM email_suppressions) AS suppressions,
                (SELECT count(*)::int FROM customer_email_optouts) AS optouts,
                (SELECT count(*)::int FROM ledger_entries) AS ledger,
                (SELECT count(*)::int FROM invoices) AS invoices`,
      );
    const [before] = await counts();
    expect(before!.invoices).toBe(1);
    expect(before!.ledger).toBeGreaterThan(0);
    expect(before!.optouts).toBe(1);
    await erasure().erase({ address: EMAIL, reason: 'erasure_request', businessId: a }, OPERATOR);
    expect(await counts()).toEqual([before]);
    expect((await billingEmailState(a)).sealed).toBeNull();
  });

  it('commits nothing when the erasure fails part-way, so it can be retried', async () => {
    const a = await seedBusiness();
    await setAddress(a, EMAIL);
    expect((await emails().requestVerification(a, undefined)).state).toBe('sent');
    // An operator value the receipt refuses fails the database function after the business was
    // cleared in the same transaction: everything rolls back together.
    await expect(
      erasure().erase(
        { address: EMAIL, reason: 'erasure_request', businessId: a },
        'not-an-operator',
      ),
    ).rejects.toThrow();
    expect((await billingEmailState(a)).sealed).not.toBeNull();
    expect(await counterRows()).toBe(1);
    expect(await openLinks(a)).toBe(1);

    const retried = await erasure().erase(
      { address: EMAIL, reason: 'erasure_request', businessId: a },
      OPERATOR,
    );
    expect(retried).toEqual({ erased: true, counterRowsRemoved: 1, billingEmail: 'cleared' });
  });

  it('refuses an unknown business without erasing anything', async () => {
    const a = await seedBusiness();
    expect((await emails().requestVerification(a, EMAIL)).state).toBe('sent');
    await expect(
      erasure().erase(
        {
          address: EMAIL,
          reason: 'erasure_request',
          businessId: '00000000-0000-4000-8000-000000000000',
        },
        OPERATOR,
      ),
    ).rejects.toBeInstanceOf(ErasureBusinessNotFound);
    expect(await counterRows()).toBe(1);
  });
});

describe('the receipt table (migration 0191)', () => {
  it('cannot be read, written or deleted by the application or worker role, only through the function', async () => {
    for (const url of [urls.app, urls.worker]) {
      const { db, close } = createDb(url, { max: 1 });
      try {
        for (const statement of [
          'SELECT * FROM email_address_erasures',
          "INSERT INTO email_address_erasures (operator, reason, counter_rows_removed, billing_email_cleared) VALUES ('operator:x', 'erasure_request', 0, false)",
          'DELETE FROM email_address_erasures',
        ]) {
          await expect(db.execute(sql.raw(statement))).rejects.toThrow();
        }
      } finally {
        await close();
      }
    }
    const { db, close } = createDb(urls.worker, { max: 1 });
    try {
      const key = billingEmailAddressKeyFor(EMAIL, config.matchKey);
      await expect(
        db.execute(sql`SELECT email_address_erase(${key}, 'operator:x', 'erasure_request', false)`),
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
