/**
 * The business email, given on WhatsApp (OWN-83): "my email is X" from the owner starts the same
 * mailed, single-use confirmation link the billing page sends. Typing the address never verifies
 * it; only opening the link under the owner's session does. The address never reaches the model
 * or the conversation history. Made-up, expired, reused and cross-business links are covered on
 * the service itself in billing/billing-email-verification.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { billingRepo, identity, sql, subscriptionsRepo, withBusiness } from '@rekoda/db';
import { buildRunner } from '../jobs/jobs.module.js';
import { MockEmailSender } from '../email/email.port.js';
import { BillingEmailService } from '../billing/billing-email.service.js';
import {
  db,
  deps,
  messagePayload,
  post,
  stubSender,
  stubTransport,
  useMetaWebhookHarness,
  workerDb,
} from './meta-webhook.fixtures.js';

useMetaWebhookHarness();

const OWNER = '2348031234567';
const ADDRESS = 'accounts@adaeze.example.ng';

async function seedOwner(name = 'Adaeze Fabrics') {
  const user = await identity.upsertUserByPhone(db, `+${OWNER}`);
  const business = await identity.createBusinessWithOwner(db, {
    name,
    businessType: null,
    ownerUserId: user.id,
  });
  await billingRepo.setPlan(db, {
    businessId: business.id,
    plan: 'complete',
    expiresAt: null,
    actor: 'test',
  });
  return business.id;
}

const say = async (mail: MockEmailSender, from: string, wamid: string, text: string) => {
  expect((await post(messagePayload(from, wamid, text))).statusCode).toBe(200);
  expect(await buildRunner(workerDb, db, { ...deps, email: mail }).runOnce()).toBe(true);
};

const state = (businessId: string) =>
  withBusiness(db, businessId, (tx) => subscriptionsRepo.billingEmailState(tx, businessId));

/** The token from the mailed link's fragment, as the confirm page reads it. */
const tokenIn = (mail: MockEmailSender): string =>
  /#token=([A-Za-z0-9_-]+)/.exec(mail.outbox[0]!.text)![1]!;

