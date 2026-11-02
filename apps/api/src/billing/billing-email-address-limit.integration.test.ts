/**
 * The billing-email confirmation limit per ADDRESS, across businesses (SUB-02a, OWN-58).
 *
 * The per-business limit (five an hour, sixty seconds apart) stops one merchant mailing one inbox
 * too often. It does nothing about many businesses asking for the same inbox: N businesses could
 * mail 5×N links an hour to one person. The owner ruled on 2 Nov 2026 (OWN-66):
 *
 *   - at most 5 requests an hour per normalised address, across all businesses, and at least
 *     60 seconds between requests;
 *   - an unknown provider outcome (a timeout where delivery cannot be confirmed) COUNTS; only a
 *     definite provider refusal gives the request back.
 *
 * The claims pinned here: those figures hold however many businesses or concurrent requests ask;
 * the address is compared as the mailbox compares it; a refused request records no link and sends
 * no mail; the refusal has the same shape as a business's own and says nothing about anyone else;
 * the shared counter holds only a keyed hash with no business id, the application role reaches it
 * only through the two functions, the worker role not at all, and an address can be erased by
 * computing its key.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import {
  EmailDeliveryUncertainError,
  MockEmailSender,
  type EmailSender,
} from '../email/email.port.js';
import { EmailSuppressedError } from '../email/suppressing.sender.js';
import { BillingEmailService } from './billing-email.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

let urls: Urls;
let appDb: Db;
let closeApp: () => Promise<void>;
let ownerDb: Db;
let closeOwner: () => Promise<void>;
let config: ApiConfig;
let mail: MockEmailSender;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 12 }));
  ({ db: ownerDb, close: closeOwner } = createDb(urls.owner, { max: 2 }));
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  config = {
    ...loadConfig(),
    paystackSecretKey: 'sk_test_x',
    paystackPlatformConfirmed: true,
    webUrl: 'https://app.rekoda.test',
  };
});

afterAll(async () => {
  await closeOwner?.();
  await closeApp?.();
});

beforeEach(async () => {
  await truncateAll(urls);
  mail = new MockEmailSender();
});

const emails = (sender: EmailSender = mail) => new BillingEmailService(config, appDb, sender);

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481750${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: 'Shared Inbox Ltd',
    businessType: null,
    ownerUserId: user.id,
  });
  seededBusinessIds.push(business.id);
  return business.id;
}

/** Every business this file has seeded, so time can be moved per business. */
const seededBusinessIds: string[] = [];

const seedBusinesses = async (n: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await seedBusiness());
  return ids;
};

const EMAIL = 'ada@shop.example.ng';
const TABLE = 'billing_email_address_requests';

/** Run one statement on a connection and hand back its rows. */
const rowsOf = async <T extends Record<string, unknown> = Record<string, unknown>>(
  db: Db,
  statement: string,
): Promise<T[]> => [...(await db.execute<T>(sql.raw(statement)))] as T[];

/** The PostgreSQL error a statement failed with (drizzle wraps it in `cause`). */
async function pgError(
  attempt: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await attempt;
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    return { code: cause?.code, message: cause?.message ?? String(error) };
  }
  throw new Error('the statement was expected to fail and did not');
}

/** Open a short-lived connection as one role. */
async function asRole<T>(url: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = createDb(url, { max: 1 });
  try {
    return await fn(db);
  } finally {
    await close();
  }
}

