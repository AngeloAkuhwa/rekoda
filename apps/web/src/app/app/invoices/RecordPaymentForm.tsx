'use client';

import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { formatKobo, parseAmountText, toKobo } from '@rekoda/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { recordPaymentAction, type VoidFormState } from './actions';

export interface PayableInvoice {
  invoiceNumber: string;
  balanceDueK: number;
}

/** A balance as the figure the amount field starts from, in naira. */
const nairaText = (balanceK: number) => (balanceK / 100).toString();

/** What the amount field currently says, in kobo, or null if it says nothing usable. */
function typedKobo(text: string): number | null {
  const naira = parseAmountText(text);
  if (naira === null) return null;
  try {
    return toKobo(naira);
  } catch {
    return null;
  }
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
  /**
   * The amount and the method are CONTROLLED, never `defaultValue` (G-49).
   *
   * React resets an uncontrolled form after its server action returns. When
   * that return was the overpayment question, the reset put the balance back
   * in the amount and "cash" back in the method while the question still
   * named what the merchant typed, so "Yes, record it" sent the balance: an
   * ordinary payment, and the excess silently gone. Held in state, what the
   * merchant entered is exactly what the confirmation shows and submits. The
   * amount is refilled from a balance only when the merchant picks another
   * invoice, or once a payment has committed.
   */
  const [amount, setAmount] = useState(() => nairaText(invoices[0]?.balanceDueK ?? 0));
  const [method, setMethod] = useState<'cash' | 'transfer'>('cash');
  const balanceOf = (invoiceNumber: string) =>
    invoices.find((i) => i.invoiceNumber === invoiceNumber)?.balanceDueK ?? 0;
  /* A question the merchant has moved away from (another invoice, another
   * method) is closed: coming back to the same figures asks again rather
   * than re-arming a yes to a question about a different payment. */
  const [dismissed, setDismissed] = useState<VoidFormState['overpayment'] | null>(null);
  const choose = (invoiceNumber: string) => {
    if (state.overpayment) setDismissed(state.overpayment);
    setChosen(invoiceNumber);
    setAmount(nairaText(balanceOf(invoiceNumber)));
  };
  /**
   * One key per PAYMENT, not per mounted form.
   *
   * A resubmission of the same payment (a dropped response, an impatient
   * second press) must carry the same key so the server books nothing twice.
   * But after a payment COMMITS, the page revalidates in place without
   * remounting, so a stable-per-mount key made the merchant's NEXT, genuine
   * payment reuse it — the server saw the same rekoda_reference and answered
   * "already recorded", silently dropping real cash. The key is bumped the
   * moment a submission settles (recorded OR duplicate), so the next payment
   * is a fresh intention; an error leaves it, so a corrected retry keeps it,
   * except a balance refusal (`freshKey`), whose answer may already be
   * recorded against the key: the retry after it is a new intention (G-49).
   */
  const [generation, setGeneration] = useState(0);
  const clientRef = useMemo(() => crypto.randomUUID(), [generation]);
  useEffect(() => {
    if (state.done || state.freshKey) setGeneration((g) => g + 1);
  }, [state]);
  /* A committed payment starts the next one afresh, from the revalidated
   * balances: the same invoice if it still owes, else the first that does.
   * Once per answer, so it never overwrites what the merchant types next. */
  const settled = useRef<VoidFormState | null>(null);
  useEffect(() => {
    if (!state.done || settled.current === state) return;
    settled.current = state;
    const next = invoices.find((i) => i.invoiceNumber === chosen) ?? invoices[0];
    if (next) {
      setChosen(next.invoiceNumber);
      setAmount(nairaText(next.balanceDueK));
    }
    setMethod('cash');
  }, [state, invoices, chosen]);
  /* The list changes under the form (an invoice paid off, a quote just
   * converted): a choice no longer offered moves to the first that is, with
   * its balance, rather than pointing at an invoice the select cannot show. */
  useEffect(() => {
    const first = invoices[0];
    if (first && !invoices.some((i) => i.invoiceNumber === chosen)) {
      setChosen(first.invoiceNumber);
      setAmount(nairaText(first.balanceDueK));
    }
  }, [invoices, chosen]);
  const owed = balanceOf(chosen);
  /* The question stands only for the invoice, the amount and the method it
   * was asked about. A change is a new payment: the button says so and no
   * confirmation is sent, so the server asks again (the action checks the
   * invoice and amount too, and the balance under lock). */
  const asking =
    state.overpayment !== undefined &&
    state.overpayment !== dismissed &&
    state.overpayment.invoiceNumber === chosen &&
    typedKobo(amount) === state.overpayment.amountK
      ? state.overpayment
      : null;

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
    <form
      action={action}
      /* Dispatched here rather than by React's form action, which resets the
         form after every answer: a controlled select is put back to the
         option it first rendered with, so the method the merchant chose
         became cash again under the overpayment question (G-49). The action
         prop stays for a browser without JavaScript. */
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => action(data));
      }}
      className="rk-form"
      noValidate
    >
      <input type="hidden" name="clientRef" value={clientRef} />
      <Field id="payInvoiceNumber" label="What the money was for" error={state.error}>
        <select
          name="invoiceNumber"
          id="payInvoiceNumber"
          required
          className="rk-input"
          value={chosen}
          onChange={(e) => choose(e.target.value)}
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
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>

      <Field id="payMethod" label="How it came in">
        <select
          name="method"
          id="payMethod"
          className="rk-input"
          value={method}
          onChange={(e) => {
            if (state.overpayment) setDismissed(state.overpayment);
            setMethod(e.target.value === 'transfer' ? 'transfer' : 'cash');
          }}
        >
          <option value="cash">Cash</option>
          <option value="transfer">Bank transfer</option>
        </select>
      </Field>

      {/* An overpayment is asked about before anything is saved (G-49).
          The second submit carries the figures that were shown, only while
          the form still says them; the action drops them too if the amount
          or invoice was changed since. */}
      {asking ? (
        <>
          <input type="hidden" name="confirmOverpayment" value="1" />
          <input type="hidden" name="expectedBalanceK" value={asking.expectedBalanceK} />
          <input type="hidden" name="confirmedAmountK" value={asking.amountK} />
          <input type="hidden" name="confirmedInvoiceNumber" value={asking.invoiceNumber} />
          <p className="rk-fineprint" role="alert">
            {asking.consequence}
          </p>
        </>
      ) : null}

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Recording…' : asking ? 'Yes, record it' : 'Record this payment'}
      </Button>
    </form>
  );
}
