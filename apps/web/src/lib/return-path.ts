/**
 * Where a merchant was going when sign-in interrupted them.
 *
 * A page behind the dashboard guard sends a merchant without a session to
 * `/start`; without this, sign-in always ended at `/app`, so a WhatsApp link
 * to a page such as `/app/payments` lost its destination on the way. The path
 * rides `/start` and `/verify` as `next` and is honoured after sign-in.
 *
 * Only the pages named here are accepted, exactly as written. `next` is
 * attacker-controlled, so it is an allow-list rather than a pattern: an open
 * redirect from a sign-in page is a phishing tool, and even a same-site
 * destination is not harmless when it is a GET that does something (the
 * `/app/export/*` downloads spend the merchant's monthly allowance). Add a
 * page here only when something links to it and it is safe to land on.
 */
const RETURN_PAGES: ReadonlySet<string> = new Set([
  // The dashboard itself.
  '/app',
  // Linked from the WhatsApp reply to a payment link asked for with no
  // settlement account.
  '/app/payments',
]);

export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return RETURN_PAGES.has(value) ? value : null;
}

/** `/start`, carrying `next` only when it is a safe dashboard path. */
export function startPath(returnTo?: string): string {
  const next = safeReturnPath(returnTo);
  return next ? `/start?next=${encodeURIComponent(next)}` : '/start';
}
