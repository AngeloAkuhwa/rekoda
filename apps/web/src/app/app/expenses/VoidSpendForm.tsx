'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { voidExpenseAction, type VoidSpendFormState } from './actions';

export interface VoidableEntry {
  id: string;
  label: string;
}

/**
 * Withdrawing a spend entry, from the register where the merchant noticed.
 *
 * Not a button on every row, same as the invoice register: a reversal is rare
 * and permanent, and a control beside each line invites the tap it exists to
 * prevent. The merchant picks the entry they mean and says why.
 */
export function VoidSpendForm({ entries }: { entries: VoidableEntry[] }) {
  const [state, action, pending] = useActionState<VoidSpendFormState, FormData>(
    voidExpenseAction,
    {},
  );

  if (entries.length === 0) {
    return (
      <p className="rk-fineprint">
        Nothing here to withdraw. Every entry on this page has already been reversed.
      </p>
    );
  }

  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="expenseId" label="Entry to withdraw" error={state.error}>
        <select name="expenseId" id="expenseId" required className="rk-input" defaultValue="">
          <option value="" disabled>
            Choose an entry
          </option>
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </Field>

      <Field id="reason" label="Why" hint="Goes on the record, so the reversal is explained">
        <input
          name="reason"
          id="reason"
          required
          minLength={4}
          maxLength={200}
          className="rk-input"
          placeholder="recorded twice"
        />
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Withdrawing…' : 'Withdraw this entry'}
      </Button>
    </form>
  );
}
