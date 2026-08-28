/**
 * The approved commercial figures, as seeded (PR-117, migration 0113).
 *
 * These are the owner's numbers of 28 August 2026, and they are the one
 * kind of value this build has consistently refused to invent. A test that
 * restates them is worth its weight: a figure changed by accident in a
 * later migration is a merchant billed for something they were not sold,
 * and it is exactly the kind of change that reviews slide past because a
 * number looks as plausible as any other number.
 *
 * Read as the OWNER, because this is reference data: a policy keyed on
 * `app.business_id` would hide it from anything reading outside a tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { migrate, requireUrls, resetPlanCatalogue, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  await resetPlanCatalogue(urls);
  ({ db, close } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await close?.();
});

async function rows(statement: string): Promise<Record<string, unknown>[]> {
  return [...(await db.execute(sql.raw(statement)))];
}

describe('the plan units the owner priced', () => {
  it('sells SERVICE_MESSAGE where the storefront conversation happens, and not on Chat', async () => {
    const sold = await rows(`
      SELECT v.plan_id, a.allowance
        FROM allowance_versions a
        JOIN plan_versions v ON v.id = a.plan_version_id
       WHERE a.unit = 'SERVICE_MESSAGE' AND v.version = 1
       ORDER BY v.plan_id
    `);
    expect(sold).toEqual([
      { plan_id: 'complete', allowance: 5000 },
      { plan_id: 'integrate', allowance: 5000 },
      { plan_id: 'trial', allowance: 250 },
    ]);

    /* `chat` and `expired` are ABSENT rather than zero, which is 0105's
     * convention and reads as zero at the meter. Chat is a decision: a Chat
     * merchant talks to customers from their own phone. */
    const plans = sold.map((row) => row.plan_id);
    expect(plans).not.toContain('chat');
    expect(plans).not.toContain('expired');
  });

  it('sells exports on every live plan, gently', async () => {
    const sold = await rows(`
      SELECT v.plan_id, a.allowance
        FROM allowance_versions a
        JOIN plan_versions v ON v.id = a.plan_version_id
       WHERE a.unit = 'REPORT_EXPORTS' AND v.version = 1
       ORDER BY a.allowance
    `);
    expect(sold).toEqual([
      { plan_id: 'trial', allowance: 10 },
      { plan_id: 'chat', allowance: 50 },
      { plan_id: 'integrate', allowance: 100 },
      { plan_id: 'complete', allowance: 200 },
    ]);
  });
});

describe('the API is sold as an add-on, because no plan sells it', () => {
  it('grants the door, one application, and a month of each consumable', async () => {
    expect(
      await rows(`
        SELECT grant_kind, entitlement_key, unit, quantity
          FROM add_on_grants
         WHERE add_on_id = 'developer_api_starter' AND version = 1
         ORDER BY grant_kind, unit
      `),
    ).toEqual([
      { grant_kind: 'CAPACITY', entitlement_key: null, unit: 'API_APPLICATIONS', quantity: 1 },
      {
        grant_kind: 'ENTITLEMENT',
        entitlement_key: 'REKODA_API',
        unit: null,
        quantity: null,
      },
      {
        grant_kind: 'MONTHLY_UNITS',
        entitlement_key: null,
        unit: 'API_REQUEST_UNITS',
        quantity: 25000,
      },
      {
        grant_kind: 'MONTHLY_UNITS',
        entitlement_key: null,
        unit: 'WEBHOOK_DELIVERIES',
        quantity: 25000,
      },
    ]);

    expect(
      await rows(`
        SELECT price_minor, currency, billing_interval FROM add_ons
         WHERE add_on_id = 'developer_api_starter' AND version = 1
      `),
    ).toEqual([{ price_minor: '2500000', currency: 'NGN', billing_interval: 'monthly' }]);
  });

  it('sells a further application as recurring capacity, never as a pack', async () => {
    expect(
      await rows(`
        SELECT grant_kind, unit, quantity FROM add_on_grants
         WHERE add_on_id = 'api_application_extra' AND version = 1
      `),
    ).toEqual([{ grant_kind: 'CAPACITY', unit: 'API_APPLICATIONS', quantity: 1 }]);

    /* And the catalogue cannot express the pack version of the same idea:
     * migration 0112 narrowed `usage_packs.unit` to the consumables. */
    expect(
      await rows(`SELECT pack_id FROM usage_packs WHERE unit = 'API_APPLICATIONS'`),
    ).toHaveLength(0);
  });

  it('tops up the two consumables at the approved prices', async () => {
    expect(
      await rows(`
        SELECT pack_id, unit, quantity, price_minor FROM usage_packs
         WHERE unit IN ('API_REQUEST_UNITS', 'WEBHOOK_DELIVERIES')
         ORDER BY pack_id
      `),
    ).toEqual([
      {
        pack_id: 'api_requests_25k',
        unit: 'API_REQUEST_UNITS',
        quantity: 25000,
        price_minor: '1000000',
      },
      {
        pack_id: 'webhook_deliveries_25k',
        unit: 'WEBHOOK_DELIVERIES',
        quantity: 25000,
        price_minor: '500000',
      },
    ]);
  });
});

describe('the seat add-on finally says what it grants', () => {
  it('is one accountant seat, as capacity', async () => {
    expect(
      await rows(`
        SELECT grant_kind, unit, quantity FROM add_on_grants
         WHERE add_on_id = 'extra_seat' AND version = 1
      `),
    ).toEqual([{ grant_kind: 'CAPACITY', unit: 'ACCOUNTANT_USERS', quantity: 1 }]);
  });

  it('leaves the extra WhatsApp number ungranted, because there is nothing to count', async () => {
    /* Not an omission: an additional WhatsApp number is not one of the
     * seventeen units, and its price is "Custom initially" (0106), so it
     * stays a conversation rather than a self-service grant. */
    expect(
      await rows(`SELECT 1 FROM add_on_grants WHERE add_on_id = 'extra_waba_number'`),
    ).toHaveLength(0);
  });
});
