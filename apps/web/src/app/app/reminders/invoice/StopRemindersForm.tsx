'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { stopRemindersAction, type SimpleFormState } from '../actions';

/** Stop every reminder for one invoice, scheduled ones included, or turn them back on. */
export function StopRemindersForm({
  invoiceNumber,
  stopped,
}: {
  invoiceNumber: string;
  stopped: boolean;
}) {
  const [state, action, pending] = useActionState<SimpleFormState, FormData>(
    stopRemindersAction,
    {},
  );
  return (
    <form action={action} className="rk-form" noValidate>
      <input type="hidden" name="invoiceNumber" value={invoiceNumber} />
      <input type="hidden" name="stopped" value={stopped ? 'false' : 'true'} />
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
      <div>
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving…' : stopped ? 'Resume reminders' : 'Stop reminders for this invoice'}
        </Button>
      </div>
    </form>
  );
}
