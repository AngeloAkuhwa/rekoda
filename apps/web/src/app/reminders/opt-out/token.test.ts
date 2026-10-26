import { describe, expect, it } from 'vitest';
import { keepParsedToken, stateAfterSubmit } from './token';

const token = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;

describe('keepParsedToken', () => {
  it('reads a token from the fragment', () => {
    expect(keepParsedToken(undefined, `#token=${encodeURIComponent(token)}`)).toBe(token);
  });

  it('keeps the token when the fragment has already been cleared (strict-mode second run)', () => {
    const first = keepParsedToken(undefined, `#token=${token}`);
    expect(keepParsedToken(first, '')).toBe(token);
  });

  it('replaces the token when a second link arrives in the same tab', () => {
    const second = `${'d'.repeat(20)}.${'e'.repeat(20)}.${'f'.repeat(20)}`;
    expect(keepParsedToken(token, `#token=${second}`)).toBe(second);
  });

  it('is null for a missing, short or malformed fragment', () => {
    expect(keepParsedToken(undefined, '')).toBeNull();
    expect(keepParsedToken(undefined, '#token=short')).toBeNull();
    expect(keepParsedToken(undefined, '#token=%E0%A4%A')).toBeNull();
  });
});

describe('stateAfterSubmit', () => {
  it('applies the result when the token is unchanged', () => {
    expect(stateAfterSubmit(token, token, 'done', null)).toBe('done');
  });

  it('drops the result of the first link once a second link has replaced the token', () => {
    const second = `${'d'.repeat(20)}.${'e'.repeat(20)}.${'f'.repeat(20)}`;
    expect(stateAfterSubmit(second, token, 'done', null)).toBeNull();
  });
});
