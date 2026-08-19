'use client';

import { useActionState } from 'react';
import { signOutAction } from './actions';

export function SignOutButton() {
  const [, action, pending] = useActionState<void, FormData>(signOutAction, undefined);
  return (
    <form action={action}>
      <button type="submit" className="rk-signout" disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
    </form>
  );
}
