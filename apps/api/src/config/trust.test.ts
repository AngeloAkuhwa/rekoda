/**
 * Who the API believes: the operator plane's verified identity (P0-2) and the
 * web tier whose client-address header names the visitor (G-71).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { BASE } from './env.fixtures.js';

/**
 * The operator plane's identity (P0-2).
 *
 * Estate-wide authority used to be one reusable static header secret, and the
 * audit actor was whatever the caller typed. These pin the configuration half
 * of the replacement: production has a verified identity or it does not start,
 * and the development stand-in cannot survive into production by accident.
 */
describe('operator identity configuration', () => {
  const OIDC = {
    OPERATOR_OIDC_ISSUER: 'https://issuer.example.com',
    OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
    OPERATOR_OIDC_JWKS_URL: 'https://issuer.example.com/jwks',
  };
  const PROD = {
    ...BASE,
    NODE_ENV: 'production',
    REKODA_TRUSTED_PROXIES: '172.30.10.10',
    META_APP_SECRET: 'm'.repeat(40),
    META_VERIFY_TOKEN: 'v'.repeat(40),
    REKODA_TRUSTED_WEB: '172.30.10.11',
  } as NodeJS.ProcessEnv;

  it('is absent by default outside production, where the secret stands in', () => {
    expect(loadConfig(BASE).operatorAuth).toBeNull();
  });

  it('reads issuer, audience and key set, with OIDC scope as the default claim', () => {
    expect(loadConfig({ ...BASE, ...OIDC }).operatorAuth).toEqual({
      issuer: 'https://issuer.example.com',
      audience: 'rekoda-ops',
      jwksUrl: 'https://issuer.example.com/jwks',
      scopeClaim: 'scope',
    });
  });

  it('refuses production with no verified identity, rather than falling back', () => {
    /* The fail-closed half. A fallback that exists is a fallback somebody
     * reaches for during an incident, and an incident is exactly when
     * estate-wide authority should be hardest to get. */
    expect(() => loadConfig(PROD)).toThrow(/operator plane needs a verified identity/);
    expect(() => loadConfig({ ...PROD, ...OIDC })).not.toThrow();
  });

  it('refuses HALF a configuration everywhere, production or not', () => {
    /* Two of three is somebody mid-rollout. Treating it as "no verifier"
     * would turn a half-finished deployment change into a silent downgrade
     * to the shared secret. */
    const { OPERATOR_OIDC_JWKS_URL: _dropped, ...partial } = OIDC;
    expect(() => loadConfig({ ...BASE, ...partial })).toThrow(/or none of them/);
  });

  it('refuses a plaintext issuer or key set', () => {
    expect(() =>
      loadConfig({ ...BASE, ...OIDC, OPERATOR_OIDC_ISSUER: 'http://issuer.example.com' }),
    ).toThrow(/must be an https URL/);
    expect(() =>
      loadConfig({ ...BASE, ...OIDC, OPERATOR_OIDC_JWKS_URL: 'http://issuer.example.com/jwks' }),
    ).toThrow(/must be an https URL/);
  });

  it('refuses the development secret in production instead of ignoring it', () => {
    /* A secret sitting in a production environment reads as a live credential
     * to everyone who finds it, and the one thing worse than a shared secret
     * is a shared secret people believe still works. */
    expect(() => loadConfig({ ...PROD, ...OIDC, REKODA_OPERATOR_SECRET: 'o'.repeat(40) })).toThrow(
      /development stand-in/,
    );
  });
});

/**
 * The web tier's address is the only peer whose X-Rekoda-Client-IP names the
 * visitor (G-71). Production cannot run without it, and a malformed entry
 * refuses to boot rather than silently changing who is believed.
 */
describe('the trusted web tier (G-71)', () => {
  const PROD = {
    ...BASE,
    NODE_ENV: 'production',
    REKODA_TRUSTED_PROXIES: '172.30.10.10',
    META_APP_SECRET: 'm'.repeat(40),
    META_VERIFY_TOKEN: 'v'.repeat(40),
    OPERATOR_OIDC_ISSUER: 'https://issuer.example.com',
    OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
    OPERATOR_OIDC_JWKS_URL: 'https://issuer.example.com/jwks',
  } as NodeJS.ProcessEnv;

  it('is empty outside production when unset, so no peer is believed', () => {
    expect(loadConfig({ ...BASE }).trustedWeb).toEqual([]);
  });

  it('is required in production', () => {
    expect(() => loadConfig(PROD)).toThrow(/REKODA_TRUSTED_WEB is required in production/);
    expect(loadConfig({ ...PROD, REKODA_TRUSTED_WEB: '172.30.10.11' }).trustedWeb).toHaveLength(1);
  });

  it('is not satisfied in production by a value that names no address', () => {
    expect(() => loadConfig({ ...PROD, REKODA_TRUSTED_WEB: ',' })).toThrow(/REKODA_TRUSTED_WEB/);
  });

  it('takes addresses and CIDRs, IPv4 and IPv6', () => {
    expect(
      loadConfig({ ...BASE, REKODA_TRUSTED_WEB: '172.30.10.11, 10.0.0.0/8, fd00::/8' }).trustedWeb,
    ).toHaveLength(3);
  });

  it.each(['web', '172.30.10.300', '10.0.0.0/40', '172.30.10.11,,nonsense'])(
    'refuses %s at boot',
    (value) => {
      expect(() => loadConfig({ ...BASE, REKODA_TRUSTED_WEB: value })).toThrow(
        /REKODA_TRUSTED_WEB/,
      );
    },
  );
});
