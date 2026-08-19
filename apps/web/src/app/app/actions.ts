'use server';

import { redirect } from 'next/navigation';
import { ApiUnavailable, ApiUnexpectedStatus, signOut } from '@/server/api';
import { clearSessionToken, readSessionToken } from '@/server/session-cookies';

/**
 * Sign out revokes server-side first, then drops the cookie.
 *
 * Order matters. Clearing the cookie alone would leave a live session row that
 * anyone holding a copy of the token could keep using — a logout that logs
 * nobody out. If the API is unreachable the cookie is still cleared, so the
 * merchant is never stuck on a screen that will not let them leave.
 */
export async function signOutAction(_prev: void, _formData: FormData): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    try {
      await signOut(token);
    } catch (error) {
      // A merchant must always be able to leave, so a failed revocation still
      // clears the cookie — but it is recorded rather than swallowed, because a
      // silent failure here is a live session the merchant believes is closed.
      // `signOut` throws on anything but a clean 204, and the end-to-end suite
      // asserts the session is genuinely dead afterwards.
      if (error instanceof ApiUnavailable || error instanceof ApiUnexpectedStatus) {
        console.error('sign-out did not revoke server-side', error);
      } else {
        throw error;
      }
    }
  }
  await clearSessionToken();
  redirect('/');
}
