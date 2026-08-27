'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { closeBooksAction, type CloseBooksState } from './actions';

/**
 * One button, pointed at one month.
 *
 * The month is the one on screen rather than a picker, because the merchant
 * is already looking at the statement they are deciding about. A picker here
 * would let somebody close a month they have not read.
 */
export function CloseBooksForm({
  period,
  label,
  closed,
}: {
  period: string;
  label: string;
  closed: boolean;
}) {
  const [state, action, pending] = useActionState<CloseBooksState, FormData>(closeBooksAction, {});

  return (
    <form action={action}>
      <input type="hidden" name="period" value={period} />
      <input type="hidden" name="intent" value={closed ? 'reopen' : 'close'} />
      {state.confirm ? (
        <input type="hidden" name="confirmationId" value={state.confirm.confirmationId} />
      ) : null}
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
      {state.confirm ? (
        <p className="rk-fineprint" role="alert">
          {state.confirm.consequence}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending
          ? 'Saving…'
          : state.confirm
            ? `Yes, reopen ${label}`
            : closed
              ? `Reopen ${label}`
              : `Close ${label}`}
      </Button>
    </form>
  );
}
