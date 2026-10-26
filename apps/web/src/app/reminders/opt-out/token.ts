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

/**
 * The page state after a submission finishes. A result belongs to the token that was submitted: if a
 * second link replaced the token while the request was pending, the result is dropped so it cannot
 * mark the new link as done.
 */
export function stateAfterSubmit<T>(
  currentToken: string | null | undefined,
  submittedToken: string,
  result: T,
  state: T | null,
): T | null {
  return currentToken === submittedToken ? result : state;
}
