import 'server-only';
import { cookies } from 'next/headers';

/**
 * Cookie custody for tokens the API issued.
 *
 * This file replaces the interim `verified-phone` marker, and the difference is
 * the whole point of this milestone: that cookie was a claim the web tier
 * signed for itself, so its trustworthiness depended on a secret the web tier
 * held and on nobody making a mistake with it. These cookies carry opaque
 * tokens minted and validated by the API, against rows in Postgres. The web
 * tier can no longer assert identity — only carry proof of it.
 *
 * Both are HTTP-only, so no client script can read them; both are `SameSite=Lax`,
 * so they do not ride along on cross-site POSTs.
 */
const SESSION = 'rk_session';
const SETUP = 'rk_setup';

/** Matches the API's setup-grant TTL. Long enough to name a business, no longer. */
const SETUP_TTL_S = 30 * 60;
/** Matches the API's rolling session TTL. */
const SESSION_TTL_S = 30 * 24 * 60 * 60;

function baseOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
}

export async function setSetupToken(token: string): Promise<void> {
  (await cookies()).set(SETUP, token, { ...baseOptions(), maxAge: SETUP_TTL_S });
}

export async function readSetupToken(): Promise<string | null> {
  return (await cookies()).get(SETUP)?.value ?? null;
}

export async function clearSetupToken(): Promise<void> {
  (await cookies()).delete(SETUP);
}

export async function setSessionToken(token: string): Promise<void> {
  (await cookies()).set(SESSION, token, { ...baseOptions(), maxAge: SESSION_TTL_S });
}

export async function readSessionToken(): Promise<string | null> {
  return (await cookies()).get(SESSION)?.value ?? null;
}

export async function clearSessionToken(): Promise<void> {
  (await cookies()).delete(SESSION);
}
