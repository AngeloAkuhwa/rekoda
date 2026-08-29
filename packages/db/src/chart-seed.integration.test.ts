/**
 * The seeded chart (PR-030), proved on the two promises that matter: every
 * business gets it — a NEW one at creation through `seedChartOfAccounts`, an
 * EXISTING one through migration 0062 — and the two seeds produce the SAME
 * chart, row for row, so the SQL and the TypeScript cannot drift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLE_SCOPE, SEED_CHART, SYSTEM_ROLES, type SystemRole } from '@rekoda/core';
import { accountsRepo, createDb, identity, withBusiness, type Db } from './index.js';
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
  const user = await identity.upsertUserByPhone(db, `+23481750${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** The comparable shape of one chart row: everything but the ids. */
async function chartShape(businessId: string) {
  const rows = await withBusiness(db, businessId, (tx) => accountsRepo.accountsFor(tx, businessId));
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    type: r.type,
    contra: r.contra,
    systemRole: r.systemRole,
    systemScopeType: r.systemScopeType,
  }));
}

describe('a new business arrives with its chart (PR-030)', () => {
  it('holds every seeded account, and every role the engine may rely on resolves', async () => {
    const businessId = await seedBusiness();
    const chart = await chartShape(businessId);
    expect(chart).toHaveLength(SEED_CHART.length);

    /* Every §11.2 role except the per-connection pair resolves — including
     * the FINANCIAL_ACCOUNT-scoped money roles, through their scope. */
    const perConnection = SYSTEM_ROLES.filter(
      (r) => ROLE_SCOPE[r] === 'PAYMENT_CONNECTION',
    ) as SystemRole[];
    for (const role of SYSTEM_ROLES) {
      if (perConnection.includes(role)) continue;
      if (ROLE_SCOPE[role] === 'BUSINESS') {
        const found = await withBusiness(db, businessId, (tx) =>
          accountsRepo.accountByRole(tx, businessId, role),
        );
        expect(found, role).not.toBeNull();
      }
    }
    /* CASH and BANK resolve through the seeded financial accounts. */
    const seededRoles = chart.filter((r) => r.systemRole !== null).map((r) => r.systemRole);
    expect(seededRoles).toContain('CASH');
    expect(seededRoles.filter((r) => r === 'BANK')).toHaveLength(2);
  });

  it('seeding twice adds nothing', async () => {
    const businessId = await seedBusiness();
    await withBusiness(db, businessId, (tx) => accountsRepo.seedChartOfAccounts(tx, businessId));
    expect(await chartShape(businessId)).toHaveLength(SEED_CHART.length);
  });
});

describe('the SQL seed and the TypeScript seed cannot drift', () => {
  it('migration 0062 gives a bare business the identical chart', async () => {
    /* A business born the TypeScript way. */
    const seeded = await seedBusiness();

    /* A business inserted RAW, the way every business existed before this
     * migration ran — then the migration file itself, re-executed. It is
     * idempotent by design, which is also what makes it testable. */
    const owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
    let bareId: string;
    try {
      const [user] = await owner<{ id: string }[]>`
        INSERT INTO users (phone) VALUES ('+2348179999999') RETURNING id
      `;
      const [row] = await owner<{ id: string }[]>`
        INSERT INTO businesses (name, owner_user_id)
        VALUES ('Pre-migration Ltd', ${user!.id}::uuid) RETURNING id
      `;
      bareId = row!.id;
      const migrationSql = readFileSync(
        join(
          fileURLToPath(import.meta.url),
          '..',
          '..',
          'migrations',
          '0062_seed_chart_of_accounts.sql',
        ),
        'utf8',
      );
      await owner.unsafe(migrationSql);
    } finally {
      await owner.end();
    }

    const fromTs = await chartShape(seeded);
    const fromSql = await chartShape(bareId);
    expect(fromSql).toEqual(fromTs);
  });
});
