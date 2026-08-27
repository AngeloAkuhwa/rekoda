/**
 * The WABA connection model (spec §24; PR-058): one number routes to one
 * business and an unknown number is refused, never guessed; templates
 * carry the §4.2 category their sends will meter to; the 24-hour service
 * window opens on a customer message and closes by its own clock; and the
 * customer's identity is a hash, never a raw number.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, sql, wabaRepo, withBusiness, type Db } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let db: Db;
let workerDb: Db;
let close: () => Promise<void>;
let closeWorker: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db, close } = createDb(urls.app, { max: 8 }));
  ({ db: workerDb, close: closeWorker } = createDb(urls.worker, { max: 2 }));
});

afterAll(async () => {
  await close?.();
  await closeWorker?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

let seq = 0;
async function seedBusiness(): Promise<string> {
  seq += 1;
  const user = await identity.upsertUserByPhone(db, `+23481880${String(seq).padStart(5, '0')}`);
  const business = await identity.createBusinessWithOwner(db, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

const signup = (businessId: string, phoneNumberId: string) =>
  withBusiness(db, businessId, (tx) =>
    wabaRepo.connectWaba(tx, {
      businessId,
      wabaId: `waba-${seq}`,
      phoneNumberId,
      displayPhone: '+234 801 000 0000',
      accessTokenCipher: 'v1.vault.blob',
      tokenTail: '9f3a',
    }),
  );

describe('phoneNumberId → BusinessId routing (§24)', () => {
  it('one number, one business: a completed signup routes, a rival is refused', async () => {
    const ada = await seedBusiness();
    const bola = await seedBusiness();

    const connected = await signup(ada, 'pn-100');
    expect(connected.outcome).toBe('connected');

    /* The same business re-completing signup refreshes, same row. */
    const again = await signup(ada, 'pn-100');
    expect(again).toEqual(connected);

    /* Another business claiming the same number is refused. */
    expect(await signup(bola, 'pn-100')).toEqual({ outcome: 'number_taken' });

    /* The routing answer, pre-tenant, through the worker. */
    const route = await wabaRepo.routeByPhoneNumberId(workerDb, 'pn-100');
    expect(route).toMatchObject({ businessId: ada, status: 'CONNECTED' });
  });

  it('an unknown phoneNumberId is refused, never guessed', async () => {
    await seedBusiness();
    expect(await wabaRepo.routeByPhoneNumberId(workerDb, 'pn-nobody')).toBeNull();
  });

  it('a revoked connection stays on file, revoked', async () => {
    const businessId = await seedBusiness();
    const connected = await signup(businessId, 'pn-200');
    if (connected.outcome !== 'connected') throw new Error('fixture');
    await withBusiness(db, businessId, (tx) =>
      wabaRepo.markWabaStatus(tx, { businessId, connectionId: connected.id, status: 'REVOKED' }),
    );
    const row = await withBusiness(db, businessId, (tx) =>
      wabaRepo.wabaConnectionFor(tx, businessId),
    );
    expect(row!.status).toBe('REVOKED');
    expect(row!.revokedAt).not.toBeNull();
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`DELETE FROM waba_connections WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
  });

  it('billing mode starts UNCONFIRMED, and W0 confirms it as an AUDITED data change', async () => {
    const businessId = await seedBusiness();
    const connected = await signup(businessId, 'pn-300');
    if (connected.outcome !== 'connected') throw new Error('fixture');
    const before = await withBusiness(db, businessId, (tx) =>
      wabaRepo.wabaConnectionFor(tx, businessId),
    );
    expect(before!.billingMode).toBe('UNCONFIRMED');
    expect(before!.billingModeConfirmedAt).toBeNull();

    /* A bare UPDATE — the mode without its audit — is unrepresentable
     * since 0089: a data change that alters unit economics is an act with
     * an actor, not a value someone once poked. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE waba_connections SET billing_mode = 'MERCHANT_DIRECT'
                       WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();

    /* W0's actual shape: mode, moment and actor land together. */
    await withBusiness(db, businessId, (tx) =>
      wabaRepo.confirmBillingMode(tx, {
        businessId,
        connectionId: connected.id,
        mode: 'MERCHANT_DIRECT',
        actor: 'owner:angelo',
      }),
    );
    const after = await withBusiness(db, businessId, (tx) =>
      wabaRepo.wabaConnectionFor(tx, businessId),
    );
    expect(after!.billingMode).toBe('MERCHANT_DIRECT');
    expect(after!.billingModeConfirmedAt).not.toBeNull();
    expect(after!.billingModeConfirmedBy).toBe('owner:angelo');

    /* An invented mode is still refused by 0084's value CHECK. */
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`UPDATE waba_connections
                       SET billing_mode = 'VIBES', billing_mode_confirmed_by = 'owner:x'
                       WHERE business_id = ${businessId}::uuid`),
      ),
    ).rejects.toThrow();
  });

  it('the sends are the health check: failure records WHY, success recovers, REVOKED stays dead', async () => {
    const businessId = await seedBusiness();
    const connected = await signup(businessId, 'pn-350');
    if (connected.outcome !== 'connected') throw new Error('fixture');

    await withBusiness(db, businessId, (tx) =>
      wabaRepo.markWabaUnhealthy(tx, {
        businessId,
        connectionId: connected.id,
        reason: 'meta /pn-350/messages failed with 401',
      }),
    );
    let row = await withBusiness(db, businessId, (tx) =>
      wabaRepo.wabaConnectionFor(tx, businessId),
    );
    expect(row!.status).toBe('UNHEALTHY');
    expect(row!.healthReason).toBe('meta /pn-350/messages failed with 401');

    await withBusiness(db, businessId, (tx) =>
      wabaRepo.markWabaHealthy(tx, { businessId, connectionId: connected.id }),
    );
    row = await withBusiness(db, businessId, (tx) => wabaRepo.wabaConnectionFor(tx, businessId));
    expect(row!.status).toBe('CONNECTED');
    expect(row!.healthReason).toBeNull();
    expect(row!.lastHealthyAt).not.toBeNull();

    /* Revocation ends by a NEW signup, never by a send outcome. */
    await withBusiness(db, businessId, (tx) =>
      wabaRepo.markWabaStatus(tx, { businessId, connectionId: connected.id, status: 'REVOKED' }),
    );
    expect(
      await withBusiness(db, businessId, (tx) =>
        wabaRepo.markWabaHealthy(tx, { businessId, connectionId: connected.id }),
      ),
    ).toBe(false);
    row = await withBusiness(db, businessId, (tx) => wabaRepo.wabaConnectionFor(tx, businessId));
    expect(row!.status).toBe('REVOKED');
  });
});

describe('templates and the service window (§24, §4.2)', () => {
  it('a template carries its metering category; the same name re-registers in place', async () => {
    const businessId = await seedBusiness();
    const connected = await signup(businessId, 'pn-400');
    if (connected.outcome !== 'connected') throw new Error('fixture');

    const first = await withBusiness(db, businessId, (tx) =>
      wabaRepo.upsertTemplate(tx, {
        businessId,
        wabaConnectionId: connected.id,
        name: 'order_update',
        category: 'UTILITY',
      }),
    );
    const again = await withBusiness(db, businessId, (tx) =>
      wabaRepo.upsertTemplate(tx, {
        businessId,
        wabaConnectionId: connected.id,
        name: 'order_update',
        category: 'MARKETING',
        providerTemplateId: 'tmpl-99',
      }),
    );
    expect(again.id).toBe(first.id);

    await withBusiness(db, businessId, (tx) =>
      wabaRepo.markTemplateStatus(tx, { businessId, templateId: first.id, status: 'APPROVED' }),
    );
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.execute<{ category: string; status: string }>(
        sql`SELECT category, status FROM waba_templates WHERE business_id = ${businessId}::uuid`,
      ),
    );
    expect([...rows]).toEqual([{ category: 'MARKETING', status: 'APPROVED' }]);
  });

  it('a template is never SERVICE: a service message is the absence of a template (0088)', async () => {
    const businessId = await seedBusiness();
    const connected = await signup(businessId, 'pn-450');
    if (connected.outcome !== 'connected') throw new Error('fixture');
    await expect(
      withBusiness(db, businessId, (tx) =>
        tx.execute(sql`
          INSERT INTO waba_templates (business_id, waba_connection_id, name, category)
          VALUES (${businessId}::uuid, ${connected.id}::uuid, 'free_form', 'SERVICE')
        `),
      ),
    ).rejects.toThrow();
  });

  it("a rejection carries Meta's reason; approval clears it (PR-060)", async () => {
    const businessId = await seedBusiness();
    const connected = await signup(businessId, 'pn-460');
    if (connected.outcome !== 'connected') throw new Error('fixture');
    const template = await withBusiness(db, businessId, (tx) =>
      wabaRepo.upsertTemplate(tx, {
        businessId,
        wabaConnectionId: connected.id,
        name: 'payment_reminder',
        category: 'UTILITY',
      }),
    );

    await withBusiness(db, businessId, (tx) =>
      wabaRepo.markTemplateStatus(tx, {
        businessId,
        templateId: template.id,
        status: 'REJECTED',
        rejectionReason: 'add a clear opt-out line',
      }),
    );
    let rows = await withBusiness(db, businessId, (tx) => wabaRepo.templatesFor(tx, businessId));
    expect(rows[0]).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'add a clear opt-out line',
    });

    /* Rejected is not sendable: the registry answers null before a unit
     * could be spent on a send Meta would bounce. */
    expect(
      await withBusiness(db, businessId, (tx) =>
        wabaRepo.approvedTemplate(tx, {
          businessId,
          wabaConnectionId: connected.id,
          name: 'payment_reminder',
        }),
      ),
    ).toBeNull();

    await withBusiness(db, businessId, (tx) =>
      wabaRepo.markTemplateStatus(tx, { businessId, templateId: template.id, status: 'APPROVED' }),
    );
    rows = await withBusiness(db, businessId, (tx) => wabaRepo.templatesFor(tx, businessId));
    expect(rows[0]).toMatchObject({ status: 'APPROVED', rejectionReason: null });
    const sendable = await withBusiness(db, businessId, (tx) =>
      wabaRepo.approvedTemplate(tx, {
        businessId,
        wabaConnectionId: connected.id,
        name: 'payment_reminder',
      }),
    );
    expect(sendable).toMatchObject({ name: 'payment_reminder', category: 'UTILITY' });
  });

  it('the 24-hour window opens on a customer message and closes by its own clock', async () => {
    const businessId = await seedBusiness();
    const connected = await signup(businessId, 'pn-500');
    if (connected.outcome !== 'connected') throw new Error('fixture');
    const customer = { businessId, wabaConnectionId: connected.id, customerHash: 'h:ada' };

    expect(
      await withBusiness(db, businessId, (tx) => wabaRepo.serviceWindowOpen(tx, customer)),
    ).toBe(false);
    const inbound = new Date('2026-08-27T10:00:00Z');
    await withBusiness(db, businessId, (tx) =>
      wabaRepo.touchServiceWindow(tx, { ...customer, at: inbound }),
    );
    expect(
      await withBusiness(db, businessId, (tx) =>
        wabaRepo.serviceWindowOpen(tx, { ...customer, at: new Date('2026-08-28T09:59:00Z') }),
      ),
    ).toBe(true);
    expect(
      await withBusiness(db, businessId, (tx) =>
        wabaRepo.serviceWindowOpen(tx, { ...customer, at: new Date('2026-08-28T10:01:00Z') }),
      ),
    ).toBe(false);
  });
});
