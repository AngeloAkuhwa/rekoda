/**
 * Object-level authorisation (IDOR) over the business-facing endpoint families that take an id:
 * webhooks, API keys and applications, members, the public merchant API (harness:
 * `ops-idor-harness.ts`). Two businesses throughout. Every refusal is checked against a snapshot
 * of what the request could have touched: the target's own rows must be byte-for-byte unchanged,
 * and nothing may be written in either business.
 */
import { describe, expect, it } from 'vitest';
import { billingRepo, sql } from '@rekoda/db';
import { grantCapacityAddOn } from '@rekoda/db/testing';
import { appDb, business, call, ownerDb, signIn, urls, useHarness } from './ops-idor-harness.js';

useHarness();

const q = async (text: ReturnType<typeof sql>) => [...(await ownerDb.execute(text))];
const unknownUuid = '00000000-0000-4000-8000-000000000bad';

/** Business with a complete plan and API capacity, so every owner route is open to it. */
async function shop() {
  const b = await business();
  await billingRepo.setPlan(appDb, {
    businessId: b.id,
    plan: 'complete',
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    actor: 'operator:idor-suite',
  });
  await grantCapacityAddOn(urls, b.id, 'API_APPLICATIONS', 5);
  return b;
}

const rowsOf = (table: string) => q(sql.raw(`SELECT * FROM ${table} ORDER BY 1`));

describe('webhook endpoints: id from the URL, business from the session', () => {
  it('B cannot rotate, disable or enable A’s endpoint; A’s secret and status do not move', async () => {
    const a = await shop();
    const b = await shop();
    const made = await call('POST', '/v1/webhooks', a.session, { url: 'https://example.test/a' });
    expect(made.statusCode).toBe(200);
    const id = (made.json() as { id: string }).id;
    const before = await rowsOf('webhook_endpoints');

    for (const action of ['rotate', 'disable', 'enable']) {
      const foreign = await call('POST', `/v1/webhooks/${id}/${action}`, b.session);
      const missing = await call('POST', `/v1/webhooks/${unknownUuid}/${action}`, b.session);
      const malformed = await call('POST', `/v1/webhooks/not-a-uuid/${action}`, b.session);
      expect([foreign.statusCode, missing.statusCode, malformed.statusCode], action).toEqual([
        404, 404, 404,
      ]);
      expect(foreign.body, action).toBe(missing.body);
    }
    expect(await rowsOf('webhook_endpoints')).toEqual(before);
    const listed = (await call('GET', '/v1/webhooks', b.session)).json() as {
      endpoints?: unknown[];
    };
    expect(JSON.stringify(listed)).not.toContain(id);
  });
});

