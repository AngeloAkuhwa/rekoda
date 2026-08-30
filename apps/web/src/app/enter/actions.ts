'use server';

import { redirect } from 'next/navigation';
import { redeemMagicLink } from '@/server/api';
import { setSessionToken } from '@/server/session-cookies';

/**
 * Spend the sign-in link, from a mutation rather than a render (remediation
 * R6).
 *
 * A server action is a POST, which is the whole point. The page that offers
 * this button consumes nothing: a WhatsApp link preview, a corporate URL
 * scanner or a mail-security crawler can fetch `/enter?t=…` as many times as
 * it likes and the merchant's one-shot token is still there when they tap.
 * Redeeming used to happen while rendering that page, so whichever machine
 * looked first won, and the person the link was sent to met "That link has
 * expired" on a link they had never used.
 */
export async function enterAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '').trim();
  if (token) {
    const outcome = await redeemMagicLink(token);
    if (outcome.status === 'signed_in') {
      await setSessionToken(outcome.sessionToken);
      /* `redirect` throws, so nothing below runs on the happy path. The
       * token is out of the address bar by the time /app renders. */
      redirect('/app');
    }
  }
  /* Expired, already spent, or never existed: one answer for all three, so
   * the page cannot be used to find out which was achieved. */
  redirect('/enter?spent=1');
}
