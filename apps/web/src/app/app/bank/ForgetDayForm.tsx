'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { forgetDayAction, type StatementState } from './actions';

/**
 * Undo a day.
 *
 * A whole day rather than one line, because that is the unit a person can
 * picture and because the mistake this exists for is uploading the wrong
 * account's statement, which is never one line.
 */
export function ForgetDayForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState<StatementState, FormData>(forgetDayAction, {});

  return (
    <form action={action} className="rk-form">
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
      <label className="rk-inline-field" htmlFor="postedOn">
        <span>Day to remove</span>
        <input type="date" name="postedOn" id="postedOn" max={today} className="rk-input" />
      </label>
      <Button type="submit" disabled={pending}>
        {pending ? 'Removing' : 'Remove that day'}
      </Button>
    </form>
  );
}
