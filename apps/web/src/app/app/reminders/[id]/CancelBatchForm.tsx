'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cancelBatchAction, type CancelFormState } from '../actions';
import styles from '../reminders.module.css';

/**
 * Cancelling a batch before it goes. Two presses: the first names what will happen in the
 * merchant's terms, the second does it. Reminders already sent are not unsent, and the screen
 * says so rather than implying anything was taken back.
 */
export function CancelBatchForm({
  batchId,
  pending,
  cancellable,
}: {
  batchId: string;
  pending: number;
  /** Still scheduled with something waiting. Stays mounted after a cancel so its answer shows. */
  cancellable: boolean;
}) {
  const [state, action, cancelling] = useActionState<CancelFormState, FormData>(
    cancelBatchAction,
    {},
  );
  const [asking, setAsking] = useState(false);

  if (state.done) {
    return (
      <p className="rk-fineprint" role="status">
        {state.done}
      </p>
    );
  }
  if (!cancellable) return null;

  return (
    <form action={action} className="rk-form" noValidate>
      <input type="hidden" name="batchId" value={batchId} />
      {asking ? (
        <p className={styles.note} role="alert">
          Stop the {pending === 1 ? 'reminder' : `${pending} reminders`} not sent yet? Customers
          already reminded have their message already; this does not take it back.
        </p>
      ) : null}
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      {/* Each button keyed, never sharing a DOM node: a `type="button"` reused as the
          `type="submit"` during its own click makes the browser submit the form, which cancelled
          the batch on the FIRST press before this was keyed. */}
      <div className={styles.actions}>
        {asking ? (
          <Button key="yes" type="submit" disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Yes, cancel them'}
          </Button>
        ) : null}
        {asking ? (
          <Button key="keep" type="button" variant="secondary" onClick={() => setAsking(false)}>
            Keep them
          </Button>
        ) : (
          <Button key="ask" type="button" variant="secondary" onClick={() => setAsking(true)}>
            Cancel the reminders not sent yet
          </Button>
        )}
      </div>
    </form>
  );
}
