/**
 * The four independent statuses (spec §17.1; PR-051): they fail
 * independently, so they are separate columns; production is DERIVED in
 * the database — all four must permit it — and no writer can hold a
 * stale copy of that answer, because no writer can write it at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accountsRepo,
  createDb,
  identity,
  paymentsHub,
  sql,
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
  ({ db, close } = createDb(urls.app, { max: 8 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedConnection(): Promise<{ businessId: string; connectionId: string }> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481860${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  const connection = await withBusiness(db, business.id, (tx) =>
    paymentsHub.upsertConnection(tx, { businessId: business.id, providerType: 'paystack' }),
  );
  return { businessId: business.id, connectionId: connection.id };
}

async function axes(businessId: string, connectionId: string) {
  const rows = await withBusiness(db, businessId, (tx) =>
    tx.execute<{
      operational_status: string;
      kyc_status: string;
      commercial_status: string;
      compliance_status: string;
      production_enabled: boolean;
    }>(sql`
      SELECT operational_status, kyc_status, commercial_status, compliance_status, production_enabled
      FROM payment_connections WHERE id = ${connectionId}::uuid
    `),
  );
  return [...rows][0]!;
}

function setAxes(
  businessId: string,
  connectionId: string,
  values: Partial<
    Record<'operational_status' | 'kyc_status' | 'commercial_status' | 'compliance_status', string>
  >,
) {
  return withBusiness(db, businessId, async (tx) => {
    for (const [column, value] of Object.entries(values)) {
      await tx.execute(
        sql`UPDATE payment_connections SET ${sql.raw(column)} = ${value} WHERE id = ${connectionId}::uuid`,
      );
    }
  });
}

describe('four axes, one derived answer (§17.1)', () => {
  it('a new connection permits nothing and derives disabled', async () => {
    const { businessId, connectionId } = await seedConnection();
    const row = await axes(businessId, connectionId);
    expect(row).toMatchObject({
      operational_status: 'NOT_CONFIGURED',
      commercial_status: 'UNCONFIRMED',
      compliance_status: 'PERMITTED',
      production_enabled: false,
    });
  });

  it('production enables only when all four permit, and any one failing kills it', async () => {
    const { businessId, connectionId } = await seedConnection();
    await setAxes(businessId, connectionId, {
      operational_status: 'ACTIVE',
      kyc_status: 'verified',
      commercial_status: 'AGREED',
      compliance_status: 'PERMITTED',
    });
    expect((await axes(businessId, connectionId)).production_enabled).toBe(true);

    /* Operationally healthy, commercially suspended: the state the blended
     * column could not represent. */
    await setAxes(businessId, connectionId, { commercial_status: 'SUSPENDED' });
    const suspended = await axes(businessId, connectionId);
    expect(suspended.operational_status).toBe('ACTIVE');
    expect(suspended.production_enabled).toBe(false);

    await setAxes(businessId, connectionId, {
      commercial_status: 'AGREED',
      compliance_status: 'BLOCKED',
    });
    expect((await axes(businessId, connectionId)).production_enabled).toBe(false);
  });

  it('nobody writes the derived answer', async () => {
    const { businessId, connectionId } = await seedConnection();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE payment_connections SET production_enabled = true WHERE id = ${connectionId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('an unknown value on any axis is unrepresentable', async () => {
    const { businessId, connectionId } = await seedConnection();
    await expect(
      setAxes(businessId, connectionId, { commercial_status: 'VIBES' }),
    ).rejects.toThrow();
  });
});

describe('provider-neutral attributes (§17.2; PR-052)', () => {
  it('a merchant on their own key is a direct merchant on their own credentials, production-enabled', async () => {
    seq += 1;
    const user = await identity.upsertUserByPhone(db, `+23481865${String(seq).padStart(4, '0')}`);
    const business = await identity.createBusinessWithOwner(db, {
      name: 'Ada Fashion',
      businessType: null,
      ownerUserId: user.id,
    });
    await withBusiness(db, business.id, (tx) =>
      paymentsHub.storeMerchantKey(tx, {
        businessId: business.id,
        providerType: 'paystack',
        merchantKeyCipher: 'vault:blob',
        merchantKeyTail: '4821',
      }),
    );
    const rows = await withBusiness(db, business.id, (tx) =>
      tx.execute<{
        representation: string;
        credential_source: string;
        account_ownership: string;
        production_enabled: boolean;
      }>(sql`
        SELECT representation, credential_source, account_ownership, production_enabled
        FROM payment_connections WHERE business_id = ${business.id}::uuid
      `),
    );
    expect([...rows][0]).toEqual({
      representation: 'DIRECT_MERCHANT',
      credential_source: 'MERCHANT_SUPPLIED',
      account_ownership: 'MERCHANT_OWNED',
      /* kyc 'not_required' permits: the provider verified this merchant
       * when it issued their live key. */
      production_enabled: true,
    });
  });

  it('a platform connection defaults to sub-merchant on platform credentials', async () => {
    const { businessId, connectionId } = await seedConnection();
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ representation: string; credential_source: string }>(sql`
        SELECT representation, credential_source FROM payment_connections
        WHERE id = ${connectionId}::uuid
      `),
    );
    expect([...rows][0]).toEqual({
      representation: 'SUB_MERCHANT',
      credential_source: 'PLATFORM_ISSUED',
    });
  });

  it('PLATFORM_ONLY is representable, and nonsense is not', async () => {
    const { businessId, connectionId } = await seedConnection();
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE payment_connections SET representation = 'PLATFORM_ONLY' WHERE id = ${connectionId}::uuid`,
      ),
    );
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(
          sql`UPDATE payment_connections SET account_ownership = 'COMMUNAL' WHERE id = ${connectionId}::uuid`,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('connection-scoped clearing accounts (§11.2; PR-053)', () => {
  it('a connection is born with its clearing and chargeback accounts, once', async () => {
    const { businessId, connectionId } = await seedConnection();
    const clearing = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountByRole(tx, businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId),
    );
    const chargeback = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountByRole(tx, businessId, 'PROVIDER_CHARGEBACK_PAYABLE', connectionId),
    );
    expect(clearing).toMatchObject({ code: '1015', type: 'asset', name: 'Paystack clearing' });
    expect(chargeback).toMatchObject({
      code: '2150',
      type: 'liability',
      name: 'Paystack chargebacks',
    });

    /* A reconnect provisions nothing twice. */
    await withBusiness(db, businessId, (tx) =>
      paymentsHub.upsertConnection(tx, { businessId, providerType: 'paystack' }),
    );
    const count = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT count(*)::bigint AS n FROM accounts
        WHERE business_id = ${businessId}::uuid AND system_role = 'PAYMENT_PROVIDER_CLEARING'
      `),
    );
    expect(Number([...count][0]!.n)).toBe(1);
  });

  it('two providers, two pairs, distinct codes, each resolvable by its own scope', async () => {
    const { businessId, connectionId } = await seedConnection();
    const second = await withBusiness(db, businessId, (tx) =>
      paymentsHub.storeMerchantKey(tx, {
        businessId,
        providerType: 'monnify',
        merchantKeyCipher: 'vault:blob',
        merchantKeyTail: '9911',
      }),
    );
    void second;
    const monnify = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM payment_connections
        WHERE business_id = ${businessId}::uuid AND provider_type = 'monnify'
      `),
    );
    const monnifyId = [...monnify][0]!.id;

    const first = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountByRole(tx, businessId, 'PAYMENT_PROVIDER_CLEARING', connectionId),
    );
    const secondClearing = await withBusiness(db, businessId, (tx) =>
      accountsRepo.accountByRole(tx, businessId, 'PAYMENT_PROVIDER_CLEARING', monnifyId),
    );
    expect(first!.code).toBe('1015');
    expect(secondClearing!.code).toBe('1015-2');
    expect(secondClearing!.name).toBe('Monnify clearing');
    expect(first!.id).not.toBe(secondClearing!.id);
  });
});

describe('payment attempts (§6.1, §22.3; PR-054)', () => {
  async function intentFixture() {
    const { businessId, connectionId } = await seedConnection();
    const intent = await withBusiness(db, businessId, (tx) =>
      paymentsHub.createIntent(tx, {
        businessId,
        reference: `RKD-PAY-${seq}`,
        expectedAmountK: 100_000,
        providerType: 'paystack',
        paymentConnectionId: connectionId,
      }),
    );
    return { businessId, connectionId, intentId: intent.id };
  }

  it('one try records once: a redelivered callback is the same attempt', async () => {
    const { businessId, connectionId, intentId } = await intentFixture();
    const first = await withBusiness(db, businessId, (tx) =>
      paymentsHub.recordPaymentAttempt(tx, {
        businessId,
        paymentIntentId: intentId,
        paymentConnectionId: connectionId,
        providerAttemptId: 'att_123',
        method: 'bank_transfer',
      }),
    );
    expect(first.outcome).toBe('recorded');
    const replay = await withBusiness(db, businessId, (tx) =>
      paymentsHub.recordPaymentAttempt(tx, {
        businessId,
        paymentIntentId: intentId,
        paymentConnectionId: connectionId,
        providerAttemptId: 'att_123',
      }),
    );
    expect(replay).toEqual({ outcome: 'already_recorded', id: first.id });
  });

  it('the same provider attempt id on another connection is another try: identity is connection-scoped', async () => {
    const { businessId, connectionId, intentId } = await intentFixture();
    await withBusiness(db, businessId, (tx) =>
      paymentsHub.storeMerchantKey(tx, {
        businessId,
        providerType: 'monnify',
        merchantKeyCipher: 'vault:blob',
        merchantKeyTail: '1111',
      }),
    );
    const monnify = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ id: string }>(sql`
        SELECT id FROM payment_connections
        WHERE business_id = ${businessId}::uuid AND provider_type = 'monnify'
      `),
    );
    const monnifyId = [...monnify][0]!.id;
    const monnifyIntent = await withBusiness(db, businessId, (tx) =>
      paymentsHub.createIntent(tx, {
        businessId,
        reference: `RKD-PAY-M-${seq}`,
        expectedAmountK: 50_000,
        providerType: 'monnify',
        paymentConnectionId: monnifyId,
      }),
    );

    const a = await withBusiness(db, businessId, (tx) =>
      paymentsHub.recordPaymentAttempt(tx, {
        businessId,
        paymentIntentId: intentId,
        paymentConnectionId: connectionId,
        providerAttemptId: 'att_shared',
      }),
    );
    const b = await withBusiness(db, businessId, (tx) =>
      paymentsHub.recordPaymentAttempt(tx, {
        businessId,
        paymentIntentId: monnifyIntent.id,
        paymentConnectionId: monnifyId,
        providerAttemptId: 'att_shared',
      }),
    );
    expect(a.outcome).toBe('recorded');
    expect(b.outcome).toBe('recorded');
    expect(a.id).not.toBe(b.id);
  });

  it('a try resolves once, keeps its reason, and never deletes', async () => {
    const { businessId, connectionId, intentId } = await intentFixture();
    const attempt = await withBusiness(db, businessId, (tx) =>
      paymentsHub.recordPaymentAttempt(tx, {
        businessId,
        paymentIntentId: intentId,
        paymentConnectionId: connectionId,
        providerAttemptId: 'att_res',
      }),
    );
    expect(
      await withBusiness(db, businessId, (tx) =>
        paymentsHub.resolvePaymentAttempt(tx, {
          businessId,
          attemptId: attempt.id,
          status: 'FAILED',
          failureReason: 'insufficient_funds',
        }),
      ),
    ).toBe('resolved');
    expect(
      await withBusiness(db, businessId, (tx) =>
        paymentsHub.resolvePaymentAttempt(tx, {
          businessId,
          attemptId: attempt.id,
          status: 'SUCCEEDED',
        }),
      ),
    ).toBe('already_resolved');
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`DELETE FROM payment_attempts WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
  });

  it("an attempt cannot cite another tenant's intent", async () => {
    const ada = await intentFixture();
    const bola = await intentFixture();
    await expect(
      withBusiness(db, ada.businessId, (tx) =>
        paymentsHub.recordPaymentAttempt(tx, {
          businessId: ada.businessId,
          paymentIntentId: bola.intentId,
          paymentConnectionId: ada.connectionId,
          providerAttemptId: 'att_foreign',
        }),
      ),
    ).rejects.toThrow();
  });
});
