import 'server-only';
import { cookies } from 'next/headers';

/**
 * A test-only escrow for the OTP, and the only reason it exists is that the
 * end-to-end suite runs against a PRODUCTION build — which is the point, since
 * that is where dev-only branches are correctly switched off.
 *
 * Gated on an environment variable set nowhere but `playwright.config.ts`. It
 * appears in `.env.example` only as a commented must-be-unset test hook, it
 * is absent from the Dockerfile and the deploy runbook, and
 * `e2e/onboarding.spec.ts` asserts the code is not rendered when it is unset.
 * There is deliberately no boot guard on it: the API's guard is on
 * REKODA_REVEAL_OTP; this switch only decides whether the web tier shows a
 * code the API already chose to return.
 *
 * A cookie rather than a query parameter deliberately: a live credential in a
 * URL survives in history, referrers and access logs. The API applies the same
 * gate on its own side (`REKODA_REVEAL_OTP`), and refuses it outright when
 * NODE_ENV is production — so this cannot leak a code the API would not have
 * handed over in the first place.
 */
const COOKIE = 'rk_dev_otp';

export function revealEnabled(): boolean {
  return process.env.REKODA_E2E_REVEAL_OTP === '1';
}

export async function stashDevCode(code: string | undefined): Promise<void> {
  if (!revealEnabled() || !code) return;
  (await cookies()).set(COOKIE, code, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 900 });
}

export async function readDevCode(): Promise<string | undefined> {
  if (!revealEnabled()) return undefined;
  return (await cookies()).get(COOKIE)?.value;
}
