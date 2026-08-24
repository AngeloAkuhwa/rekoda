'use server';

import { revalidatePath } from 'next/cache';
import { billingCancel, viewOnlyRefusal } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface CancelFormState {
  error?: string;
  done?: string;
}

/** `24 Sept 2026`, Lagos, from an ISO instant. */
function lagosDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

async function cancelSubscriptionActionUnguarded(
  _prev: CancelFormState,
  _formData: FormData,
): Promise<CancelFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const outcome = await billingCancel(token);
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  if (outcome.state === 'trial') {
    return {
      done: outcome.endsAt
        ? `Your trial charges nothing and simply ends on ${lagosDate(outcome.endsAt)}. There is nothing to cancel.`
        : 'Your trial charges nothing and simply ends. There is nothing to cancel.',
    };
  }
  if (outcome.state === 'already_stopped') {
    return { done: 'Your subscription is already stopped. Nothing more will be charged.' };
  }

  revalidatePath('/app/billing');
  const day = lagosDate(outcome.endsAt);
  if (outcome.state === 'already_scheduled') {
    return { done: `Already cancelled: your plan runs until ${day}, then stops.` };
  }
  return {
    done: `Cancelled. You keep everything you paid for until ${day}, nothing more is charged, and your records stay readable and exportable afterwards. Changed your mind? Pick your current plan on the change table above.`,
  };
}

export async function cancelSubscriptionAction(
  ...args: Parameters<typeof cancelSubscriptionActionUnguarded>
): ReturnType<typeof cancelSubscriptionActionUnguarded> {
  try {
    return await cancelSubscriptionActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof cancelSubscriptionActionUnguarded>>;
  }
}
