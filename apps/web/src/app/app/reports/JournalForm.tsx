'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { ACCOUNT_PICKER_LABELS, type AccountKey } from '@rekoda/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { journalAction, type JournalState } from './actions';

/**
 * A correction, in the words a trader would use.
 *
 * One amount out of somewhere and into somewhere else. That is the whole of
 * double entry stated without the vocabulary, and it is also why nothing here
 * can be made not to balance: there is one figure, and it appears on both
 * sides because the posting builder puts it there.
 *
 * The accounts read as things rather than as ledger lines. "Money in the
 * bank" is what a merchant would say; "Bank (Paystack)" is what the statement
 * prints. Both are true and the dropdown gets the spoken one.
 */
const OPTIONS = Object.entries(ACCOUNT_PICKER_LABELS) as [AccountKey, string][];

export function JournalForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState<JournalState, FormData>(journalAction, {});
  /* One key per intention, bumped when a submission settles, so a retried
   * form books once and the NEXT genuine one is never mistaken for it. */
  const [generation, setGeneration] = useState(0);
  const clientRef = useMemo(() => crypto.randomUUID(), [generation]);
  useEffect(() => {
    if (state.done) setGeneration((g) => g + 1);
  }, [state]);

  return (
    <form action={action} className="rk-form" noValidate>
      <input type="hidden" name="clientRef" value={clientRef} />
      <Field
        id="amount"
        label="How much"
        hint="In naira. For example 50000, or 50k"
        error={state.error}
      >
        <input
          name="amount"
          id="amount"
          inputMode="decimal"
          className="rk-input"
          placeholder="50000"
        />
      </Field>

      <Field id="outOf" label="Out of" hint="Where the money left">
        <select name="outOf" id="outOf" className="rk-input" defaultValue="CASH">
          {OPTIONS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field id="into" label="Into" hint="Where it ended up">
        <select name="into" id="into" className="rk-input" defaultValue="BANK_PAYSTACK">
          {OPTIONS.map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </Field>

      <Field id="memo" label="What this is for" hint="You will read this back in a year">
        <input
          name="memo"
          id="memo"
          className="rk-input"
          maxLength={200}
          placeholder="Took the day's takings to the bank"
        />
      </Field>

      <Field id="occurredOn" label="The day it happened" hint="Leave empty for today">
        <input type="date" name="occurredOn" id="occurredOn" max={today} className="rk-input" />
      </Field>

      <p className="rk-fineprint">
        This writes both sides for you, so it always balances. It shows on your statements like any
        other entry and it is marked in your audit trail as one you wrote yourself.
      </p>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Recording…' : 'Record this correction'}
      </Button>
    </form>
  );
}
