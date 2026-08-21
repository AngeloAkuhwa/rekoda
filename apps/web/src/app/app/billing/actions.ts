'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { billingBuyPack, billingChangePlan } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

/**
 * Confirm a plan change the merchant has already been quoted.
 *
 * Two steps on purpose: the page shows the figure, and this only runs once
 * they have seen it. A one-click switch that charges is how somebody is
 * surprised by a bill, and it is the one surprise a bookkeeping product
 * cannot afford.
 */
export async function confirmPlanChange(formData: FormData): Promise<void> {
  const token = await readSessionToken();
  if (!token) redirect('/start');

  const plan = String(formData.get('plan') ?? '');
  const answer = await billingChangePlan(token, plan);
  revalidatePath('/app/billing');

  if (!answer) redirect('/app/billing?problem=plan');
  if (answer.state === 'scheduled') redirect('/app/billing?done=scheduled');
  if (answer.state === 'payment_required') {
    redirect(`/app/billing?pay=${encodeURIComponent(answer.reference)}`);
  }
  redirect(`/app/billing?problem=${encodeURIComponent(answer.reason)}`);
}

export async function buyPack(formData: FormData): Promise<void> {
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
