/**
 * `PrivacyGateway.findMention` over a real PostgreSQL (G-135, BA-OD-3): the lookup a
 * question uses. Split from gateway.integration.test.ts by concern.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, customersRepo, identity, sql, withBusiness, type Db } from '@rekoda/db';
import { encryptFacet, matchKeyFor, normaliseFacet } from '@rekoda/core/vault';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { PrivacyGateway } from './gateway.service.js';
import { loadConfig } from '../config.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
let gateway: PrivacyGateway;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  gateway = new PrivacyGateway(db, loadConfig());
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

async function seedBusiness(name: string, phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(db, phone);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/**
 * `findMention`: the lookup a question uses (OD-3 / BA-OD-3, G-135). It finds a
 * name exactly as `resolveMention` would, and creates nothing when there is none.
 */
describe('a question looks a name up and never creates it (G-135)', () => {
  const counts = (businessId: string) =>
    withBusiness(db, businessId, async (tx) => {
      const [row] = [
        ...(await tx.execute<{ customers: number; facets: number }>(sql`
          SELECT (SELECT count(*)::int FROM customers WHERE business_id = ${businessId}::uuid)
                   AS customers,
                 (SELECT count(*)::int FROM customer_identities
                   WHERE business_id = ${businessId}::uuid) AS facets`)),
      ];
      return row!;
    });

  it('returns null for an unknown name and stores nothing', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    expect(await gateway.findMention(businessId, 'Bola Ige')).toBeNull();
    expect(await gateway.findMention(businessId, 'Bola Ige')).toBeNull();
    expect(await counts(businessId)).toEqual({ customers: 0, facets: 0 });
  });

  it.each([
    ['stored composed, asked decomposed', 'Adébáyọ̀'.normalize('NFC'), 'Adébáyọ̀'.normalize('NFD')],
    ['stored decomposed, asked composed', 'Adébáyọ̀'.normalize('NFD'), 'Adébáyọ̀'.normalize('NFC')],
  ])('finds a known name %s, creating nothing', async (_, stored, asked) => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    /* Seeded with the key of the name EXACTLY as stored: `resolveMention` keys a new
     * name in NFC, so it could never leave the decomposed key an older row may hold
     * (CodeRabbit on #437). */
    const config = loadConfig();
    const { token, id: customerId } = await customersRepo.createCustomerWithIdentities(
      db,
      businessId,
      'CUSTOMER_N7D',
      [
        {
          facet: 'name',
          ciphertext: encryptFacet(stored, config.vaultKey, `${businessId}:name`),
          matchKey: matchKeyFor(
            businessId,
            'name',
            normaliseFacet('name', stored),
            config.matchKey,
          ),
        },
      ],
    );
    const before = await counts(businessId);
    expect(await gateway.findMention(businessId, asked)).toEqual({ token, customerId });
    expect(await counts(businessId)).toEqual(before);
  });

  it('never finds another business customer of the same name', async () => {
    const mine = await seedBusiness('Ada Fashion', '+2348060000001');
    const theirs = await seedBusiness('Obi Stores', '+2348060000002');
    await gateway.resolveMention(theirs, 'Bola Ige');
    const theirsBefore = await counts(theirs);

    expect(await gateway.findMention(mine, 'Bola Ige')).toBeNull();
    expect(await counts(mine)).toEqual({ customers: 0, facets: 0 });
    expect(await counts(theirs)).toEqual(theirsBefore);
  });

  it('finds a customer known by name and phone through the name, adding no facet', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { token, customerId } = await gateway.resolveMention(businessId, 'Bola Ige');
    /* The phone joins the same customer only through a confirmed link; here it
     * is its own facet on its own customer, so two identities exist. */
    await gateway.tokenise(businessId, 'Bola 08031112222 paid');
    const before = await counts(businessId);
    expect(before.facets).toBeGreaterThanOrEqual(2);
    expect(await gateway.findMention(businessId, 'bola  ige')).toEqual({ token, customerId });
    expect(await counts(businessId)).toEqual(before);
  });
});
