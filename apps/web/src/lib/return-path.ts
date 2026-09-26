/**
 * Where a merchant was going when sign-in interrupted them.
 *
 * A page behind the dashboard guard sends a merchant without a session to
 * `/start`; without this, sign-in always ended at `/app`, so a WhatsApp link
 * to a page such as `/app/payments` lost its destination on the way. The path
 * rides `/start` and `/verify` as `next` and is honoured after sign-in.
 *
 * Only a dashboard path is accepted, spelled plainly: `/app`, or `/app/`
 * followed by simple segments. Anything else (another origin, `//host`, a
 * backslash, `..`, percent-encoding, a query or fragment, a non-string) is
 * refused, because `next` is attacker-controlled and an open redirect from a
 * sign-in page is a phishing tool.
 */
const DASHBOARD_PATH = /^\/app(?:\/[A-Za-z0-9_-]+)*$/;

export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return DASHBOARD_PATH.test(value) ? value : null;
}

/** `/start`, carrying `next` only when it is a safe dashboard path. */
export function startPath(returnTo?: string): string {
  const next = safeReturnPath(returnTo);
  return next ? `/start?next=${encodeURIComponent(next)}` : '/start';
}
