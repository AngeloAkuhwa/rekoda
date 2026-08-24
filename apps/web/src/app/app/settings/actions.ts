'use server';

import { revalidatePath } from 'next/cache';
import { updateBusinessSettings, viewOnlyRefusal } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

export interface SettingsFormState {
  error?: string;
  done?: string;
}

/**
 * The facts a business may correct about itself (fix-plan 5, H2a).
 *
 * The name lands on invoices, receipts and statements from the next document
 * on; nothing already issued is rewritten, because a document is what it
 * said on the day it was issued.
 */
async function saveSettingsActionUnguarded(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session expired. Sign in again.' };

  const name = String(formData.get('name') ?? '').trim();
  const rcNumber = String(formData.get('rcNumber') ?? '').trim();
  const tin = String(formData.get('tin') ?? '').trim();
  if (name.length < 2 || name.length > 80) {
    return { error: 'The business name is 2 to 80 characters.' };
  }
  if (rcNumber.length > 20 || tin.length > 20) {
    return { error: 'CAC numbers and TINs are at most 20 characters.' };
  }

  const outcome = await updateBusinessSettings(token, { name, rcNumber, tin });
  if (!outcome) return { error: 'That did not go through. Nothing was changed.' };

  revalidatePath('/app/settings');
  revalidatePath('/app');
  return {
    done: `Saved. New documents will say ${outcome.name}; everything already issued keeps the name it was issued under.`,
  };
}

export async function saveSettingsAction(
  ...args: Parameters<typeof saveSettingsActionUnguarded>
): ReturnType<typeof saveSettingsActionUnguarded> {
  try {
    return await saveSettingsActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof saveSettingsActionUnguarded>>;
  }
}
