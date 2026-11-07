/**
 * The Reply-To of a customer reminder email (OD-42(b), option B): Rekoda support, from
 * REKODA_SUPPORT_EMAIL, whatever the merchant has on file. Split from reminder.integration.test.ts.
 */
import { issueRepo } from '@rekoda/db';
import { describe, expect, it } from 'vitest';
import { encryptFacet } from '@rekoda/core/vault';
import { sql, subscriptionsRepo, withBusiness } from '@rekoda/db';
import { ReminderService } from './reminder.service.js';
import {
  appDb,
  approvePhone,
  config,
  key,
  mail,
  rows,
  seedWith,
  sendEmail,
  useReminderHarness,
  whatsapp,
  type Seeded,
} from './reminder.fixtures.js';

const seed = (opts?: Parameters<typeof seedWith>[1]) => seedWith(issueRepo.issueSale, opts);

useReminderHarness();

describe('the email reply-to (OD-42(b): Rekoda support)', () => {
  const setBillingEmail = async (s: Seeded, address: string, verified: boolean) => {
    await withBusiness(appDb, s.businessId, (tx) =>
      subscriptionsRepo.setBillingEmailSealed(
        tx,
        s.businessId,
        encryptFacet(address, config.vaultKey, `billing-email:${s.businessId}`),
        new Date(),
      ),
    );
    if (verified) {
      await rows(s.businessId, sql`UPDATE businesses SET billing_email_verified_at = now()`);
    }
  };

  it("sends replies to REKODA_SUPPORT_EMAIL, never to the merchant's billing email", async () => {
    const s = await seed();
    await approvePhone(s);
    await setBillingEmail(s, 'owner@adaeze.example.ng', true);
    expect((await sendEmail(s, { attest: true })).reminder.status).toBe('sent');
    expect(mail.outbox[0]!.replyTo).toBe('support@rekoda.test');
    // Still sent from Rekoda's own address under the merchant's display name: From is unchanged.
    expect(mail.outbox[0]!.fromName).toBe('Adaeze Fabrics via Rekoda');
    expect(JSON.stringify(mail.outbox[0])).not.toContain('owner@adaeze.example.ng');
  });

  it('uses the support address whether or not the merchant has a billing email', async () => {
    const s = await seed();
    await approvePhone(s);
    await sendEmail(s, { attest: true });
    expect(mail.outbox[0]!.replyTo).toBe('support@rekoda.test');

    await setBillingEmail(s, 'unproven@adaeze.example.ng', false);
    await sendEmail(s);
    expect(mail.outbox).toHaveLength(2);
    expect(mail.outbox[1]!.replyTo).toBe('support@rekoda.test');
  });

  it('leaves the header out rather than inventing one when no support address is configured', async () => {
    const s = await seed();
    await approvePhone(s);
    const bare = new ReminderService({ ...config, supportEmail: null }, appDb, mail, whatsapp);
    const out = await bare.send(s.businessId, s.userId, {
      invoiceNumber: s.invoiceNumber,
      channels: ['email'],
      idempotencyKey: key(),
      attest: true,
    });
    expect(out.results[0]!.reminder.status).toBe('sent');
    expect(mail.outbox[0]!).not.toHaveProperty('replyTo');
  });
});
