'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { cancelSubscriptionAction, type CancelFormState } from './cancel-actions';

/**
 * The cancel button the terms promised (fix-plan 5, H2a).
 *
 * Inside a disclosure, with the consequences stated BEFORE the button: what
 * stays (every record, readable and exportable), what stops (the next
 * charge), and when (the day already paid to). Cancelling in anger at a
 * surprise is the moment a product's honesty is actually read.
 */
export function CancelForm() {
  const [state, action, pending] = useActionState<CancelFormState, FormData>(
    cancelSubscriptionAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
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
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Cancelling…' : 'Cancel my subscription'}
      </Button>
    </form>
  );
}