/** Links recorded for one business, read as that business. */
const linksFor = async (businessId: string): Promise<number> =>
  withBusiness(appDb, businessId, async (tx) => {
    const rows = [
      ...(await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM billing_email_verifications
            WHERE business_id = ${businessId}::uuid AND voided_at IS NULL`,
      )),
    ];
    return rows[0]!.n;
  });

/** Move every recorded request back in time, per business and per address, as the owner. */
async function ageEverything(seconds: number): Promise<void> {
  const secs = Number(seconds);
  for (const businessId of seededBusinessIds) {
    await withBusiness(appDb, businessId, async (tx) => {
      await tx.execute(
        sql`UPDATE billing_email_verifications
            SET created_at = created_at - make_interval(secs => ${secs}),
                expires_at = expires_at - make_interval(secs => ${secs})
            WHERE business_id = ${businessId}::uuid`,
      );
    });
  }
  await rowsOf(
    ownerDb,
    `UPDATE ${TABLE} SET created_at = created_at - make_interval(secs => ${secs})`,
  );
}

/**
 * Poll until some backend is blocked waiting for an advisory lock (the address lock), or fail.
 * Read as the owner, which sees every backend's locks.
 */
async function waitUntilAddressLockIsAwaited(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await rowsOf<{ n: number }>(
      ownerDb,
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
    );
    if (row!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('no request ever waited on the address lock');
}

/** Requests the shared counter currently counts. */
const counted = async (): Promise<number> => {
  const rows = await rowsOf<{ n: number }>(
    ownerDb,
    `SELECT count(*)::int AS n FROM ${TABLE} WHERE voided_at IS NULL`,
  );
  return rows[0]!.n;
};

describe('one address, many businesses (SUB-02a, OWN-58)', () => {
  it('refuses a second business inside the 60 seconds, records no link and sends no mail', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');

    const answer = await emails().requestVerification(b!, EMAIL);
    expect(answer).toEqual({ state: 'rate_limited', retryAfterSeconds: 60 });
    expect(await linksFor(b!)).toBe(0);
    expect(mail.outbox).toHaveLength(1);
    expect(mail.attempts).toBe(1);
  });

  it('allows five an hour per address however many businesses ask, and refuses the sixth', async () => {
    const ids = await seedBusinesses(6);
    for (const id of ids.slice(0, 5)) {
      expect((await emails().requestVerification(id, EMAIL)).state).toBe('sent');
      await ageEverything(61);
    }
    const sixth = await emails().requestVerification(ids[5]!, EMAIL);
    expect(sixth).toEqual({ state: 'rate_limited', retryAfterSeconds: 3600 });
    expect(await linksFor(ids[5]!)).toBe(0);
    expect(mail.outbox).toHaveLength(5);

    /* An hour after the first, the window has room again. */
    await ageEverything(60 * 60);
    expect((await emails().requestVerification(ids[5]!, EMAIL)).state).toBe('sent');
  });

  it('treats case and surrounding spaces as the same address', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    const answer = await emails().requestVerification(b!, '  ADA@Shop.Example.NG ');
    expect(answer.state).toBe('rate_limited');
    expect(mail.outbox).toHaveLength(1);
  });

  it('does not limit a different address', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    expect((await emails().requestVerification(b!, 'chidi@shop.example.ng')).state).toBe('sent');
  });

  it('issues exactly one link when ten businesses ask for one address at once', async () => {
    const ids = await seedBusinesses(10);
    const answers = await Promise.all(ids.map((id) => emails().requestVerification(id, EMAIL)));
    expect(answers.filter((a) => a.state === 'sent')).toHaveLength(1);
    expect(answers.filter((a) => a.state === 'rate_limited')).toHaveLength(9);
    expect(mail.outbox).toHaveLength(1);
    const links = await Promise.all(ids.map(linksFor));
    expect(links.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(await counted()).toBe(1);
  });

  it('issues exactly one link when one business asks ten times at once', async () => {
    const [a] = await seedBusinesses(1);
    const answers = await Promise.all(
      Array.from({ length: 10 }, () => emails().requestVerification(a!, EMAIL)),
    );
    expect(answers.filter((x) => x.state === 'sent')).toHaveLength(1);
    expect(mail.outbox).toHaveLength(1);
    expect(await linksFor(a!)).toBe(1);
    expect(await counted()).toBe(1);
  });
});

describe('how a send outcome counts against the address (OWN-66 ruling 2)', () => {
  it('gives the request back when the provider definitely refused the mail', async () => {
    const [a, b] = await seedBusinesses(2);
    mail.failNext = true;
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('unavailable');
    expect(await counted()).toBe(0);
    expect((await emails().requestVerification(b!, EMAIL)).state).toBe('sent');
  });

  it('gives the request back when the address is suppressed', async () => {
    const [a, b] = await seedBusinesses(2);
    const suppressed: EmailSender = {
      available: true,
      send: async () => {
        throw new EmailSuppressedError();
      },
    };
    expect(await emails(suppressed).requestVerification(a!, EMAIL)).toEqual({
      state: 'unavailable',
      reason: 'address_unusable',
    });
    expect(await counted()).toBe(0);
    expect((await emails().requestVerification(b!, EMAIL)).state).toBe('sent');
  });

  it('keeps counting a request whose outcome is unknown, so another business cannot retry it at once', async () => {
    const [a, b] = await seedBusinesses(2);
    const lost: EmailSender = {
      available: true,
      send: async () => {
        throw new EmailDeliveryUncertainError('timed out');
      },
    };
    expect((await emails(lost).requestVerification(a!, EMAIL)).state).toBe('delivery_uncertain');
    expect(await counted()).toBe(1);
    expect(await emails().requestVerification(b!, EMAIL)).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: 60,
    });
    expect(mail.outbox).toHaveLength(0);
  });

  it('counts five unknown outcomes towards the hourly five', async () => {
    const ids = await seedBusinesses(6);
    const lost: EmailSender = {
      available: true,
      send: async () => {
        throw new EmailDeliveryUncertainError('timed out');
      },
    };
    for (const id of ids.slice(0, 5)) {
      expect((await emails(lost).requestVerification(id, EMAIL)).state).toBe('delivery_uncertain');
      await ageEverything(61);
    }
    expect((await emails().requestVerification(ids[5]!, EMAIL)).state).toBe('rate_limited');
  });
});

describe('the per-business limits still hold on their own (OWN-58)', () => {
  /* Each request names a NEW address, so the address limit never applies and only the business's
   * own limits can refuse. Without this, the address limit (same figures) would hide a broken
   * per-business check. */
  const address = (i: number) => `owner${i}@shop.example.ng`;

  it('keeps the 60-second cooldown per business when the address changes', async () => {
    const [a] = await seedBusinesses(1);
    expect((await emails().requestVerification(a!, address(1))).state).toBe('sent');
    const answer = await emails().requestVerification(a!, address(2));
    expect(answer.state).toBe('rate_limited');
    expect(mail.outbox).toHaveLength(1);
  });

  it('keeps five an hour per business across five different addresses', async () => {
    const [a] = await seedBusinesses(1);
    for (let i = 1; i <= 5; i += 1) {
      expect((await emails().requestVerification(a!, address(i))).state).toBe('sent');
      await ageEverything(61);
    }
    expect(await emails().requestVerification(a!, address(6))).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: 3600,
    });
    expect(mail.outbox).toHaveLength(5);
  });
});

describe('retry guidance is never shorter than the real wait', () => {
  it('says an hour, not a minute, when the address used its five and the latest is under 60 s old', async () => {
    const ids = await seedBusinesses(6);
    for (const [i, id] of ids.slice(0, 5).entries()) {
      expect((await emails().requestVerification(id, EMAIL)).state).toBe('sent');
      if (i < 4) await ageEverything(61);
    }
    expect(await emails().requestVerification(ids[5]!, EMAIL)).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: 3600,
    });
  });

  it('says an hour, not a minute, when the business used its five and the latest is under 60 s old', async () => {
    const [a] = await seedBusinesses(1);
    for (let i = 1; i <= 5; i += 1) {
      expect((await emails().requestVerification(a!, `owner${i}@shop.example.ng`)).state).toBe(
        'sent',
      );
      if (i < 5) await ageEverything(61);
    }
    expect(await emails().requestVerification(a!, 'owner6@shop.example.ng')).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: 3600,
    });
  });

  it('reports the longer wait when the business is in its cooldown and the address used its hour', async () => {
    const ids = await seedBusinesses(6);
    for (const id of ids.slice(0, 5)) {
      expect((await emails().requestVerification(id, EMAIL)).state).toBe('sent');
      await ageEverything(61);
    }
    const a = ids[5]!;
    expect((await emails().requestVerification(a, 'owner1@shop.example.ng')).state).toBe('sent');
    /* a is inside its own 60 s cooldown AND the address has used its five this hour. */
    expect(await emails().requestVerification(a, EMAIL)).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: 3600,
    });
    /* Reporting the wait counted nothing against the address. */
    expect(await counted()).toBe(6);
  });

  it('waits for an uncommitted release instead of refusing on the row it is releasing', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    const [row] = await rowsOf<{ id: string; address_key: string }>(
      ownerDb,
      `SELECT id, address_key FROM ${TABLE}`,
    );
    const { db: releaser, close } = createDb(urls.app, { max: 1 });
    try {
      let claim: Promise<{ state: string }> | undefined;
      await releaser.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT billing_email_address_release(${row!.id}::uuid, ${row!.address_key})`,
        );
        /* Another business asks while the release is still uncommitted. Commit only once that
         * claim is seen WAITING on the address lock, so the test proves the serialisation instead
         * of hoping a timer was long enough. */
        claim = emails().requestVerification(b!, EMAIL);
        await waitUntilAddressLockIsAwaited();
      });
      expect((await claim!).state).toBe('sent');
    } finally {
      await close();
    }
  });
});

