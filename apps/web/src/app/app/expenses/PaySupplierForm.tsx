'use client';

import { useActionState, useState } from 'react';
import { formatKobo } from '@rekoda/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { paySupplierAction, type VoidSpendFormState } from './actions';

export interface OutstandingPurchase {
  expenseId: string;
  description: string;
  purchasedOn: string;
  owedK: number;
}

/**
 * Paying a supplier back.
 *
 * The purchase is chosen, never typed. A settlement that cannot name what it
 * settles is exactly what left the ageing reporting a debt the register said
 * was gone, and picking from a list is what makes the attribution certain
 * rather than hopeful.
 *
 * The amount defaults to what is outstanding, because paying a bill in full is
 * what usually happens and retyping a figure already on screen is how a digit
 * gets dropped. It stays editable: part payments are ordinary.
 */
export function PaySupplierForm({ purchases }: { purchases: OutstandingPurchase[] }) {
  const [state, action, pending] = useActionState<VoidSpendFormState, FormData>(
    paySupplierAction,
    {},
  );
  const [chosen, setChosen] = useState(purchases[0]?.expenseId ?? '');
  const owed = purchases.find((p) => p.expenseId === chosen)?.owedK ?? 0;

  if (purchases.length === 0) {
    return (
      <>
        {/* Same reason as the invoice side: settling the last outstanding
            purchase empties this list, and without the confirmation here the
            merchant is told they owe nothing with no sign their payment
            landed. */}
        {state.done ? (
          <p className="rk-fineprint" role="status">
            {state.done}
          </p>
        ) : null}
        <p className="rk-fineprint">
          You owe nothing on anything you have bought. Purchases you record as unpaid appear here.
        </p>
      </>
    );
  }

  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="expenseId"
        label="What you are paying for"
        error={state.field === 'purchase' ? state.error : undefined}
      >
        <select
          name="expenseId"
          id="expenseId"
          required
          className="rk-input"
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
        >
          {purchases.map((p) => (
            <option key={p.expenseId} value={p.expenseId}>
              {p.purchasedOn} · {p.description} · {formatKobo(p.owedK)} owing
            </option>
          ))}
        </select>
      </Field>

      <Field
        id="amount"
        label="How much you paid"
        hint={`${formatKobo(owed)} is outstanding on this one`}
        error={state.field === 'amount' ? state.error : undefined}
      >
        <input
          name="amount"
          id="amount"
          required
          inputMode="decimal"
          className="rk-input"
          /* Keyed on the choice so switching purchase refills the figure.
             Without the key React keeps the first purchase's amount in a
             field now labelled with a different one. */
          key={chosen}
          defaultValue={(owed / 100).toString()}
        />
      </Field>

      <Field id="method" label="Where it came from">
        <select name="method" id="method" className="rk-input" defaultValue="cash">
          <option value="cash">Cash</option>
          <option value="transfer">Bank transfer</option>
        </select>
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Recording' : 'Record this payment'}
      </Button>
    </form>
  );
}
