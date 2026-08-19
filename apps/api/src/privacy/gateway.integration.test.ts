/**
 * The privacy gateway, wired (MASTER-PLAN §5.3.2, ADR 0005).
 *
 * `@rekoda/core` proves the crypto and the detection as pure functions. What
 * needs a real database is everything this file is about: that one person is
 * one customer across messages and across a race, that the plaintext is only
 * ever in the vault, and that two merchants cannot be shown to share a
 * customer by anyone holding a dump.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, identity, schema, withBusiness, type Db } from '@rekoda/db';
import { migrate, requireUrls, truncateAll, type Urls } from '@rekoda/db/testing';
import { decryptFacet } from '@rekoda/core/vault';
import { PrivacyGateway } from './gateway.service.js';
import { loadConfig, type ApiConfig } from '../config.js';

let urls: Urls;
let db: Db;
let close: () => Promise<void>;
let config: ApiConfig;
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
  config = loadConfig();
  gateway = new PrivacyGateway(db, config);
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

describe('what leaves, and what does not', () => {
  it('replaces a phone number with a customer token', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text, tokens } = await gateway.tokenise(
      businessId,
      'Ada 08031234567 bought 3 wigs for 150k',
    );

    expect(text).not.toContain('08031234567');
    expect(text).toMatch(/CUSTOMER_[0-9A-Z]{3}/);
    // The amount survives. Tokenising "150k" would protect nobody and destroy
    // the only thing a model is there to read.
    expect(text).toContain('150k');
    expect([...tokens.values()]).toContain('08031234567');
  });

  it('replaces an email too', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text } = await gateway.tokenise(businessId, 'send the receipt to ada@example.com');
    expect(text).not.toContain('ada@example.com');
    expect(text).toMatch(/CUSTOMER_[0-9A-Z]{3}/);
  });

  it('collapses the same number mentioned twice into ONE token', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text } = await gateway.tokenise(
      businessId,
      'call 08031234567 then send the receipt to 08031234567',
    );
    const found = [...text.matchAll(/CUSTOMER_[0-9A-Z]{3}/g)].map((m) => m[0]);
    expect(found).toHaveLength(2);
    // Same person, same token: information the model legitimately needs and
    // which reveals nothing.
    expect(new Set(found).size).toBe(1);
  });

  it('does NOT store an account number anywhere', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const { text } = await gateway.tokenise(businessId, 'transfer to account 0123456789');

    expect(text).not.toContain('0123456789');
    expect(text).toContain('ACCOUNT_1');

    // No customer, no identity row, nothing in the vault. The cheapest way to
    // protect a bank account number is not to hold it.
    const rows = await withBusiness(db, businessId, (tx) =>
      tx.select().from(schema.customerIdentities),
    );
    expect(rows).toHaveLength(0);
  });
});

describe('one person is one customer', () => {
  it('gives the same token to the same number in a later message', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    const first = await gateway.tokenise(businessId, 'Ada 08031234567 bought wigs');
    const second = await gateway.tokenise(businessId, 'payment from 0803 123 4567');

    const tokenOf = (t: string) => t.match(/CUSTOMER_[0-9A-Z]{3}/)![0];
    // Written differently, normalised identically — this is what makes a
    // returning customer a returning customer rather than a new one.
    expect(tokenOf(second.text)).toBe(tokenOf(first.text));
  });

  it('survives eight messages from the same NEW number arriving at once', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');

    // The race `identities_match_ux` exists for. Read-then-write, every one of
    // these finds nothing and creates a customer: one person becomes eight,
    // with eight tokens and a debtor balance split eight ways.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => gateway.tokenise(businessId, 'from 08031234567')),
    );

    const tokens = new Set(results.map((r) => r.text.match(/CUSTOMER_[0-9A-Z]{3}/)![0]));
    expect(tokens.size).toBe(1);

    const rows = await withBusiness(db, businessId, (tx) => tx.select().from(schema.customers));
    expect(rows).toHaveLength(1);
  });
});

describe('the vault is the only plaintext', () => {
  it('stores the number encrypted, and it decrypts back', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await gateway.tokenise(businessId, 'from 08031234567');

    const [row] = await withBusiness(db, businessId, (tx) =>
      tx.select().from(schema.customerIdentities),
    );

    expect(row!.ciphertext).not.toContain('08031234567');
    expect(row!.ciphertext.startsWith('v1.')).toBe(true);
    expect(decryptFacet(row!.ciphertext, config.vaultKey)).toBe('08031234567');
  });

  it('stores a match key that is NOT a bare hash of the number', async () => {
    const businessId = await seedBusiness('Ada Fashion', '+2348060000001');
    await gateway.tokenise(businessId, 'from 08031234567');

    const [row] = await withBusiness(db, businessId, (tx) =>
      tx.select().from(schema.customerIdentities),
    );

    // A phone number has ~10^10 possibilities, so sha256(phone) is reversible
    // by exhaustive search in seconds. The stored key is an HMAC under a
    // secret held nowhere near the data.
    const bareHash = createHash('sha256').update('8031234567').digest('base64url');
    expect(row!.matchKey).not.toBe(bareHash);
    expect(row!.matchKey).toBeTruthy();
  });

  it('gives two businesses DIFFERENT keys for the same customer', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348060000001');
    const bola = await seedBusiness('Bola Electronics', '+2348060000002');

    await gateway.tokenise(ada, 'from 08031234567');
    await gateway.tokenise(bola, 'from 08031234567');

    const [adaRow] = await withBusiness(db, ada, (tx) =>
      tx.select().from(schema.customerIdentities),
    );
    const [bolaRow] = await withBusiness(db, bola, (tx) =>
      tx.select().from(schema.customerIdentities),
    );

    // Without businessId mixed into the HMAC, these would match — and a dump
    // would reveal which merchants share a customer. Nobody consented to that
    // and preventing it costs nothing.
    expect(adaRow!.matchKey).not.toBe(bolaRow!.matchKey);
  });

  it('keeps one business from resolving another business`s token', async () => {
    const ada = await seedBusiness('Ada Fashion', '+2348060000001');
    const bola = await seedBusiness('Bola Electronics', '+2348060000002');
    await gateway.tokenise(ada, 'from 08031234567');

    const rows = await withBusiness(db, bola, (tx) => tx.select().from(schema.customers));
    expect(rows).toHaveLength(0);
  });
});
