import 'server-only';
import { redirect } from 'next/navigation';
import type { MeResponse, SetupStateResponse } from '@rekoda/contracts';
import { me, readSetupState } from './api';
import { readSessionToken, readSetupToken } from './session-cookies';

/**
 * Step guards, each of which asks the API rather than trusting a cookie.
 *
 * The distinction matters: a cookie's *presence* is something an attacker
 * controls completely. Every guard here spends a round trip to turn "the
 * browser sent something" into "the server recognises it", which is the check
 * the interim implementation could not make because the web tier had no way to
 * verify what it had signed.
 */

/** `/setup/business` — a verified phone with no business yet. */
export async function requireSetupGrant(): Promise<{
  token: string;
  state: SetupStateResponse;
}> {
  const token = await readSetupToken();
  if (!token) redirect('/start');

  const state = await readSetupState(token);
  if (!state) redirect('/start');
  return { token, state };
}

/** `/app` and `/setup/complete` — a live session bound to a business. */
export async function requireSession(): Promise<MeResponse> {
  const token = await readSessionToken();
  if (!token) redirect('/start');

  const identity = await me(token);
  // Deliberately does NOT clear the dead cookie. Next allows cookie writes only
  // in Server Actions and Route Handlers; attempting one from a page component
  // throws, which turned a forged cookie into a 500 instead of a redirect. The
  // e2e suite caught exactly that. Guards read, actions write — and a stale
  // cookie costs nothing, since the session it names is already dead server-side
  // and signing in overwrites it.
  if (!identity) redirect('/start');
  return identity;
}

/** For pages that adapt to a signed-in merchant but do not demand one. */
export async function optionalSession(): Promise<MeResponse | null> {
  const token = await readSessionToken();
  if (!token) return null;
  return me(token);
}

/**
 * Same guarantee as `requireSession`, and hands back the TOKEN too — for
 * pages that make further API calls on the merchant's behalf. The token
 * never reaches a client component; it lives for one server render.
 */
export async function requireSessionWithToken(): Promise<{
  identity: MeResponse;
  token: string;
}> {
  const token = await readSessionToken();
  if (!token) redirect('/start');
  const identity = await me(token);
  if (!identity) redirect('/start');
  return { identity, token };
}
