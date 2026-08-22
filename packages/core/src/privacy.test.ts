import { describe, expect, it } from 'vitest';
import {
  decryptFacet,
  encryptFacet,
  matchKeyEquals,
  matchKeyFor,
  normaliseFacet,
  VaultError,
} from './vault.js';
import {
  detectStructuralPii,
  generateCustomerToken,
  redactForLog,
  rehydrate,
  sequentialToken,
  tokeniseMessage,
} from './privacy.js';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const MATCH_KEY = 'c'.repeat(64);
const BUSINESS = '11111111-1111-1111-1111-111111111111';
const OTHER_BUSINESS = '22222222-2222-2222-2222-222222222222';

describe('the vault — Zone 1', () => {
  it('round-trips a facet', () => {
    const blob = encryptFacet('Ada Obi', KEY);
    expect(decryptFacet(blob, KEY)).toBe('Ada Obi');
  });

  it('never produces the same ciphertext twice for the same input', () => {
    // A fresh IV per call. Deterministic ciphertext would let anyone holding
    // the table tell which customers share a name or a number, without
    // decrypting anything at all.
    const blobs = new Set(Array.from({ length: 20 }, () => encryptFacet('Ada Obi', KEY)));
    expect(blobs.size).toBe(20);
  });

  it('refuses a ciphertext that has been altered', () => {
    const blob = encryptFacet('Ada Obi', KEY);
    const [v, iv, tag, data] = blob.split('.');
    const flipped = Buffer.from(data!, 'base64url');
    /* `readUInt8` rather than `flipped[0] ^= 1`, and not for the types.
     * Indexing an EMPTY buffer flips nothing and leaves this test passing
     * while tampering with no bytes at all — a test proving the opposite of
     * what it claims. `readUInt8(0)` throws on an empty buffer, so the
     * premise is enforced rather than assumed. */
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0x01, 0);
    const tampered = [v, iv, tag, flipped.toString('base64url')].join('.');
    expect(() => decryptFacet(tampered, KEY)).toThrow(VaultError);
  });

  it('refuses a ciphertext encrypted under a different key', () => {
    expect(() => decryptFacet(encryptFacet('Ada Obi', KEY), OTHER_KEY)).toThrow(VaultError);
  });

  it('says the same thing whether the key was wrong or the data was tampered', () => {
    const blob = encryptFacet('Ada Obi', KEY);
    const [v, iv, tag, data] = blob.split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped.writeUInt8(flipped.readUInt8(0) ^ 0x01, 0);

    let tamperedMessage = '';
    let wrongKeyMessage = '';
    try {
      decryptFacet([v, iv, tag, flipped.toString('base64url')].join('.'), KEY);
    } catch (e) {
      tamperedMessage = (e as Error).message;
    }
    try {
      decryptFacet(blob, OTHER_KEY);
    } catch (e) {
      wrongKeyMessage = (e as Error).message;
    }
    // Which one it was is information an attacker wants and an operator does
    // not need.
    expect(tamperedMessage).toBe(wrongKeyMessage);
  });

  it('rejects a key that is not 32 bytes of hex', () => {
    expect(() => encryptFacet('x', 'too-short')).toThrow(VaultError);
    expect(() => encryptFacet('x', 'z'.repeat(64))).toThrow(VaultError);
  });
});

describe('match keys — recognising a returning customer', () => {
  it('is stable for the same value', () => {
    const a = matchKeyFor(BUSINESS, 'phone', '8031234567', MATCH_KEY);
    const b = matchKeyFor(BUSINESS, 'phone', '8031234567', MATCH_KEY);
    expect(matchKeyEquals(a, b)).toBe(true);
  });

  it('gives DIFFERENT keys to the same phone at different businesses', () => {
    // Without this, a database dump reveals which merchants share a customer —
    // a correlation nobody consented to, and free to prevent.
    const here = matchKeyFor(BUSINESS, 'phone', '8031234567', MATCH_KEY);
    const there = matchKeyFor(OTHER_BUSINESS, 'phone', '8031234567', MATCH_KEY);
    expect(matchKeyEquals(here, there)).toBe(false);
  });

  it('does not collide across facets', () => {
    const asPhone = matchKeyFor(BUSINESS, 'phone', 'ada', MATCH_KEY);
    const asName = matchKeyFor(BUSINESS, 'name', 'ada', MATCH_KEY);
    expect(matchKeyEquals(asPhone, asName)).toBe(false);
  });

  it('cannot be forged by re-splitting the parts', () => {
    // Length-prefixed concatenation. Without it, ('ab','c') and ('a','bc')
    // hash identically and two different customers share a match key.
    const a = matchKeyFor(BUSINESS, 'name', 'ab|c', MATCH_KEY);
    const b = matchKeyFor(BUSINESS, 'name', 'a|bc', MATCH_KEY);
    expect(matchKeyEquals(a, b)).toBe(false);
  });

  it('needs the secret — it is not a bare hash of a guessable value', () => {
    const withKey = matchKeyFor(BUSINESS, 'phone', '8031234567', MATCH_KEY);
    const withOther = matchKeyFor(BUSINESS, 'phone', '8031234567', 'd'.repeat(64));
    expect(matchKeyEquals(withKey, withOther)).toBe(false);
  });

  it('recognises one phone written five different ways', () => {
    const forms = [
      '08031234567',
      '+2348031234567',
      '234 803 123 4567',
      '0803-123-4567',
      '8031234567',
    ];
    const keys = forms.map((f) =>
      matchKeyFor(BUSINESS, 'phone', normaliseFacet('phone', f), MATCH_KEY),
    );
    expect(new Set(keys).size).toBe(1);
  });
});