describe('API applications and keys: the parent is checked before anything is minted', () => {
  it('B cannot mint under, disable, enable or revoke anything of A’s; A’s key still stands', async () => {
    const a = await shop();
    const b = await shop();
    const app = (
      await call('POST', '/v1/api-keys/applications', a.session, { name: 'A integration' })
    ).json() as { id: string };
    const minted = (
      await call('POST', `/v1/api-keys/applications/${app.id}/keys`, a.session, {})
    ).json() as { key: { id: string }; token: string };
    const key = minted.key;
    const liveKeys = () => q(sql`SELECT id FROM api_keys WHERE revoked_at IS NULL`);
    expect(key.id).toBeTruthy();
    const before = {
      apps: await rowsOf('api_applications'),
      keys: await rowsOf('api_keys'),
    };

    const attempts: Array<[string, object?]> = [
      [`/v1/api-keys/applications/${app.id}/keys`, {}],
      [`/v1/api-keys/applications/${app.id}/disable`],
      [`/v1/api-keys/applications/${app.id}/enable`],
      [`/v1/api-keys/keys/${key.id}/revoke`],
    ];
    for (const [url, body] of attempts) {
      const foreign = await call('POST', url, b.session, body);
      expect(foreign.statusCode, url).toBe(404);
      const missing = await call(
        'POST',
        url.replace(app.id, unknownUuid).replace(key.id, unknownUuid),
        b.session,
        body,
      );
      expect(missing.statusCode, url).toBe(404);
      expect(missing.body, url).toBe(foreign.body);
      const malformed = await call(
        'POST',
        url.replace(app.id, 'not-a-uuid').replace(key.id, 'not-a-uuid'),
        b.session,
        body,
      );
      expect(malformed.statusCode, url).toBe(404);
    }
    // A's key is still live (not revoked) and its application still active.
    expect(await liveKeys()).toHaveLength(1);
    expect({ apps: await rowsOf('api_applications'), keys: await rowsOf('api_keys') }).toEqual(
      before,
    );
    const listed = JSON.stringify((await call('GET', '/v1/api-keys', b.session)).json());
    expect(listed).not.toContain(app.id);
    expect(listed).not.toContain(key.id);
  });

  it('a business cannot be named in a body to move a mint to another business', async () => {
    const a = await shop();
    const b = await shop();
    const appB = (
      await call('POST', '/v1/api-keys/applications', b.session, { name: 'B integration' })
    ).json() as { id: string };
    const r = await call('POST', `/v1/api-keys/applications/${appB.id}/keys`, a.session, {
      businessId: b.id,
      applicationId: appB.id,
    });
    expect(r.statusCode).toBe(404);
    expect(await q(sql`SELECT 1 FROM api_keys`)).toEqual([]);
  });
});

describe('members: the user id is only ever looked up inside the caller’s own business', () => {
  async function team() {
    const owner = await shop();
    const phone = `+2348150${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`;
    await call('POST', '/v1/businesses/members', owner.session, { phone, role: 'accountant' });
    const member = (
      await q(
        sql`SELECT user_id FROM memberships WHERE business_id = ${owner.id}::uuid AND role = 'accountant'`,
      )
    )[0] as { user_id: string };
    return { owner, memberId: member.user_id, memberSession: await signIn(phone) };
  }

  it('B’s owner cannot remove or re-role A’s member; nothing changes and nothing is audited', async () => {
    const a = await team();
    const b = await shop();
    const before = {
      memberships: await rowsOf('memberships'),
      audit: await q(sql`SELECT action, business_id FROM audit_events ORDER BY created_at, id`),
    };

    const removed = await call('DELETE', `/v1/businesses/members/${a.memberId}`, b.session);
    const changed = await call('PATCH', `/v1/businesses/members/${a.memberId}`, b.session, {
      role: 'delegate',
    });
    const removedMissing = await call('DELETE', `/v1/businesses/members/${unknownUuid}`, b.session);
    const changedMalformed = await call('PATCH', '/v1/businesses/members/not-a-uuid', b.session, {
      role: 'delegate',
    });
    expect(removed.json()).toEqual({ removed: false });
    expect(removed.body).toBe(removedMissing.body);
    expect(changed.json()).toEqual({ changed: false });
    expect(changedMalformed.json()).toEqual({ changed: false });
    expect({
      memberships: await rowsOf('memberships'),
      audit: await q(sql`SELECT action, business_id FROM audit_events ORDER BY created_at, id`),
    }).toEqual(before);
  });

  it('a member (not owner) cannot manage members at all, in their own business or another', async () => {
    const a = await team();
    const b = await shop();
    const before = await rowsOf('memberships');
    for (const target of [a.memberId, unknownUuid]) {
      expect(
        (await call('DELETE', `/v1/businesses/members/${target}`, a.memberSession)).statusCode,
      ).toBe(403);
      expect(
        (
          await call('PATCH', `/v1/businesses/members/${target}`, a.memberSession, {
            role: 'delegate',
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(await rowsOf('memberships')).toEqual(before);
    expect(b.id).not.toBe(a.owner.id);
  });
});
