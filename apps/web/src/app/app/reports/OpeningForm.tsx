'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { openBooksAction, type OpeningFormState } from './actions';

/**
 * What the business was already holding, asked once.
 *
 * Three boxes and a date, and every one of them optional except the date. A
 * merchant with nothing in the bank should be able to leave that box alone;
 * being made to type 0 into a form is how people learn to distrust forms.
 *
 * There is deliberately no box for what customers owe. An opening figure for
 * that has no invoice behind it, so the debtors page and the ledger would
 * hold two different answers and neither could be chased. The hint says so,
 * because a merchant looking for the box needs to know where it went rather
 * than to conclude Rekoda forgot.
 */
export function OpeningForm({ today }: { today: string }) {
  const [state, action, pending] = useActionState<OpeningFormState, FormData>(openBooksAction, {});

  return (
    <form action={action} className="rk-form" noValidate>
      {/* The form's own alert, not the date field's: a refusal here is as
          often about an amount, and rendering it under the date blamed the
          one answer the merchant got right. */}
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      <Field
        id="asAt"
        label="The day these figures were true"
        hint="Usually the day before you started using Rekoda"
      >
        <input type="date" name="asAt" id="asAt" required max={today} className="rk-input" />
      </Field>

      <Field
        id="cash"
        label="Cash in hand"
        hint="In the till and in your pocket. Leave empty for none"
      >
        <input
          name="cash"
          id="cash"
          inputMode="decimal"
          className="rk-input"
          placeholder="200000"
        />
      </Field>

      <Field id="bank" label="Money in the bank" hint="Your business account balance that day">
        <input
          name="bank"
          id="bank"
          inputMode="decimal"
          className="rk-input"
          placeholder="450000"
        />
      </Field>

      <Field
        id="stock"
        label="Stock on the shelf, at what it cost you"
        hint="What you paid for it, not what you will sell it for"
      >
        <input
          name="stock"
          id="stock"
          inputMode="decimal"
          className="rk-input"
          placeholder="150000"
        />
      </Field>

      <p className="rk-fineprint">
        Money customers already owe you is not here. Enter those as invoices, so you can chase them
        and so they show on one list rather than two.
      </p>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Opening…' : 'Open my books'}
      </Button>
    </form>
  );
}
