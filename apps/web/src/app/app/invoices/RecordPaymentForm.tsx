'use client';

import { useActionState, useState } from 'react';
import { formatKobo } from '@rekoda/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { recordPaymentAction, type VoidFormState } from './actions';

export interface PayableInvoice {
  invoiceNumber: string;
  balanceDueK: number;
}

/**
 * Recording money that came in, from the register where the merchant is
 * already looking at what they are owed.
 *
 * Only invoices with something still owing are offered, so a merchant never
 * picks one that will be refused. The amount defaults to the balance, because
 * paying an invoice off is the ordinary case and retyping a figure already on
 * screen is how a digit gets dropped.
 *
 * Nothing here names a customer. The register does not carry one and neither
 * does this: an invoice number is what a merchant reads and what a receipt is
 * matched against.
 */
export function RecordPaymentForm({ invoices }: { invoices: PayableInvoice[] }) {
  const [state, action, pending] = useActionState<VoidFormState, FormData>(recordPaymentAction, {});
  const [chosen, setChosen] = useState(invoices[0]?.invoiceNumber ?? '');
  const owed = invoices.find((i) => i.invoiceNumber === chosen)?.balanceDueK ?? 0;

  if (invoices.length === 0) {
    return (
      <>
        {/* The confirmation FIRST, and it is not decoration. Paying off the
            last outstanding invoice empties this list, so without it a
            merchant clicks Record, watches the form vanish, and is told
            nothing is owed with no receipt number and no proof anything
            happened. The one moment they most need the answer is the one
            that swallowed it. */}
        {state.done ? (
          <p className="rk-fineprint" role="status">
            {state.done}
          </p>
        ) : null}
        <p className="rk-fineprint">
          Nothing is owed to you right now. Invoices with money still outstanding appear here.
        </p>
      </>
    );
  }

  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="payInvoiceNumber" label="What the money was for" error={state.error}>
        <select
          name="invoiceNumber"
          id="payInvoiceNumber"
          required
          className="rk-input"
          value={chosen}
          onChange={(e) => setChosen(e.target.value)}
        >
          {invoices.map((i) => (
            <option key={i.invoiceNumber} value={i.invoiceNumber}>
              {i.invoiceNumber} · {formatKobo(i.balanceDueK)} owing
            </option>
          ))}
        </select>
      </Field>

      <Field
        id="payAmount"
        label="How much came in"
        hint={`${formatKobo(owed)} is outstanding on this one`}
      >
        <input
          name="amount"
          id="payAmount"
          required
          inputMode="decimal"
          className="rk-input"
          /* Keyed on the choice so switching invoice refills the figure.
             Without the key React keeps the first invoice's amount in a
             field now labelled with a different one. */
          key={chosen}
          defaultValue={(owed / 100).toString()}
        />
      </Field>

      <Field id="payMethod" label="How it came in">
        <select name="method" id="payMethod" className="rk-input" defaultValue="cash">
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
