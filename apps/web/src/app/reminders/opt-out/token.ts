/**
 * The opt-out token from a URL fragment (`#token=...`), or null when it is missing or malformed.
 * A fragment that carries a token replaces any earlier one (a second link opened in the same tab).
 * An empty fragment keeps the token already parsed: the page clears the fragment after reading it,
 * so a repeated read (React strict mode in development) must not replace it with null.
 */
export function keepParsedToken(previous: string | null | undefined, hash: string): string | null {
  if (hash.replace(/^#/, '') === '') return previous ?? null;
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
