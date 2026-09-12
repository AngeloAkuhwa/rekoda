/**
 * The deploy's migrate job gives the runtime roles their passwords (G-01).
 * These pin the refusals that keep the owner credential out of a runtime
 * URL, and the verifier against a vector computed by a second, independent
 * implementation (Python's hashlib), so the SCRAM arithmetic is not checked
 * only against itself.
 */
import { describe, expect, it } from 'vitest';
import { credentialFor, RUNTIME_ROLES, scramVerifier } from './provision.js';

const OWNER = 'postgres://rekoda_owner:ownerpassword@postgres:5432/rekoda';
const PW = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

describe('scramVerifier', () => {
  it('matches an independently computed SCRAM-SHA-256 verifier', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    expect(scramVerifier('pencil', salt, 4096)).toBe(
      'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==' +
        '$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=' +
        ':wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
    );
  });

  it('salts every call, so the same password never stores the same verifier', () => {
    expect(scramVerifier(PW)).not.toBe(scramVerifier(PW));
  });

  it('never contains the password', () => {
    expect(scramVerifier(PW)).not.toContain(PW);
  });
});

describe('credentialFor', () => {
  const url = (user: string, password = PW, rest = '@postgres:5432/rekoda') =>
    `postgres://${user}:${password}${rest}`;

  it('reads the role and password of a URL that names its role', () => {
    expect(credentialFor('APP_DATABASE_URL', url('rekoda_app'), RUNTIME_ROLES.app, OWNER)).toEqual({
      role: 'rekoda_app',
      password: PW,
    });
  });

  it('decodes a percent-encoded password', () => {
    const encoded = `${PW}%21`;
    expect(
      credentialFor('APP_DATABASE_URL', url('rekoda_app', encoded), RUNTIME_ROLES.app, OWNER)
        .password,
    ).toBe(`${PW}!`);
  });

  it('REFUSES a runtime URL that names the owner, the mistake that disables every policy', () => {
    expect(() =>
      credentialFor('APP_DATABASE_URL', url('rekoda_owner'), RUNTIME_ROLES.app, OWNER),
    ).toThrow(/must connect as rekoda_app, not rekoda_owner/);
  });

  it('refuses the worker URL used for the app role and the other way round', () => {
    expect(() =>
      credentialFor('APP_DATABASE_URL', url('rekoda_worker'), RUNTIME_ROLES.app, OWNER),
    ).toThrow(/rekoda_app/);
    expect(() =>
      credentialFor('WORKER_DATABASE_URL', url('rekoda_app'), RUNTIME_ROLES.worker, OWNER),
    ).toThrow(/rekoda_worker/);
  });

  it('refuses a URL for a different host, port or database', () => {
    for (const rest of [
      '@elsewhere:5432/rekoda',
      '@postgres:6543/rekoda',
      '@postgres:5432/other',
    ]) {
      expect(() =>
        credentialFor('APP_DATABASE_URL', url('rekoda_app', PW, rest), RUNTIME_ROLES.app, OWNER),
      ).toThrow(/database the migrations ran against/);
    }
  });

  it.each([
    ['no password', ''],
    ['a short one', 'short'],
    ['one with a space', `${PW}%20x`],
    ['one outside ASCII', `${PW}%C3%A9`],
  ])('refuses %s', (_label, password) => {
    expect(() =>
      credentialFor('APP_DATABASE_URL', url('rekoda_app', password), RUNTIME_ROLES.app, OWNER),
    ).toThrow(/at least 24 printable ASCII/);
  });

  it('refuses something that is not a postgres URL, naming the variable and not the value', () => {
    expect(() => credentialFor('APP_DATABASE_URL', 'nonsense', RUNTIME_ROLES.app, OWNER)).toThrow(
      /^APP_DATABASE_URL is not a URL$/,
    );
    expect(() =>
      credentialFor(
        'APP_DATABASE_URL',
        `mysql://rekoda_app:${PW}@postgres/rekoda`,
        RUNTIME_ROLES.app,
        OWNER,
      ),
    ).toThrow(/postgres:\/\/ URL/);
  });

  it('never puts the password in a refusal', () => {
    let message = '';
    try {
      credentialFor('APP_DATABASE_URL', url('rekoda_owner'), RUNTIME_ROLES.app, OWNER);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(PW);
  });
});
