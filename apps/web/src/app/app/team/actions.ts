'use server';

import { revalidatePath } from 'next/cache';
import { inviteBusinessMember, removeBusinessMember } from '@/server/api';
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

export async function inviteMemberAction(
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

export async function removeMemberAction(
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
