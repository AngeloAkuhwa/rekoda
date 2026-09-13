/**
 * Production refuses configuration that would point it at non-production
 * infrastructure, or make client-address trust meaningless (G-72).
 *
 * Each value below is one a development or test setup legitimately uses (a
 * fake provider on 127.0.0.1, a local documents folder, trust-everything),
 * which is exactly how it ends up in a production `.env`: copied across. A
 * production boot with any of them exits naming the variable; the same
 * value outside production keeps working.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, trustedProxies } from './config.js';

const BASE = {
  DATABASE_URL: 'postgres://x@127.0.0.1:5432/x',
  OTP_PEPPER: 'p'.repeat(40),
  REKODA_API_SECRET: 's'.repeat(40),
  VAULT_KEY: 'a'.repeat(64),
  MATCH_KEY: 'b'.repeat(64),
} as NodeJS.ProcessEnv;

/** A production environment that boots: the compose file's trust values. */
const PROD = {
  ...BASE,
  NODE_ENV: 'production',
  META_APP_SECRET: 'm'.repeat(40),
  META_VERIFY_TOKEN: 'v'.repeat(40),
  OPERATOR_OIDC_ISSUER: 'https://issuer.example.com',
  OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
  OPERATOR_OIDC_JWKS_URL: 'https://issuer.example.com/jwks',
  REKODA_TRUSTED_PROXIES: '172.30.10.10',
  REKODA_TRUSTED_WEB: '172.30.10.11',
} as NodeJS.ProcessEnv;

const DEV = { ...BASE, NODE_ENV: 'development' } as NodeJS.ProcessEnv;

it('the canonical production environment boots', () => {
  const config = loadConfig(PROD);
  expect(config.paystackBaseUrl).toBe('https://api.paystack.co');
  expect(config.monoBaseUrl).toBe('https://api.withmono.com');
  expect(config.localStorageRoot).toBe('');
  expect(config.trustedProxies).toEqual(['172.30.10.10']);
});

describe.each([
  ['PAYSTACK_BASE_URL', 'https://api.paystack.co', 'paystackBaseUrl'],
  ['MONO_BASE_URL', 'https://api.withmono.com', 'monoBaseUrl'],
] as const)('%s', (name, canonical, field) => {
  /* Every request carries the secret key, so a different host is a
   * different party holding it. Only the provider's own host is accepted,
   * written exactly; anything else, however it is spelt, is refused. */
  it.each([
    'http://127.0.0.1:4010',
    'http://localhost:4010',
    'https://mock-provider:4010',
    `${canonical.replace('https:', 'http:')}`,
    `${canonical}/`,
    `${canonical}.evil.example`,
    `${canonical}@evil.example`,
    `https://evil.example#${canonical.slice(8)}`,
    `${canonical.toUpperCase()}`,
    `${canonical}:443`,
    `${canonical}/v2`,
  ])(`production refuses ${name}=%s`, (value) => {
    expect(() => loadConfig({ ...PROD, [name]: value })).toThrow(
      new RegExp(`${name} must not be set in production`),
    );
  });

  it('production accepts it unset, blank, or exactly the provider', () => {
    expect(loadConfig(PROD)[field]).toBe(canonical);
    expect(loadConfig({ ...PROD, [name]: '' })[field]).toBe(canonical);
    expect(loadConfig({ ...PROD, [name]: canonical })[field]).toBe(canonical);
  });

  it('development and test keep their fake provider', () => {
    expect(loadConfig({ ...DEV, [name]: 'http://127.0.0.1:4010' })[field]).toBe(
      'http://127.0.0.1:4010',
    );
    expect(loadConfig({ ...BASE, NODE_ENV: 'test', [name]: 'http://127.0.0.1:4010' })[field]).toBe(
      'http://127.0.0.1:4010',
    );
    expect(loadConfig({ ...DEV, [name]: '' })[field]).toBe(canonical);
  });
});

describe('REKODA_LOCAL_STORAGE', () => {
  it.each(['/tmp/rekoda', '.', 'C:\\rekoda'])('production refuses %s', (value) => {
    expect(() => loadConfig({ ...PROD, REKODA_LOCAL_STORAGE: value })).toThrow(
      /REKODA_LOCAL_STORAGE must not be set in production/,
    );
  });

  it('production accepts it blank, as the template leaves it', () => {
    expect(loadConfig({ ...PROD, REKODA_LOCAL_STORAGE: '' }).localStorageRoot).toBe('');
  });

  it('development keeps its local folder', () => {
    expect(loadConfig({ ...DEV, REKODA_LOCAL_STORAGE: '/tmp/rekoda' }).localStorageRoot).toBe(
      '/tmp/rekoda',
    );
  });
});