describe('the refusal reveals nothing about another business', () => {
  it('has exactly the shape of a business hitting its own cooldown', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    const own = await emails().requestVerification(a!, undefined);
    const other = await emails().requestVerification(b!, EMAIL);
    expect(own.state).toBe('rate_limited');
    expect(Object.keys(other).sort()).toEqual(Object.keys(own).sort());
    expect(JSON.stringify(other)).not.toContain(a!);
    expect(JSON.stringify(other)).not.toMatch(/ada|shop|@/i);
  });

  it('does not tell the second business how long ago the first one asked', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    await ageEverything(40);
    expect(await emails().requestVerification(b!, EMAIL)).toEqual({
      state: 'rate_limited',
      retryAfterSeconds: 60,
    });
  });
});

describe('the shared counter (migration 0185)', () => {
  const someKey = 'a'.repeat(43);

  it('stores no address and no business id', async () => {
    const [a] = await seedBusinesses(1);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    const columns = await rowsOf<{ column_name: string }>(
      ownerDb,
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${TABLE}'`,
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual(
      ['address_key', 'created_at', 'id', 'voided_at'].sort(),
    );
    const rows = await rowsOf(ownerDb, `SELECT * FROM ${TABLE}`);
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows).toLowerCase();
    /* Not 'ada' alone: a random uuid or key can contain those hex letters. */
    expect(dump).not.toContain('@');
    expect(dump).not.toContain('ada@shop');
    expect(dump).not.toContain('shop.example');
    expect(dump).not.toContain(a!);
  });

  it('cannot be read, written or deleted directly by the application role', async () => {
    await asRole(urls.app, async (app) => {
      for (const statement of [
        `SELECT * FROM ${TABLE}`,
        `INSERT INTO ${TABLE} (address_key) VALUES ('${someKey}')`,
        `UPDATE ${TABLE} SET voided_at = now()`,
        `DELETE FROM ${TABLE}`,
      ]) {
        expect((await pgError(rowsOf(app, statement))).code).toBe('42501');
      }
    });
  });

  it('is unreachable by the worker role, table and functions alike', async () => {
    await asRole(urls.worker, async (worker) => {
      for (const statement of [
        `SELECT * FROM ${TABLE}`,
        `INSERT INTO ${TABLE} (address_key) VALUES ('${someKey}')`,
        `UPDATE ${TABLE} SET voided_at = now()`,
        `DELETE FROM ${TABLE}`,
        `SELECT * FROM billing_email_address_claim('${someKey}', 5, 60000)`,
        `SELECT billing_email_address_release(gen_random_uuid(), '${someKey}')`,
        `SELECT billing_email_address_wait('${someKey}', 5, 60000)`,
      ]) {
        expect((await pgError(rowsOf(worker, statement))).code).toBe('42501');
      }
    });
  });

  it('refuses a malformed key or out-of-range figures', async () => {
    await asRole(urls.app, async (app) => {
      for (const [args, reason] of [
        [`'ada@shop.example.ng', 5, 60000`, 'malformed address key'],
        [`'${someKey}', 0, 60000`, 'hourly limit out of range'],
        [`'${someKey}', 5, -1`, 'cooldown out of range'],
      ] as const) {
        const failure = await pgError(
          rowsOf(app, `SELECT * FROM billing_email_address_claim(${args})`),
        );
        expect(failure.message).toBe(`billing_email_address_claim: ${reason}`);
      }
      /* Nothing was counted by a refused call. */
      expect(await counted()).toBe(0);
    });
  });

  it('releases a request only when the id and the key both match', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    const [row] = await rowsOf<{ id: string }>(ownerDb, `SELECT id FROM ${TABLE}`);
    await asRole(urls.app, (app) =>
      app.execute(sql`SELECT billing_email_address_release(${row!.id}::uuid, ${'b'.repeat(43)})`),
    );
    expect(await counted()).toBe(1);
    expect((await emails().requestVerification(b!, EMAIL)).state).toBe('rate_limited');
  });

  it('removes a stale row when a later request is decided', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    await ageEverything(25 * 60 * 60);
    expect(await counted()).toBe(1);
    expect((await emails().requestVerification(b!, 'chidi@shop.example.ng')).state).toBe('sent');
    const rows = await rowsOf<{ old: number; fresh: number }>(
      ownerDb,
      `SELECT count(*) FILTER (WHERE created_at < now() - interval '1 day')::int AS old,
              count(*) FILTER (WHERE created_at >= now() - interval '1 day')::int AS fresh
       FROM ${TABLE}`,
    );
    expect(rows[0]).toEqual({ old: 0, fresh: 1 });
  });

  it('lets an address be erased by computing its key', async () => {
    const [a, b] = await seedBusinesses(2);
    expect((await emails().requestVerification(a!, EMAIL)).state).toBe('sent');
    const vault = await import('@rekoda/core/vault');
    const key = vault.billingEmailAddressKeyFor(' Ada@Shop.Example.ng ', config.matchKey);
    const removed = await ownerDb.execute(
      sql`DELETE FROM billing_email_address_requests WHERE address_key = ${key} RETURNING id`,
    );
    expect([...removed]).toHaveLength(1);
    expect((await emails().requestVerification(b!, EMAIL)).state).toBe('sent');
  });
});
