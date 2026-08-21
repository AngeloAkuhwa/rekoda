'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { voidInvoiceAction, type VoidFormState } from './actions';

/**
 * Withdrawing an invoice, from the register where the merchant noticed.
 *
 * Not a button on every row. A void is rare and irreversible, and a control
 * sitting beside each line invites the tap it exists to prevent, so the
 * merchant types the number they mean. The reason is required because the
 * number sequence stays dense: an unexplained gap is what an auditor reads as
 * a deleted invoice.
 */
export function VoidForm({ voidable }: { voidable: string[] }) {
  const [state, action, pending] = useActionState<VoidFormState, FormData>(voidInvoiceAction, {});

  if (voidable.length === 0) {
    return (
      <p className="rk-fineprint">
        Nothing here can be voided. An invoice with money against it is corrected by refunding the
        customer and recording the refund, so the books keep both halves of what happened.
      </p>
    );
  }

  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="invoiceNumber" label="Invoice to void" error={state.error}>
        <select
          name="invoiceNumber"
          id="invoiceNumber"
          required
          className="rk-input"
          defaultValue=""
        >
          <option value="" disabled>
            Choose an invoice
          </option>
          {voidable.map((number) => (
            <option key={number} value={number}>
              {number}
            </option>
          ))}
        </select>
      </Field>

      <Field id="reason" label="Why" hint="Goes on the record, so the gap is explained">
        <input
          name="reason"
          id="reason"
          required
          minLength={4}
          maxLength={200}
          className="rk-input"
          placeholder="wrong customer"
        />
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Voiding' : 'Void this invoice'}
      </Button>
    </form>
  );
}
