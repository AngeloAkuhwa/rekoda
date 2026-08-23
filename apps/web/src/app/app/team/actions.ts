'use server';

import { revalidatePath } from 'next/cache';
import { inviteBusinessMember, removeBusinessMember, viewOnlyRefusal } from '@/server/api';
import { readSessionToken } from '@/server/session-cookies';

/**
 * Inviting and removing, as Server Actions.
 *
 * Neither trusts the form for anything but the phone and the role. WHO is
 * doing it comes from the session cookie this tier holds and is checked again
 * at the API, which is owner-only: a form field naming a business would be a
 * field somebody could edit.
 */
export interface TeamActionState {
  error?: string;
  invited?: string;
}

async function inviteMemberActionUnguarded(
  _previous: TeamActionState,
  form: FormData,
): Promise<TeamActionState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session has ended. Sign in again.' };

  const phone = String(form.get('phone') ?? '').trim();
  const role = form.get('role') === 'delegate' ? 'delegate' : 'accountant';
  if (!phone) return { error: 'Enter the phone number they use for WhatsApp.' };

  const result = await inviteBusinessMember(token, phone, role);
  if (!result.ok) return { error: result.reason };

  revalidatePath('/app/team');
  return { invited: phone };
}

async function removeMemberActionUnguarded(
  _previous: TeamActionState,
  form: FormData,
): Promise<TeamActionState> {
  const token = await readSessionToken();
  if (!token) return { error: 'Your session has ended. Sign in again.' };

  const userId = String(form.get('userId') ?? '');
  if (!userId) return { error: 'Nothing was selected.' };

  await removeBusinessMember(token, userId);
  revalidatePath('/app/team');
  return {};
}

/* Role refusals (403) come back as a sentence in the form, not a crash.
 * Everything else still throws to the error boundary. */

export async function inviteMemberAction(
  ...args: Parameters<typeof inviteMemberActionUnguarded>
): ReturnType<typeof inviteMemberActionUnguarded> {
  try {
    return await inviteMemberActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof inviteMemberActionUnguarded>>;
  }
}

export async function removeMemberAction(
  ...args: Parameters<typeof removeMemberActionUnguarded>
): ReturnType<typeof removeMemberActionUnguarded> {
  try {
    return await removeMemberActionUnguarded(...args);
  } catch (error) {
    return viewOnlyRefusal(error) as Awaited<ReturnType<typeof removeMemberActionUnguarded>>;
  }
}
