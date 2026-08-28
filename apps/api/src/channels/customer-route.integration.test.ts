/**
 * THE cross-product routing decision (spec §3.1, §5.3; X1, PR-092),
 * against real PostgreSQL: one resolver answers "can Integrate deliver to
 * this customer", and each no carries its product meaning — Chat-only
 * merchants get the details in their own hands, an Integrate business
 * without a standing WABA cannot deliver, and a customer the vault cannot
 * anchor to a number is nobody's thread.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { billingRepo, createDb, identity, wabaRepo, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { encryptFacet } from '@rekoda/core/vault';
import { loadConfig, type ApiConfig } from '../config.js';
import { PrivacyGateway } from '../privacy/gateway.service.js';
import { CustomerThreadRouter } from './customer-route.service.js';

const RUN_SALT = randomBytes(16).toString('hex');

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
let config: ApiConfig;
let gateway: PrivacyGateway;
let router: CustomerThreadRouter;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 4 }));

  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = testKey('pepper');
  process.env['REKODA_API_SECRET'] = testKey('secret');
  process.env['VAULT_KEY'] = testKey('vault');
  process.env['MATCH_KEY'] = testKey('match');
  process.env['CONNECTION_KEY'] = testKey('connection');
  config = loadConfig();
  gateway = new PrivacyGateway(db, config);
  router = new CustomerThreadRouter(config);
});

function testKey(label: string): string {
  return createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');
}

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedMerchant(plan: 'integrate' | 'chat', waba: boolean) {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481890${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  await billingRepo.setPlan(db, {
    businessId: business.id,
    plan,
    expiresAt: null,
    actor: 'operator:test',
  });
  if (waba) {
    await withBusiness(db, business.id, (tx) =>
      wabaRepo.connectWaba(tx, {
        businessId: business.id,
        wabaId: `waba-route-${seq}`,
        phoneNumberId: `pn-route-${seq}`,
        accessTokenCipher: encryptFacet(
          'EAAG-token',
          config.connectionKey,
          `${business.id}:waba_token`,
        ),
        tokenTail: '9f3a',
      }),
    );
  }
  return business.id;
}

const customerWithPhone = async (businessId: string, phone: string) => {
  const resolved = await gateway.resolveStorefrontCustomer(businessId, 'Chidi', phone);
  if (!resolved) throw new Error('fixture: customer did not resolve');
  return resolved.customerId;
};

describe('the one routing answer (spec §3.1; X1)', () => {
  it('routes a phone-anchored customer on a Complete-capable business, phone decrypted in memory', async () => {
    const businessId = await seedMerchant('integrate', true);
    const customerId = await customerWithPhone(businessId, '+2349091110001');

    const route = await withBusiness(db, businessId, (tx) =>
      router.routeFor(tx, businessId, customerId),
    );
    expect(route).toEqual({ state: 'reachable', phone: '+2349091110001' });
  });

  it('a Chat-only business is not_entitled: the merchant gets the details in their own hands', async () => {
    const businessId = await seedMerchant('chat', true);
    const customerId = await customerWithPhone(businessId, '+2349091110002');

    const route = await withBusiness(db, businessId, (tx) =>
      router.routeFor(tx, businessId, customerId),
    );
    expect(route).toEqual({ state: 'not_entitled' });
  });

  it('an Integrate business with no standing WABA cannot deliver', async () => {
    const businessId = await seedMerchant('integrate', false);
    const customerId = await customerWithPhone(businessId, '+2349091110003');

    const route = await withBusiness(db, businessId, (tx) =>
      router.routeFor(tx, businessId, customerId),
    );
    expect(route).toEqual({ state: 'no_connection' });
  });

  it('a REVOKED connection routes nobody: the number is no longer this business to send on', async () => {
    const businessId = await seedMerchant('integrate', true);
    const customerId = await customerWithPhone(businessId, '+2349091110004');
    await withBusiness(db, businessId, async (tx) => {
      const connection = (await wabaRepo.wabaConnectionFor(tx, businessId))!;
      await wabaRepo.markWabaStatus(tx, {
        businessId,
        connectionId: connection.id,
        status: 'REVOKED',
      });
    });

    const route = await withBusiness(db, businessId, (tx) =>
      router.routeFor(tx, businessId, customerId),
    );
    expect(route).toEqual({ state: 'no_connection' });
  });

  it('a customer the vault cannot anchor to a number has no thread', async () => {
    const businessId = await seedMerchant('integrate', true);
    /* A name-only customer, the way a chat sale to "Chidi" creates one. */
    const resolved = await gateway.resolveMention(businessId, 'Chidi');

    const route = await withBusiness(db, businessId, (tx) =>
      router.routeFor(tx, businessId, resolved.customerId),
    );
    expect(route).toEqual({ state: 'no_phone' });
  });
});
