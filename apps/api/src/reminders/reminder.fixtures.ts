/**
 * Shared setup for the customer reminder suites split from reminder.integration.test.ts: one pool
 * over a real PostgreSQL, the in-memory email sender and WhatsApp stub, and the seeding helpers.
 * Each suite calls `useReminderHarness()` once at its top level; Vitest gives every test file its
 * own copy of this module.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import 'reflect-metadata';

import { encryptFacet } from '@rekoda/core/vault';
import { matchKeyFor } from '@rekoda/core/vault';

import {
  createDb,
  customersRepo,
  identity,
  issueRepo,
  sql,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { loadConfig, type ApiConfig } from '../config.js';
import { MockEmailSender, type EmailSender } from '../email/email.port.js';

import type { SendCustomerTextOutcome } from '../channels/waba-templates.service.js';
import { ReminderService, type ReminderWhatsApp } from './reminder.service.js';

const RUN_SALT = randomBytes(16).toString('hex');
export const testKey = (label: string): string =>
  createHash('sha256').update(`${label}:${process.pid}:${RUN_SALT}`).digest('hex');

export let urls: Urls;
export let appDb: Db;
export let closeApp: () => Promise<void>;
export let config: ApiConfig;
export let mail: MockEmailSender;
export let whatsappOutcome: SendCustomerTextOutcome;
export let whatsappCalls: Array<{ to: string; text: string }>;

export const whatsapp: ReminderWhatsApp = {
  async sendCustomerText(_businessId, input) {
    whatsappCalls.push(input);
    return whatsappOutcome;
  },
};

/** Registers this file's hooks: one pool, a migrated database, and a clean slate per test. */
export function useReminderHarness(): void {
  beforeAll(async () => {
    urls = requireUrls();
    await migrate(urls);
    ({ db: appDb, close: closeApp } = createDb(urls.app, { max: 8 }));
    process.env['DATABASE_URL'] = urls.app;
    process.env['OTP_PEPPER'] = testKey('pepper');
    process.env['REKODA_API_SECRET'] = testKey('secret');
    process.env['VAULT_KEY'] = testKey('vault');
    process.env['MATCH_KEY'] = testKey('match');
    config = {
      ...loadConfig(),
      webUrl: 'https://app.rekoda.test',
      customerReminders: true,
      /* Rekoda support is set on purpose: a reminder must never use it as its Reply-To (OWN-83). */
      supportEmail: 'support@rekoda.test',
    };
  });

  afterAll(async () => {
    await closeApp?.();
  });

  beforeEach(async () => {
    await truncateAll(urls);
    mail = new MockEmailSender();
    whatsappOutcome = { outcome: 'sent', unit: 'SERVICE_MESSAGE' };
    whatsappCalls = [];
  });
}

/** The WhatsApp outcome the next reminder send reports. */
export const setWhatsappOutcome = (outcome: SendCustomerTextOutcome): void => {
  whatsappOutcome = outcome;
};

export const service = (sender: EmailSender = mail) =>
  new ReminderService(config, appDb, sender, whatsapp);

let seq = 0;
export const key = () => `reminder-key-${(seq += 1)}-${randomBytes(4).toString('hex')}`;

export interface Seeded {
  businessId: string;
  userId: string;
  invoiceNumber: string;
  invoiceId: string;
  customerId: string;
}

export const EMAIL = 'ada@customer.example.ng';
/** The business's own email, the Reply-To of its reminder emails once verified (OWN-83). */
export const BUSINESS_EMAIL = 'accounts@adaeze.example.ng';

/**
 * Give a business its own email (OWN-83), sealed as the billing-email service seals it. `verified`
 * marks the mailbox proven, as a confirmed link would; without it the address is only on file.
 */
export async function setBusinessEmail(
  db: Db,
  vaultKey: string,
  businessId: string,
  address: string,
  verified: boolean,
): Promise<void> {
  await withBusiness(db, businessId, async (tx) => {
    await subscriptionsRepo.setBillingEmailSealed(
      tx,
      businessId,
      encryptFacet(address, vaultKey, `billing-email:${businessId}`),
      new Date(),
    );
    if (verified) {
      await tx.execute(
        sql`UPDATE businesses SET billing_email_verified_at = now() WHERE id = ${businessId}::uuid`,
      );
    }
  });
}

