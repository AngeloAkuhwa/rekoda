import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { answerVerificationChallenge, verifyMetaSignature } from './webhooks.js';

const SECRET = 'meta-app-secret';
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

describe('Meta webhook signatures', () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it('accepts a correctly signed body', () => {
    expect(verifyMetaSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a body altered after signing', () => {
    const tampered = body.replace('entry":[]', 'entry":[{}]');
    expect(verifyMetaSignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyMetaSignature(body, sign(body, 'someone-elses-secret'), SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header', () => {
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, '', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'deadbeef', SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=', SECRET)).toBe(false);
  });

  it('rejects a downgrade to a weaker algorithm', () => {
    const sha1 = `sha1=${createHmac('sha1', SECRET).update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, sha1, SECRET)).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    // A deployment that forgot META_APP_SECRET must reject webhooks, not
    // accept unsigned ones. This is the direction that fails safe.
    expect(verifyMetaSignature(body, sign(body), '')).toBe(false);
  });

  it('verifies the exact bytes, not a re-serialisation of them', () => {
    // The bug this guards is subtle and total: hashing JSON.stringify(parsed)
    // instead of the raw body fails for every legitimate request, because key
    // order and whitespace do not survive a parse.
    const spaced = '{ "object" : "whatsapp_business_account" }';
    const compact = '{"object":"whatsapp_business_account"}';
    const header = sign(spaced);
    expect(verifyMetaSignature(spaced, header, SECRET)).toBe(true);
    expect(verifyMetaSignature(compact, header, SECRET)).toBe(false);
  });

  it('handles a Buffer body identically to the string it decodes to', () => {
    expect(verifyMetaSignature(Buffer.from(body, 'utf8'), sign(body), SECRET)).toBe(true);
  });
});

describe('the subscription handshake', () => {
  const TOKEN = 'a-verify-token';

  it('echoes the challenge when the token matches', () => {
    expect(
      answerVerificationChallenge(
        { mode: 'subscribe', token: TOKEN, challenge: '1158201444' },
        TOKEN,
      ),
    ).toBe('1158201444');
  });

  it('refuses a wrong token, a wrong mode, or a missing challenge', () => {
    expect(
      answerVerificationChallenge({ mode: 'subscribe', token: 'nope', challenge: 'x' }, TOKEN),
    ).toBeNull();
    expect(
      answerVerificationChallenge({ mode: 'unsubscribe', token: TOKEN, challenge: 'x' }, TOKEN),
    ).toBeNull();
    expect(answerVerificationChallenge({ mode: 'subscribe', token: TOKEN }, TOKEN)).toBeNull();
  });

  it('refuses when no token is configured', () => {
    expect(
      answerVerificationChallenge({ mode: 'subscribe', token: '', challenge: 'x' }, ''),
    ).toBeNull();
  });
});
