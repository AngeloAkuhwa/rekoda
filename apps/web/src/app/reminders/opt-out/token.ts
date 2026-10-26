/**
 * The opt-out token from a URL fragment (`#token=...`), or null when it is missing or malformed.
 * A token already parsed (a string) is kept: the page clears the fragment after the first read, so a
 * repeated read (React strict mode in development) must not replace it with null.
 */
export function keepParsedToken(previous: string | null | undefined, hash: string): string | null {
  if (typeof previous === 'string') return previous;
  const raw = hash.replace(/^#/, '');
  const value = raw.startsWith('token=') ? raw.slice('token='.length) : '';
  let decoded = '';
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = '';
  }
  return decoded.length >= 40 ? decoded : null;
}
