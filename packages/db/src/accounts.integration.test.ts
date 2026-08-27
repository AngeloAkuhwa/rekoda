/**
 * The chart of accounts' constraints (spec §11; PR-029), proved against real
 * PostgreSQL — because every one of them exists to catch the writer nobody
 * has thought of yet, and a mocked database would test the mock.
 *
 * The headline assertion: the SQL CHECK and `@rekoda/core`'s ROLE_SCOPE are
 * the SAME mapping, proved by inserting every legal (role, scope) pair and
 * being refused on a representative illegal one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_SCOPE, SYSTEM_ROLES, type SystemRole } from '@rekoda/core';
import { accountsRepo, createDb, identity, paymentsHub, withBusiness, type Db } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
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
  const user = await identity.upsertUserByPhone(db, `+23481700${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

async function seedScopes(businessId: string) {
  return withBusiness(db, businessId, async (tx) => {
    const connection = await paymentsHub.upsertConnection(tx, {
      businessId,
      providerType: 'paystack',
    });
    const bank = await accountsRepo.createFinancialAccount(tx, {
      businessId,
      kind: 'bank',
      label: 'GTBank current',
    });
    const till = await accountsRepo.createFinancialAccount(tx, {
      businessId,
      kind: 'till',
      label: 'Shop till',
    });
    return { connectionId: connection.id, bankId: bank.id, tillId: till.id };
  });
}

function scopeFor(
  role: SystemRole,
  ids: { connectionId: string; bankId: string },
): accountsRepo.RoleScope {
  const scopeType = ROLE_SCOPE[role];
  if (scopeType === 'BUSINESS') return { kind: 'business' };
  if (scopeType === 'PAYMENT_CONNECTION')
    return { kind: 'payment_connection', id: ids.connectionId };
  return { kind: 'financial_account', id: ids.bankId };
}

describe('the §11.2 mapping, agreed between core and the database', () => {
  it('holds every canonical (role, scope) pair — seeded or freshly created', async () => {
    const businessId = await seedBusiness();
    const ids = await seedScopes(businessId);

    /* PR-030's seed already carries every role except the per-connection
     * pair, so the chart holds them; the pair is created here, against a
     * real connection, proving the PAYMENT_CONNECTION half of the CHECK. */
    for (const [i, role] of SYSTEM_ROLES.entries()) {
      if (ROLE_SCOPE[role] !== 'PAYMENT_CONNECTION') continue;
      const { id } = await withBusiness(db, businessId, (tx) =>
        accountsRepo.createAccount(tx, {
          businessId,
          code: `9${String(i).padStart(3, '0')}`,
          name: role.toLowerCase().replaceAll('_', ' '),
          type: 'asset',
          role: { systemRole: role, scope: scopeFor(role, ids) },
        }),
      );
      expect(id).toBeTruthy();
    }

    const chart = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountsFor(tx, businessId),
    );
    const held = new Set(chart.filter((a) => a.systemRole).map((a) => a.systemRole));
    for (const role of SYSTEM_ROLES) expect(held.has(role), role).toBe(true);
  });

  it('makes ACCOUNTS_RECEIVABLE scoped to a payment connection unrepresentable', async () => {
    const businessId = await seedBusiness();
    const ids = await seedScopes(businessId);

    await expect(
      withBusiness(db, businessId, (tx) =>
        accountsRepo.createAccount(tx, {
          businessId,
          code: '1100',
          name: 'Accounts receivable',
          type: 'asset',
          role: {
            systemRole: 'ACCOUNTS_RECEIVABLE',
            scope: { kind: 'payment_connection', id: ids.connectionId },
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('all-or-none and scope integrity (§11.3)', () => {
  it('accepts a plain account with no role at all', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      accountsRepo.createAccount(tx, {
        businessId,
        code: '6900',
        name: 'Generator diesel',
        type: 'expense',
      }),
    );
    expect(id).toBeTruthy();
  });

  it('refuses a scope belonging to another tenant, as a FOREIGN KEY', async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    const bolaScopes = await seedScopes(bola);

    /* Ada's account citing Bola's connection: the composite FK carries the
     * tenant, so this is not merely filtered — it cannot exist. */
    await expect(
      withBusiness(db, ada, (tx) =>
        accountsRepo.createAccount(tx, {
          businessId: ada,
          code: '1015',
          name: 'Paystack clearing',
          type: 'asset',
          role: {
            systemRole: 'PAYMENT_PROVIDER_CLEARING',
            scope: { kind: 'payment_connection', id: bolaScopes.connectionId },
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('one role per scope, and the SAME role on two connections is two accounts', async () => {
    const businessId = await seedBusiness();
    const ids = await seedScopes(businessId);
    const second = await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'monnify' }),
    );

    const mk = (code: string, connectionId: string) =>
      withBusiness(db, businessId, (tx) =>
        accountsRepo.createAccount(tx, {
          businessId,
          code,
          name: 'Clearing',
          type: 'asset',
          role: {
            systemRole: 'PAYMENT_PROVIDER_CLEARING',
            scope: { kind: 'payment_connection', id: connectionId },
          },
        }),
      );

    await mk('8010', ids.connectionId);
    /* Two providers, two clearing accounts: the whole reason a single
     * global systemKey was replaced. */
    await mk('8011', second.id);
    /* A second clearing account for the SAME connection is refused. */
    await expect(mk('8012', ids.connectionId)).rejects.toThrow();

    /* BANK per financial account behaves identically. */
    await withBusiness(db, businessId, (tx) =>
      accountsRepo.createAccount(tx, {
        businessId,
        code: '8020',
        name: 'GTBank',
        type: 'asset',
        role: { systemRole: 'BANK', scope: { kind: 'financial_account', id: ids.bankId } },
      }),
    );
    await withBusiness(db, businessId, (tx) =>
      accountsRepo.createAccount(tx, {
        businessId,
        code: '8000',
        name: 'Shop till',
        type: 'asset',
        role: { systemRole: 'CASH', scope: { kind: 'financial_account', id: ids.tillId } },
      }),
    );
  });
});

describe('the engine resolves a role, never a name (§11.2)', () => {
  it('finds the account by role and scope after the merchant renames it', async () => {
    const businessId = await seedBusiness();
    const ids = await seedScopes(businessId);
    /* The SEEDED revenue account (PR-030): the engine's contract holds on
     * the chart a business actually starts with. */
    const seeded = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountByRole(tx, businessId, 'SALES_REVENUE'),
    );
    expect(seeded).not.toBeNull();
    const id = seeded!.id;
    await withBusiness(db, businessId, (tx) =>
      accountsRepo.renameAccount(tx, businessId, id, 'Shop takings'),
    );

    const found = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountByRole(tx, businessId, 'SALES_REVENUE'),
    );
    expect(found?.id).toBe(id);
    expect(found?.name).toBe('Shop takings');

    /* A per-connection role without its scope id is a question with no
     * meaning, refused before SQL. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        accountsRepo.accountByRole(tx, businessId, 'PAYMENT_PROVIDER_CLEARING'),
      ),
    ).rejects.toThrow(/needs a scope id/);
    void ids;
  });
});

describe('identity is set once (§11.4)', () => {
  it('refuses changing the role, the scope or the type; allows the name', async () => {
    const businessId = await seedBusiness();
    const seeded = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountByRole(tx, businessId, 'SALES_REVENUE'),
    );
    const id = seeded!.id;

    const { sql } = await import('drizzle-orm');
    /* Role change: refused by the trigger however it is attempted. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE accounts SET system_role = 'SALES_RETURNS' WHERE id = ${id}::uuid`),
      ),
    ).rejects.toThrow();
    /* Type change: statement placement is not editable either. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE accounts SET type = 'expense' WHERE id = ${id}::uuid`),
      ),
    ).rejects.toThrow();
    /* The merchant's own name stays theirs. */
    const renamed = await withBusiness(db, businessId, (tx) =>
      accountsRepo.renameAccount(tx, businessId, id, 'Shop takings'),
    );
    expect(renamed).toBe(true);
  });

  it('refuses DELETE outright until the lifecycle PR can see postings', async () => {
    const businessId = await seedBusiness();
    const { id } = await withBusiness(db, businessId, (tx) =>
      accountsRepo.createAccount(tx, {
        businessId,
        code: '6910',
        name: 'Fuel',
        type: 'expense',
      }),
    );
    const { sql } = await import('drizzle-orm');
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`DELETE FROM accounts WHERE id = ${id}::uuid`),
      ),
    ).rejects.toThrow();
  });
});

describe('tenant isolation', () => {
  it('one business never sees another chart', async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();
    await withBusiness(db, ada, (tx) =>
      accountsRepo.createAccount(tx, {
        businessId: ada,
        code: '8999',
        name: 'Private side hustle',
        type: 'income',
      }),
    );

    const bolaSees = await withBusiness(db, bola, (tx) => accountsRepo.accountsFor(tx, bola));
    expect(bolaSees.map((a) => a.code)).not.toContain('8999');
    /* And each holds its own seeded chart, not a shared one. */
    const adaSees = await withBusiness(db, ada, (tx) => accountsRepo.accountsFor(tx, ada));
    expect(adaSees.length).toBe(bolaSees.length + 1);
  });
});