export async function seedWith(
  issueSale: typeof issueRepo.issueSale,
  opts: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    /** The business's own verified email (default `BUSINESS_EMAIL`); null leaves it with none. */
    businessEmail?: string | null;
  } = {},
) {
  seq += 1;
  const user = await identity.upsertUserByPhone(appDb, `+23481750${String(seq).padStart(4, '0')}`);
  const business = await identity.createBusinessWithOwner(appDb, {
    name: opts.name ?? 'Adaeze Fabrics',
    businessType: null,
    ownerUserId: user.id,
  });
  const businessId = business.id;
  const businessEmail = opts.businessEmail === undefined ? BUSINESS_EMAIL : opts.businessEmail;
  if (businessEmail)
    await setBusinessEmail(appDb, config.vaultKey, businessId, businessEmail, true);
  const identities: customersRepo.IdentityInput[] = [];
  const email = opts.email === undefined ? EMAIL : opts.email;
  const phone = opts.phone === undefined ? '+2348039998888' : opts.phone;
  if (email) {
    identities.push({
      facet: 'email',
      ciphertext: encryptFacet(email, config.vaultKey, `${businessId}:email`),
      matchKey: null,
    });
  }
  if (phone) {
    identities.push({
      facet: 'phone',
      ciphertext: encryptFacet(phone, config.vaultKey, `${businessId}:phone`),
      matchKey: matchKeyFor(businessId, 'phone', phone, config.matchKey),
    });
  }
  const customer = await customersRepo.createCustomerWithIdentities(
    appDb,
    businessId,
    'X81',
    identities,
  );
  // The sale is issued through a writer the TEST FILE passes in: financial
  // writers stay out of fixtures (check-boundaries exempts only *.test.ts).
  const sale = await withBusiness(appDb, businessId, (tx) =>
    issueSale(tx, {
      businessId,
      customerId: customer.id,
      customerToken: 'CUSTOMER_X81',
      items: [{ name: 'gown', quantity: 1, unitPriceK: 8_000_000 }],
      subtotalK: 8_000_000,
      discountK: 0,
      deliveryFeeK: 0,
      vatK: 0,
      totalK: 8_000_000,
      paidK: 0,
      balanceDueK: 8_000_000,
      method: 'transfer',
      sourceType: 'chat',
      sourceId: `draft-${seq}`,
      actor: 'system',
    }),
  );
  return {
    businessId,
    userId: user.id,
    invoiceNumber: sale.invoiceNumber,
    invoiceId: sale.invoiceId,
    customerId: customer.id,
  } satisfies Seeded;
}

export const approvePhone = (s: Seeded) => service().setPublicContact(s.businessId, '08031112222');

export const rows = async <T extends Record<string, unknown>>(
  businessId: string,
  q: ReturnType<typeof sql>,
) => withBusiness(appDb, businessId, async (tx) => [...(await tx.execute<T>(q))]);

export const books = async (businessId: string) => {
  const [r] = await rows<{ invoices: string; ledger: string; payments: string }>(
    businessId,
    sql`SELECT (SELECT count(*) FROM invoices)::text AS invoices,
               (SELECT count(*) FROM ledger_transactions)::text AS ledger,
               (SELECT count(*) FROM payments)::text AS payments`,
  );
  return r;
};

/** One channel of one event, with the same per-channel key the dual-channel door derives. */
export const sendVia = async (
  s: Seeded,
  channel: 'email' | 'whatsapp',
  extra: { attest?: boolean; idempotencyKey?: string; sender?: EmailSender } = {},
) => {
  const out = await service(extra.sender).send(s.businessId, s.userId, {
    invoiceNumber: s.invoiceNumber,
    channels: [channel],
    idempotencyKey: extra.idempotencyKey ?? key(),
    ...(extra.attest === undefined ? {} : { attest: extra.attest }),
  });
  return out.results[0]!;
};
export const sendEmail = (s: Seeded, extra: { attest?: boolean; idempotencyKey?: string } = {}) =>
  sendVia(s, 'email', extra);
