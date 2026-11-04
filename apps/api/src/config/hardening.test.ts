/**
 * Values refused at boot rather than trusted: an unrecognised NODE_ENV is
 * production (PR-108), encryption keys are shape-checked (PR-106), the release
 * label /health serves is a validated token (G-01), and an alert destination
 * that could not receive alerts refuses to start (G-26).
 */
import { describe, expect, it } from 'vitest';
import { isProductionEnv, loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

describe('production hardening fails closed on NODE_ENV (PR-108)', () => {
  it('treats unset, development and test as non-production', () => {
    expect(isProductionEnv({})).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'development' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: 'test' })).toBe(false);
    expect(isProductionEnv({ NODE_ENV: '' })).toBe(false);
  });

  it('treats production - and anything UNRECOGNISED - as production', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true);
    // The finding: a typo used to skip every production requirement.
    expect(isProductionEnv({ NODE_ENV: 'prod' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'Production' })).toBe(true);
    expect(isProductionEnv({ NODE_ENV: 'staging' })).toBe(true);
  });

  it('so REKODA_REVEAL_OTP is refused under a typo`d production env', () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: 'prod', REKODA_REVEAL_OTP: '1' })).toThrow(
      /REKODA_REVEAL_OTP/,
    );
  });
});

describe('encryption keys are shape-validated at boot (PR-106)', () => {
  it('refuses a vault key that is the right length but not hex', () => {
    expect(() => loadConfig({ ...BASE, VAULT_KEY: 'z'.repeat(64) })).toThrow(/VAULT_KEY/);
  });

  it('accepts an empty CONNECTION_KEY (the capability is off) but not a bad one', () => {
    expect(loadConfig({ ...BASE }).connectionKey).toBe('');
    expect(() => loadConfig({ ...BASE, CONNECTION_KEY: 'changeme' })).toThrow(/CONNECTION_KEY/);
    const good = 'c'.repeat(64);
    expect(loadConfig({ ...BASE, CONNECTION_KEY: good }).connectionKey).toBe(good);
  });
});

/**
 * `/health` names the build that answered (G-01). Whatever these hold is
 * served to anyone who asks, so they are validated tokens, never free text.
 */
describe('the release label on /health', () => {
  it('reports unversioned and unknown when the process was not started from an image', () => {
    const config = loadConfig({ ...BASE });
    expect(config.release).toBe('unversioned');
    expect(config.commit).toBe('unknown');
  });

  it('carries the tag and short commit the image was built with', () => {
    const config = loadConfig({ ...BASE, REKODA_RELEASE: 'v0.4.1', REKODA_COMMIT: 'b81ef90' });
    expect(config.release).toBe('v0.4.1');
    expect(config.commit).toBe('b81ef90');
  });

  it('treats a blank value as unset', () => {
    expect(loadConfig({ ...BASE, REKODA_RELEASE: '  ' }).release).toBe('unversioned');
  });

  it.each(['v1 beta', '<script>', 'a'.repeat(65), '-leading-dash', 'v1/2', 'v1.2.3+build.4'])(
    'refuses %s at boot rather than serve it',
    (value) => {
      expect(() => loadConfig({ ...BASE, REKODA_RELEASE: value })).toThrow(/REKODA_RELEASE/);
      expect(() => loadConfig({ ...BASE, REKODA_COMMIT: value })).toThrow(/REKODA_COMMIT/);
    },
  );
});

describe('the alert destination (G-26)', () => {
  it('is null when unset or blank: no destination is the honest default', () => {
    expect(loadConfig({ ...BASE }).opsAlertWebhookUrl).toBeNull();
    expect(loadConfig({ ...BASE, REKODA_ALERT_WEBHOOK_URL: '  ' }).opsAlertWebhookUrl).toBeNull();
  });

  it('accepts an https URL', () => {
    expect(
      loadConfig({ ...BASE, REKODA_ALERT_WEBHOOK_URL: 'https://hooks.example.com/T1/B2' })
        .opsAlertWebhookUrl,
    ).toBe('https://hooks.example.com/T1/B2');
  });

  it('refuses to boot on a value that would send alerts nowhere', () => {
    expect(() => loadConfig({ ...BASE, REKODA_ALERT_WEBHOOK_URL: 'not a url' })).toThrow(
      /not a URL/,
    );
    expect(() =>
      loadConfig({ ...BASE, REKODA_ALERT_WEBHOOK_URL: 'http://hooks.example.com/x' }),
    ).toThrow(/must be https/);
  });
});
