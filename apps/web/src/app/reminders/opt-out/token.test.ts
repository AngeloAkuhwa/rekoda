import { describe, expect, it } from 'vitest';
import { keepParsedToken } from './token';

const token = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;

describe('keepParsedToken', () => {
  it('reads a token from the fragment', () => {
    expect(keepParsedToken(undefined, `#token=${encodeURIComponent(token)}`)).toBe(token);
  });

  it('keeps the token when the fragment has already been cleared (strict-mode second run)', () => {
    const first = keepParsedToken(undefined, `#token=${token}`);
    expect(keepParsedToken(first, '')).toBe(token);
  });

  it('is null for a missing, short or malformed fragment', () => {
    expect(keepParsedToken(undefined, '')).toBeNull();
    expect(keepParsedToken(undefined, '#token=short')).toBeNull();
    expect(keepParsedToken(undefined, '#token=%E0%A4%A')).toBeNull();
  });
});