/**
 * Endpoints production may legitimately choose (an OpenAI-compatible host
 * under a data processing agreement; the operators' identity provider) must
 * still be on the public internet over TLS. The URL is read the way fetch
 * reads it, so alternate spellings of a local address are the address.
 */
const LOCAL_ENDPOINTS = [
  ['plain http', 'http://api.groq.com/openai/v1'],
  ['localhost', 'https://localhost:8000/v1'],
  ['localhost with a trailing dot, in capitals', 'https://LOCALHOST./v1'],
  ['a .localhost name', 'https://llm.localhost/v1'],
  ['percent-encoded localhost', 'https://%6c%6fcalhost/v1'],
  ['loopback', 'https://127.0.0.1/v1'],
  ['loopback in hex', 'https://0x7f.1/v1'],
  ['loopback as an integer', 'https://2130706433/v1'],
  ['loopback, short form', 'https://127.1/v1'],
  ['the unspecified address', 'https://0/v1'],
  ['IPv6 loopback', 'https://[::1]/v1'],
  ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/v1'],
  ['a private address', 'https://10.0.0.5/v1'],
  ['a private address, 192.168', 'https://192.168.1.10/v1'],
  ['carrier-grade NAT', 'https://100.64.0.1/v1'],
  ['the cloud metadata address', 'https://169.254.169.254/latest'],
  ['IPv6 unique local', 'https://[fd00::1]/v1'],
  ['IPv6 link local', 'https://[fe80::1]/v1'],
  ['a documentation address', 'https://203.0.113.5/v1'],
  ['a container name', 'https://ollama:11434/v1'],
  ['a .internal name', 'https://llm.internal/v1'],
  ["Docker's host name", 'https://host.docker.internal/v1'],
  ['a .local name', 'https://llm.local/v1'],
  ['a .lan name', 'https://llm.lan/v1'],
  ['a .home.arpa name', 'https://llm.home.arpa/v1'],
  ['a .invalid name', 'https://model.example.invalid/v1'],
  ['a .test name', 'https://issuer.test/v1'],
  ['a .example name', 'https://service.example/v1'],
  ['credentials in the URL', 'https://user:pw@api.groq.com/openai/v1'],
  ['not a URL', 'api.groq.com/openai/v1'],
] as const;

describe('AI_BASE_URL', () => {
  it.each(LOCAL_ENDPOINTS)('production refuses %s', (_label, value) => {
    expect(() => loadConfig({ ...PROD, AI_BASE_URL: value })).toThrow(/AI_BASE_URL/);
  });

  it('production accepts a public https host', () => {
    expect(loadConfig({ ...PROD, AI_BASE_URL: 'https://api.groq.com/openai/v1' }).aiBaseUrl).toBe(
      'https://api.groq.com/openai/v1',
    );
    expect(loadConfig({ ...PROD, AI_BASE_URL: 'https://8.8.8.8/v1' }).aiBaseUrl).toBe(
      'https://8.8.8.8/v1',
    );
  });

  it('development keeps a local model server', () => {
    expect(loadConfig({ ...DEV, AI_BASE_URL: 'http://127.0.0.1:8000/v1' }).aiBaseUrl).toBe(
      'http://127.0.0.1:8000/v1',
    );
  });
});

describe.each(['OPERATOR_OIDC_ISSUER', 'OPERATOR_OIDC_JWKS_URL'])('%s', (name) => {
  /* A local issuer would let whoever runs it sign operator tokens. */
  it.each(LOCAL_ENDPOINTS.filter(([label]) => label !== 'plain http'))(
    'production refuses %s',
    (_label, value) => {
      expect(() => loadConfig({ ...PROD, [name]: value })).toThrow(new RegExp(name));
    },
  );

  it('development keeps a local identity provider', () => {
    expect(
      loadConfig({
        ...DEV,
        OPERATOR_OIDC_ISSUER: 'https://localhost:8443/realms/rekoda',
        OPERATOR_OIDC_AUDIENCE: 'rekoda-ops',
        OPERATOR_OIDC_JWKS_URL: 'https://localhost:8443/realms/rekoda/certs',
      }).operatorAuth?.issuer,
    ).toBe('https://localhost:8443/realms/rekoda');
  });
});