describe('the gateway — what reaches a model', () => {
  const assigner = () => {
    let n = 0;
    return (kind: 'phone' | 'email' | 'account') => sequentialToken(kind, ++n);
  };

  it('removes a phone number and an email, and keeps the money', () => {
    const { text } = tokeniseMessage(
      'Ada bought 3 wigs for 150k, call 08031234567 or ada@mail.com',
      assigner(),
    );
    expect(text).not.toContain('08031234567');
    expect(text).not.toContain('ada@mail.com');
    // The whole point of sending anything at all.
    expect(text).toContain('150k');
    expect(text).toContain('3 wigs');
  });

  it('gives one token to a number repeated in the same message', () => {
    const { text, tokens } = tokeniseMessage('call 08031234567 — I said 08031234567', assigner());
    expect(tokens.size).toBe(1);
    expect(text.match(/PHONE_1/g)).toHaveLength(2);
  });

  it('does NOT tokenise amounts that merely look like long numbers', () => {
    // The failure that would break every invoice: an eight-figure sale
    // disappearing into a token.
    const { text, tokens } = tokeniseMessage('sold for 1500000 naira', assigner());
    expect(tokens.size).toBe(0);
    expect(text).toBe('sold for 1500000 naira');
  });

  it('tokenises a ten-digit account number when it is named as one', () => {
    const { text } = tokeniseMessage('transfer to 0123456789 at GTB', assigner());
    expect(text).not.toContain('0123456789');
    expect(text).toContain('ACCOUNT_1');
  });

  it('does not cut an email in half around the digits inside it', () => {
    const { text, tokens } = tokeniseMessage('mail ada2348031234567@mail.com now', assigner());
    expect(tokens.size).toBe(1);
    expect(text).toBe('mail EMAIL_1 now');
  });

  it('rehydrates exactly what it replaced', () => {
    const original = 'Ada on 08031234567 and ada@mail.com';
    const { text, tokens } = tokeniseMessage(original, assigner());
    expect(rehydrate(text, tokens)).toBe(original);
  });

  it('does not substitute a short token inside a longer one', () => {
    // CUSTOMER_1 inside CUSTOMER_12 — the classic replace-order bug, which
    // would put the wrong customer's name on a receipt.
    const tokens = new Map([
      ['CUSTOMER_1', 'Ada'],
      ['CUSTOMER_12', 'Bola'],
    ]);
    expect(rehydrate('CUSTOMER_12 paid CUSTOMER_1', tokens)).toBe('Bola paid Ada');
  });

  it('finds nothing to remove in an ordinary sentence', () => {
    const { text, tokens } = tokeniseMessage('sold 2 bags of rice for 45k cash', assigner());
    expect(tokens.size).toBe(0);
    expect(text).toBe('sold 2 bags of rice for 45k cash');
  });
});

describe('customer tokens', () => {
  it('uses an alphabet with no lookalike characters', () => {
    const token = generateCustomerToken((n) => new Uint8Array(n).fill(0), 6);
    expect(token).toBe('CUSTOMER_000000');

    // Only the generated part — the "CUSTOMER_" prefix contains O and U, which
    // is fine: nobody transcribes a fixed prefix wrongly, and this assertion
    // originally failed on it.
    const suffix = generateCustomerToken(
      (n) => Uint8Array.from({ length: n }, (_, i) => i),
      64,
    ).replace('CUSTOMER_', '');
    // I, L, O and U are absent, so a token read down a bad line or copied off
    // a screen cannot become a different one.
    expect(suffix).not.toMatch(/[ILOU]/);
  });

  it('maps bytes to characters without bias', () => {
    // 256 is an exact multiple of 32, so `byte % 32` is uniform and needs no
    // rejection sampling — unlike the OTP generator, where 10 does not divide
    // 256 and a naive modulo would quietly favour the low digits. Feeding
    // every byte value must therefore hit all 32 characters equally.
    const counts = new Map<string, number>();
    const suffix = generateCustomerToken(
      (n) => Uint8Array.from({ length: n }, (_, i) => i % 256),
      256,
    ).replace('CUSTOMER_', '');
    for (const ch of suffix) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((c) => c === 8)).toBe(true);
  });
});

describe('log redaction — the last line of defence', () => {
  it('blanks identities the gateway never saw', () => {
    const line = redactForLog('failed for 08031234567 / ada@mail.com / 0123456789');
    expect(line).not.toContain('08031234567');
    expect(line).not.toContain('ada@mail.com');
    expect(line).not.toContain('0123456789');
  });

  it('leaves an ordinary error message readable', () => {
    expect(redactForLog('invoice INV-0042 failed to render')).toBe(
      'invoice INV-0042 failed to render',
    );
  });
});
