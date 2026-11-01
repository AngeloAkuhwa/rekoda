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

/** A submission outcome, stored with the token it was submitted for. */
export interface TokenOutcome<T> {
  token: string;
  state: T;
}

/**
 * The state to show for the current token. An outcome belongs to the token it was submitted for, so
 * a second link opened while the first request was pending never shows the first link's result.
 */
export function visibleState<T>(
  outcome: TokenOutcome<T> | null,
  currentToken: string | null | undefined,
): T | null {
  return outcome !== null && outcome.token === currentToken ? outcome.state : null;
}
