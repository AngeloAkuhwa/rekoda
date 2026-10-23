'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  ApiForbidden,
  billingBuyPack,
  billingChangePlan,
  billingSwitchInterval,
} from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

/**
 * Confirm a plan change the merchant has already been quoted.
 *
 * Two steps on purpose: the page shows the figure, and this only runs once
 * they have seen it. A one-click switch that charges is how somebody is
 * surprised by a bill, and it is the one surprise a bookkeeping product
 * cannot afford.
 */
async function confirmPlanChangeUnguarded(formData: FormData): Promise<void> {
  const token = await readSessionToken();
  if (!token) redirect('/start');

  const plan = String(formData.get('plan') ?? '');
  const interval = formData.get('interval') === 'annual' ? 'annual' : 'monthly';
  const answer = await billingChangePlan(token, plan, interval);
  revalidatePath('/app/billing');

  if (!answer) redirect('/app/billing?problem=plan');
  if (answer.state === 'scheduled') {
    /* "Stay on my plan" posts the CURRENT plan with `undo`: the server answers it
     * as a scheduled no-change, which clears the pending change. */
    redirect(`/app/billing?done=${formData.get('undo') ? 'undone' : 'scheduled'}`);
  }
  if (answer.state === 'applied') redirect('/app/billing?done=applied');
  if (answer.state === 'payment_required') {
    redirect(`/app/billing?pay=${encodeURIComponent(answer.reference)}`);
  }
  redirect(`/app/billing?problem=${encodeURIComponent(answer.reason)}`);
}

/**
 * Switch between monthly and yearly billing. Never immediate: the answer says the
 * switch starts at the next renewal, so the month or year already paid for is kept.
 */
async function switchIntervalUnguarded(formData: FormData): Promise<void> {
  const token = await readSessionToken();
  if (!token) redirect('/start');

  const interval = formData.get('interval') === 'annual' ? 'annual' : 'monthly';
  const answer = await billingSwitchInterval(token, interval);
  revalidatePath('/app/billing');

  if (!answer) redirect('/app/billing?problem=plan');
  if (answer.state === 'scheduled') redirect('/app/billing?done=interval_scheduled');
  if (answer.state === 'undone') redirect('/app/billing?done=interval_undone');
  if (answer.state === 'unchanged') redirect('/app/billing');
  redirect('/app/billing?problem=no_cycle');
}

async function buyPackUnguarded(formData: FormData): Promise<void> {
  const token = await readSessionToken();
  if (!token) redirect('/start');

  const packId = String(formData.get('packId') ?? '');
  const answer = await billingBuyPack(token, packId);
  revalidatePath('/app/billing');

  if (!answer) redirect('/app/billing?problem=pack');
  if (answer.state === 'payment_required') {
    redirect(`/app/billing?pay=${encodeURIComponent(answer.reference)}`);
  }
  redirect(`/app/billing?problem=${encodeURIComponent(answer.reason)}`);
}

/* Role refusals (403) come back as a sentence in the form, not a crash.
 * Everything else still throws to the error boundary. */

export async function confirmPlanChange(
  ...args: Parameters<typeof confirmPlanChangeUnguarded>
): ReturnType<typeof confirmPlanChangeUnguarded> {
  try {
    return await confirmPlanChangeUnguarded(...args);
  } catch (error) {
    if (error instanceof ApiForbidden) redirect('/app/billing?problem=view_only');
    throw error;
  }
}

export async function switchInterval(
  ...args: Parameters<typeof switchIntervalUnguarded>
): ReturnType<typeof switchIntervalUnguarded> {
  try {
    return await switchIntervalUnguarded(...args);
  } catch (error) {
    if (error instanceof ApiForbidden) redirect('/app/billing?problem=view_only');
    throw error;
  }
}

export async function buyPack(
  ...args: Parameters<typeof buyPackUnguarded>
): ReturnType<typeof buyPackUnguarded> {
  try {
    return await buyPackUnguarded(...args);
  } catch (error) {
    if (error instanceof ApiForbidden) redirect('/app/billing?problem=view_only');
    throw error;
  }
}
