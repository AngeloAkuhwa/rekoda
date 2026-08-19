'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { signOutAction } from './actions';

export function SignOutButton() {
  const [, action, pending] = useActionState<void, FormData>(signOutAction, undefined);
  return (
    <form action={action}>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
    </form>
  );
}
