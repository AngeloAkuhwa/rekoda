/**
 * FinancialAccountConnection and §22.3 identity over real rows (spec §18,
 * §22.3; B1, PR-073). The claims: a feed connection is bound to the one
 * place money sits that it reads; identifiers a connection produces are
 * scoped to it — a re-polled provider id cannot land twice even when the
 * provider rewords the narration, and the same id under another tenant's
 * connection is a different fact; and the 0045 sketch is frozen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, withBusiness, type Db } from './client.js';
import { bankRepo, identity } from './index.js';
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

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481860${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Mama Chidi Stores',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function link(businessId: string, accountRef = 'acct_mono_1') {
  await withBusiness(db, businessId, (tx) =>
    bankRepo.linkFeed(tx, {
      businessId,
      provider: 'mono',
      accountRef,
      bankName: 'GTBank',
      accountLast4: '4821',
      actor: 'owner',
    }),
  );
  const connection = await withBusiness(db, businessId, (tx) =>
    bankRepo.feedConnectionFor(tx, businessId),
  );
  if (!connection) throw new Error('expected a connection after linking');
  return connection;
}

const feedLine = (externalTransactionId: string, narration: string, row: number) => ({
  postedOn: '2026-08-20',
  amountK: 5_000_000,
  narration,
  bankRef: externalTransactionId,
  externalTransactionId,
  row,
});

describe('the connection entity (§18, §22.3)', () => {
  it('binds to the one bank financial account the business has', async () => {
    const businessId = await seedBusiness();
    const connection = await link(businessId);
    expect(connection).toMatchObject({
      provider: 'mono',
      accountRef: 'acct_mono_1',
      status: 'linked',
      lastSyncedOn: null,
    });
    const bound = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ kind: string }>(sql`
        SELECT fa.kind FROM financial_account_connections fac
        JOIN financial_accounts fa ON fa.id = fac.financial_account_id
        WHERE fac.business_id = ${businessId}::uuid
      `),
    );
    expect([...bound]).toEqual([{ kind: 'bank' }]);
  });

  it('re-linking is a repair in place: one row, new reference, cursor reset', async () => {
    const businessId = await seedBusiness();
    const first = await link(businessId);
    await withBusiness(db, businessId, (tx) =>
      bankRepo.markFeedSynced(tx, businessId, '2026-08-25'),
    );
    const relinked = await link(businessId, 'acct_mono_2');
    expect(relinked.id).toBe(first.id);
    expect(relinked.accountRef).toBe('acct_mono_2');
    expect(relinked.lastSyncedOn).toBeNull();
  });
});

describe('connection-scoped line identity (§22.3)', () => {
  it('a re-polled provider id cannot land twice, even reworded', async () => {
    const businessId = await seedBusiness();
    const connection = await link(businessId);

    const first = await withBusiness(db, businessId, (tx) =>
      bankRepo.importStatementLines(tx, {
        businessId,
        lines: [feedLine('txn_1', 'TRF FROM ADEBAYO O', 1), feedLine('txn_2', 'DIRECT CREDIT', 2)],
        actor: 'system:bank-feed',
        connectionId: connection.id,
      }),
    );
    expect(first).toEqual({ imported: 2, duplicates: 0 });

    /* The same movements again — one verbatim (fingerprint catches it),
     * one REWORDED by the provider (only the §22.3 identity can). */
    const second = await withBusiness(db, businessId, (tx) =>
      bankRepo.importStatementLines(tx, {
        businessId,
        lines: [
          feedLine('txn_1', 'TRF FROM ADEBAYO O', 1),
          feedLine('txn_2', 'DIRECT CREDIT / ADEBAYO', 2),
        ],
        actor: 'system:bank-feed',
        connectionId: connection.id,
      }),
    );
    expect(second).toEqual({ imported: 0, duplicates: 2 });
  });

  it("the same provider id under ANOTHER tenant's connection is a different fact", async () => {
    const a = await seedBusiness();
    const b = await seedBusiness();
    const connectionA = await link(a);
    const connectionB = await link(b);

    for (const [businessId, connectionId] of [
      [a, connectionA.id],
      [b, connectionB.id],
    ] as const) {
      const stored = await withBusiness(db, businessId, (tx) =>
        bankRepo.importStatementLines(tx, {
          businessId,
          lines: [feedLine('txn_shared', 'DIRECT CREDIT', 1)],
          actor: 'system:bank-feed',
          connectionId,
        }),
      );
      expect(stored).toEqual({ imported: 1, duplicates: 0 });
    }
  });

  it('an external id with no connection to scope it is unrepresentable', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO bank_statement_lines
            (business_id, posted_on, amount_k, narration, fingerprint, external_transaction_id)
          VALUES (${businessId}::uuid, '2026-08-20', 5000000, 'DIRECT CREDIT', 'fp_global', 'txn_global')
        `),
      ),
    ).rejects.toThrow();
  });

  it('upload lines keep their fingerprint identity, with no invented connection', async () => {
    const businessId = await seedBusiness();
    const stored = await withBusiness(db, businessId, (tx) =>
      bankRepo.importStatementLines(tx, {
        businessId,
        lines: [
          {
            postedOn: '2026-08-20',
            amountK: 5_000_000,
            narration: 'DIRECT CREDIT',
            bankRef: null,
            row: 1,
          },
        ],
        actor: 'owner',
      }),
    );
    expect(stored).toEqual({ imported: 1, duplicates: 0 });
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ connection: string | null; ext: string | null }>(sql`
        SELECT financial_account_connection_id AS connection, external_transaction_id AS ext
        FROM bank_statement_lines WHERE business_id = ${businessId}::uuid
      `),
    );
    expect([...rows]).toEqual([{ connection: null, ext: null }]);
  });
});

describe('the 0045 sketch is frozen', () => {
  it('nothing can write bank_feed_connections any more', async () => {
    const businessId = await seedBusiness();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO bank_feed_connections
            (business_id, provider, account_ref, bank_name, account_last4)
          VALUES (${businessId}::uuid, 'mono', 'acct_stale', 'GTBank', '4821')
        `),
      ),
    ).rejects.toThrow();
  });
});