describe('R2_ACCOUNT_ID', () => {
  /* It becomes the storage host (`https://<id>.r2.cloudflarestorage.com`),
   * so anything but an account id moves every document somewhere else. */
  it.each(['evil.example#', 'x@evil.example/', 'evil.example/', 'abc', 'a'.repeat(33)])(
    'refuses %s',
    (value) => {
      expect(() => loadConfig({ ...PROD, R2_ACCOUNT_ID: value })).toThrow(/R2_ACCOUNT_ID/);
      expect(() => loadConfig({ ...DEV, R2_ACCOUNT_ID: value })).toThrow(/R2_ACCOUNT_ID/);
    },
  );

  it('accepts a Cloudflare account id, or nothing', () => {
    expect(
      loadConfig({ ...PROD, R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' }).r2AccountId,
    ).toBe('0123456789abcdef0123456789abcdef');
    expect(loadConfig({ ...PROD, R2_ACCOUNT_ID: '' }).r2AccountId).toBe('');
  });
});

describe('REKODA_TRUSTED_PROXIES', () => {
  it('is required in production', () => {
    const { REKODA_TRUSTED_PROXIES: _dropped, ...unset } = PROD;
    expect(() => loadConfig(unset)).toThrow(/REKODA_TRUSTED_PROXIES is required in production/);
  });

  it('trusts every proxy outside production when unset, as before', () => {
    expect(trustedProxies(DEV)).toBe(true);
  });

  /* A value of bare separators passed the old "is it set" check and trusted
   * no proxy at all, so every direct caller was keyed on Caddy's address. */
  it.each([',', ' , ', ',,'])('refuses %j everywhere: set, but naming nothing', (value) => {
    expect(() => trustedProxies({ ...PROD, REKODA_TRUSTED_PROXIES: value })).toThrow(
      /REKODA_TRUSTED_PROXIES is set but names no/,
    );
    expect(() => trustedProxies({ ...DEV, REKODA_TRUSTED_PROXIES: value })).toThrow(
      /REKODA_TRUSTED_PROXIES is set but names no/,
    );
  });

  it.each(['172.30.10', '0xac.30.10.10', 'caddy', '10.0.0.0/255.0.0.0', '10.0.0.0/33'])(
    'refuses %s, which is not a plain address, CIDR or known range name',
    (value) => {
      expect(() => trustedProxies({ ...DEV, REKODA_TRUSTED_PROXIES: value })).toThrow(
        /REKODA_TRUSTED_PROXIES has an entry/,
      );
    },
  );

  it.each([
    '0.0.0.0/0',
    '::/0',
    '::ffff:0:0/96',
    '0.0.0.0/1',
    '128.0.0.0/2',
    '2000::/3',
    '172.30.10.10, 0.0.0.0/0',
    '::/16',
    '::/80',
    '::/64',
  ])('production refuses %s, which trusts effectively the whole internet', (value) => {
    expect(() => trustedProxies({ ...PROD, REKODA_TRUSTED_PROXIES: value })).toThrow(
      /REKODA_TRUSTED_PROXIES trusts .* effectively the whole internet/,
    );
  });

  it.each([
    '172.30.10.10',
    '10.0.0.0/8',
    '104.16.0.0/13',
    '2a06:98c0::/29',
    'fc00::/7',
    '::ffff:172.30.10.0/120',
    'loopback, uniquelocal',
  ])('production accepts %s', (value) => {
    expect(trustedProxies({ ...PROD, REKODA_TRUSTED_PROXIES: value })).toEqual(
      value.split(',').map((part) => part.trim()),
    );
  });

  /* Development's own trust-all is the unset path above, which answers
   * `true`. This only says the universal-range rule is a production rule;
   * Fastify itself refuses `0.0.0.0/0` as a range when it compiles one. */
  it('does not apply the universal-range rule outside production', () => {
    expect(trustedProxies({ ...DEV, REKODA_TRUSTED_PROXIES: '0.0.0.0/0' })).toEqual(['0.0.0.0/0']);
  });

  /* A name that is not a range name, but is a property of every object. */
  it.each(['constructor', '__proto__', 'toString'])('refuses %s, naming the variable', (value) => {
    expect(() => trustedProxies({ ...DEV, REKODA_TRUSTED_PROXIES: value })).toThrow(
      /REKODA_TRUSTED_PROXIES has an entry/,
    );
  });
});

describe('REKODA_TRUSTED_WEB', () => {
  it.each(['0.0.0.0/0', '::/0', '::ffff:0:0/96', '0.0.0.0/1', '2000::/3', '172.30.10.11,::/0'])(
    'production refuses %s, which trusts effectively the whole internet',
    (value) => {
      expect(() => loadConfig({ ...PROD, REKODA_TRUSTED_WEB: value })).toThrow(
        /REKODA_TRUSTED_WEB trusts .* effectively the whole internet/,
      );
    },
  );

  it.each(['172.30.10.11', '172.30.10.0/24', '10.0.0.0/8', 'fd00::/8', '::ffff:172.30.10.11'])(
    'production accepts %s',
    (value) => {
      expect(loadConfig({ ...PROD, REKODA_TRUSTED_WEB: value }).trustedWeb.length).toBeGreaterThan(
        0,
      );
    },
  );

  it('development may trust everything', () => {
    expect(loadConfig({ ...DEV, REKODA_TRUSTED_WEB: '0.0.0.0/0' }).trustedWeb).toHaveLength(1);
  });
});
