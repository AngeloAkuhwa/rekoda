/**
 * OD-51.6 (migration 0215), at process start: an API or worker whose `REKODA_PLAN_CATALOGUE_READS`
 * differs from the pricing source in force refuses to boot, so configuration drift is caught
 * before a single charge is priced or settled. The same process boots once its setting and the
 * source agree.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, requireUrls, setPricingSource, truncateAll, type Urls } from '@rekoda/db/testing';

let urls: Urls;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  await truncateAll(urls);
  process.env['DATABASE_URL'] = urls.app;
  process.env['OTP_PEPPER'] = randomBytes(24).toString('hex');
  process.env['VAULT_KEY'] = randomBytes(32).toString('hex');
  process.env['MATCH_KEY'] = randomBytes(32).toString('hex');
  process.env['REKODA_API_SECRET'] = randomBytes(24).toString('hex');
  process.env['REKODA_OPERATOR_SECRET'] = `operator-${randomBytes(24).toString('hex')}`;
  process.env['REKODA_WEB_URL'] = 'https://books.example.test';
  delete process.env['NODE_ENV'];
});

afterAll(async () => {
  delete process.env['REKODA_PLAN_CATALOGUE_READS'];
  await truncateAll(urls);
});

async function boot(): Promise<void> {
  const { createApp } = await import('../main.js');
  const app = await createApp();
  await app.close();
}

describe('a process is held to the pricing source in force at boot (OD-51.6)', () => {
  it('refuses to start on the constant setting while the catalogue is in force', async () => {
    process.env['REKODA_PLAN_CATALOGUE_READS'] = '0';
    await expect(boot()).rejects.toThrow(
      /REKODA_PLAN_CATALOGUE_READS=0.*the pricing source in force is "catalogue".*Refusing to start/s,
    );
  });

  it('refuses to start on the catalogue setting while the constants are in force', async () => {
    await setPricingSource(urls, 'constants');
    delete process.env['REKODA_PLAN_CATALOGUE_READS'];
    await expect(boot()).rejects.toThrow(/the pricing source in force is "constants"/);
  });

  it('refuses the constant setting on a release whose compiled prices differ from the recorded ones', async () => {
    await setPricingSource(urls, 'constants', 'a'.repeat(64));
    process.env['REKODA_PLAN_CATALOGUE_READS'] = '0';
    await expect(boot()).rejects.toThrow(/compiled prices that differ/);
  });

  it('starts when its setting and the source in force agree, on either source', async () => {
    await setPricingSource(urls, 'constants');
    process.env['REKODA_PLAN_CATALOGUE_READS'] = '0';
    await expect(boot()).resolves.toBeUndefined();
    await setPricingSource(urls, 'catalogue');
    delete process.env['REKODA_PLAN_CATALOGUE_READS'];
    await expect(boot()).resolves.toBeUndefined();
  });
});
