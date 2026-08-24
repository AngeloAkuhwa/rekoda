'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { creditInvoiceAction, type CreditFormState } from './actions';

export interface CreditableInvoice {
  invoiceNumber: string;
  /** What is left to credit, in kobo. Never more than this. */
  creditableK: number;
  label: string;
}

/**
 * Crediting an invoice, from the register where the merchant noticed.
 *
 * Separate from the void on purpose, because they are separate instruments:
 * the void withdraws a sale that should not have happened, this reduces one
 * that did. Only invoices money has arrived against are offered here, and only
 * unpaid ones are offered to the void, so a merchant never has to work out
 * which control they want.
 */
export function CreditForm({ invoices }: { invoices: CreditableInvoice[] }) {
  const [state, action, pending] = useActionState<CreditFormState, FormData>(
    creditInvoiceAction,
    {},
  );
  /* One key per intention, bumped when a submission settles, so a retried
   * form books once and the NEXT genuine one is never mistaken for it. */
  const [generation, setGeneration] = useState(0);
  const clientRef = useMemo(() => crypto.randomUUID(), [generation]);
  useEffect(() => {
    if (state.done) setGeneration((g) => g + 1);
  }, [state]);

  if (invoices.length === 0) {
    return (
      <p className="rk-fineprint">
        Nothing here to credit. A credit note reduces an invoice a customer has already paid
        something against, and none of these have money on them yet. Use the void above instead.
      </p>
    );
  }

  return (
    <form action={action} className="rk-form" noValidate>
      <input type="hidden" name="clientRef" value={clientRef} />
      <Field id="creditInvoiceNumber" label="Invoice to credit" error={state.error}>
        <select
          name="invoiceNumber"
          id="creditInvoiceNumber"
          required
          className="rk-input"
          defaultValue=""
        >
          <option value="" disabled>
            Choose an invoice
          </option>
          {invoices.map((invoice) => (
            <option key={invoice.invoiceNumber} value={invoice.invoiceNumber}>
              {invoice.label}
            </option>
          ))}
        </select>
      </Field>

      <Field
        id="creditAmount"
        label="How much to credit"
        hint="In naira. Never more than the invoice was worth"
      >
        <input
          name="amount"
          id="creditAmount"
          type="text"
          inputMode="decimal"
          required
          className="rk-input"
          placeholder="5000"
        />
      </Field>

      <Field id="creditReason" label="Why" hint="Goes on the credit note and on the record">
        <input
          name="reason"
          id="creditReason"
          required
          minLength={4}
          maxLength={200}
          className="rk-input"
          placeholder="one wig returned"
        />
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Issuing…' : 'Issue credit note'}
      </Button>
    </form>
  );
}
