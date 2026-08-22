'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { reconcileAction, type StatementState } from './actions';

/**
 * One button, because there is nothing to decide yet.
 *
 * A page load never pairs anything: pairing is a write, and a merchant
 * should be the one who asks for it. What it does is offered plainly, and
 * what it refuses to do is the more important half.
 */
export function ReconcileForm({ pairable }: { pairable: number }) {
  const [state, action, pending] = useActionState<StatementState, FormData>(reconcileAction, {});

  return (
    <form action={action}>
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending || pairable === 0}>
        {pending
          ? 'Matching'
          : pairable === 0
            ? 'Nothing Rekoda can match on its own'
            : `Match ${pairable === 1 ? 'the 1 line' : `these ${pairable} lines`}`}
      </Button>
    </form>
  );
}