describe('"my email is X" on WhatsApp (OWN-83)', () => {
  it('mails a confirmation link to the address and does not mark it verified', async () => {
    const businessId = await seedOwner();
    const mail = new MockEmailSender();
    await say(mail, OWNER, 'wamid.BE1', `my email is ${ADDRESS}`);

    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]!.to).toBe(ADDRESS);
    expect(mail.outbox[0]!.subject).toBe('Confirm your Rekoda billing email');
    expect(stubSender.lastText).toContain('We sent a confirmation link to');
    expect(stubSender.lastText).toContain('reminders go by WhatsApp only');
    // Masked in the reply, never whole.
    expect(stubSender.lastText).not.toContain(ADDRESS);

    const s = await state(businessId);
    expect(s.sealed).not.toBeNull();
    expect(s.verifiedAt).toBeNull();
  });

  it('keeps the address away from the model and out of the conversation history', async () => {
    const businessId = await seedOwner();
    await say(new MockEmailSender(), OWNER, 'wamid.BE2', `My business email is ${ADDRESS}`);
    expect(stubTransport.requests).toHaveLength(0);
    const bodies = await withBusiness(db, businessId, async (tx) => [
      ...(await tx.execute<{ body: string }>(sql`SELECT body FROM conversation_messages`)),
    ]);
    expect(bodies.map((b) => b.body)).toContain('[business_email]');
    // Neither the inbound row nor the stored reply holds the whole address; the reply is masked.
    expect(JSON.stringify(bodies)).not.toContain(ADDRESS);
    expect(JSON.stringify(bodies)).not.toContain('accounts@');
  });

  it('is verified only when the mailed link is opened, and then says so', async () => {
    const businessId = await seedOwner();
    const mail = new MockEmailSender();
    await say(mail, OWNER, 'wamid.BE3', `my email is ${ADDRESS}`);
    const emails = new BillingEmailService(deps.config, db, mail);

    // A wrong token proves nothing.
    expect(await emails.confirm(businessId, 'x'.repeat(43))).toEqual({ state: 'invalid' });
    expect((await state(businessId)).verifiedAt).toBeNull();

    expect(await emails.confirm(businessId, tokenIn(mail))).toEqual({ state: 'verified' });
    expect((await state(businessId)).verifiedAt).not.toBeNull();
    // The same link a second time does nothing more.
    expect(await emails.confirm(businessId, tokenIn(mail))).toEqual({ state: 'invalid' });

    // Asking again on WhatsApp is told there is nothing to do; no second link.
    await say(mail, OWNER, 'wamid.BE4', `my email is ${ADDRESS}`);
    expect(stubSender.lastText).toContain('is already confirmed as your business email');
    expect(mail.outbox).toHaveLength(1);
  });

  it('a new address replaces a confirmed one and needs confirming itself', async () => {
    const businessId = await seedOwner();
    const mail = new MockEmailSender();
    await say(mail, OWNER, 'wamid.BE5', `my email is ${ADDRESS}`);
    await new BillingEmailService(deps.config, db, mail).confirm(businessId, tokenIn(mail));
    expect((await state(businessId)).verifiedAt).not.toBeNull();

    // The cooldown is per business: age the first link so a second may be asked for.
    await withBusiness(db, businessId, (tx) =>
      tx.execute(
        sql`UPDATE billing_email_verifications SET created_at = now() - interval '2 minutes'`,
      ),
    );
    await say(mail, OWNER, 'wamid.BE6', 'business email: new@adaeze.example.ng');
    expect((await state(businessId)).verifiedAt).toBeNull();
    expect(mail.outbox.at(-1)!.to).toBe('new@adaeze.example.ng');
  });

  it('refuses an address that is not usable, and sends nothing', async () => {
    const businessId = await seedOwner();
    const mail = new MockEmailSender();
    await say(mail, OWNER, 'wamid.BE7', 'my email is ada@localhost');
    expect(stubSender.lastText).toContain('does not look like an email address');
    expect(mail.attempts).toBe(0);
    expect((await state(businessId)).sealed).toBeNull();
  });

  it('only the owner may set it: a member is refused and nothing is saved or mailed', async () => {
    const businessId = await seedOwner();
    const member = await identity.upsertUserByPhone(db, '+2348039990001');
    await identity.addMembership(db, businessId, member.id, 'delegate');
    const mail = new MockEmailSender();
    await say(mail, '2348039990001', 'wamid.BE8', 'my email is helper@elsewhere.example.ng');
    expect(stubSender.lastText).toContain('Only the business owner can set the business email');
    expect(mail.attempts).toBe(0);
    expect((await state(businessId)).sealed).toBeNull();
  });

  it('says honestly that nothing was changed when no email sender is configured', async () => {
    const businessId = await seedOwner();
    expect(
      (await post(messagePayload(OWNER, 'wamid.BE9', `my email is ${ADDRESS}`))).statusCode,
    ).toBe(200);
    // No `email` dep: the runner falls back to the honest "none" sender.
    expect(await buildRunner(workerDb, db, deps).runOnce()).toBe(true);
    expect(stubSender.lastText).toContain('We cannot send a confirmation email right now');
    expect((await state(businessId)).sealed).toBeNull();
  });

  it("one business's email never lands on another business", async () => {
    const a = await seedOwner('Adaeze Fabrics');
    const otherOwner = await identity.upsertUserByPhone(db, '+2348035550000');
    const b = await identity.createBusinessWithOwner(db, {
      name: 'Bisi Shoes',
      businessType: null,
      ownerUserId: otherOwner.id,
    });
    await say(new MockEmailSender(), OWNER, 'wamid.BE10', `my email is ${ADDRESS}`);
    expect((await state(a)).sealed).not.toBeNull();
    expect((await state(b.id)).sealed).toBeNull();
  });
});
