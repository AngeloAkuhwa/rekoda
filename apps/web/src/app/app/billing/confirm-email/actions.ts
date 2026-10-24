'use server';

import { ApiForbidden, billingEmailConfirm } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';
import type { ConfirmState } from '@/lib/billing-pay-copy';

/**
 * Spend the token from the emailed link, under the signed-in owner's session.
 * The token was read from the URL fragment in the browser and arrives in this
 * action's body, so it is never in a request URL, a log line or a referrer.
 */
export async function confirmBillingEmailAction(token: string): Promise<ConfirmState> {
  const session = await readSessionToken();
  if (!session) return 'invalid';
  try {
    const answer = await billingEmailConfirm(session, token);
    return answer === 'malformed' ? 'invalid' : answer.state;
  } catch (error) {
    if (error instanceof ApiForbidden) return 'not_owner';
    return 'error';
  }
}
