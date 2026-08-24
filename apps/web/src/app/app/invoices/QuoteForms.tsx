'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import {
  cancelQuoteAction,
  convertQuoteAction,
  createQuoteAction,
  type QuoteFormState,
} from './actions';

export interface OpenQuote {
  quoteNumber: string;
  label: string;
}

/**
 * Sending a price before the sale (fix-plan 4, G3).
 *
 * Lines are free-typed rather than picked from the catalogue, deliberately:
 * a quote is often for work or goods the shop has never stocked ("sewing,
 * 15k"), and forcing a product row would teach merchants to pollute their
 * catalogue to get a piece of paper out.
 */
export function CreateQuoteForm() {
  const [state, action, pending] = useActionState<QuoteFormState, FormData>(createQuoteAction, {});
  const [rows, setRows] = useState(1);
  /* One key per intention, bumped when a submission settles, so a retried
   * form books once and the NEXT genuine one is never mistaken for it. */
  const [generation, setGeneration] = useState(0);
  const clientRef = useMemo(() => crypto.randomUUID(), [generation]);
  useEffect(() => {
    if (state.done) {
      setGeneration((g) => g + 1);
      setRows(1);
    }
  }, [state]);

  return (
    <form action={action} className="rk-form" noValidate>
      <input type="hidden" name="clientRef" value={clientRef} />
      <Field id="quoteCustomer" label="Who it is for (optional)" error={state.error}>
        <input
          id="quoteCustomer"
          name="customerName"
          className="rk-input"
          placeholder="Ada Obi"
          autoComplete="off"
        />
      </Field>

      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rk-form-row">
          <Field id={`quoteItem${i}`} label="What">
            <input
              id={`quoteItem${i}`}
              name={`itemName${i}`}
              className="rk-input"
              placeholder="Ankara bale"
            />
          </Field>
          <Field id={`quoteQty${i}`} label="How many">
            <input
              id={`quoteQty${i}`}
              name={`itemQty${i}`}
              className="rk-input"
              inputMode="numeric"
              placeholder="2"
            />
          </Field>
          <Field id={`quotePrice${i}`} label="Price each (₦)">
            <input
              id={`quotePrice${i}`}
              name={`itemPrice${i}`}
              className="rk-input"
              inputMode="decimal"
              placeholder="8500"
            />
          </Field>
        </div>
      ))}
      {rows < 20 ? (
        <button
          type="button"
          className="rk-link-button"
          onClick={() => setRows((n) => Math.min(20, n + 1))}
        >
          Add another line
        </button>
      ) : null}

      <Field
        id="quoteValidUntil"
        label="Valid until (optional)"
        hint="After this day the quote cannot be converted, only re-sent."
      >
        <input id="quoteValidUntil" name="validUntil" type="date" className="rk-input" />
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save quote'}
      </Button>
    </form>
  );
}

/** They said yes: the quote becomes the invoice it promised. */
export function ConvertQuoteForm({ quotes }: { quotes: OpenQuote[] }) {
  const [state, action, pending] = useActionState<QuoteFormState, FormData>(convertQuoteAction, {});
  if (quotes.length === 0) {
    return (
      <>
        {state.done ? (
          <p className="rk-fineprint" role="status">
            {state.done}
          </p>
        ) : null}
        <p className="rk-fineprint">No open quotes right now. Saved quotes appear here.</p>
      </>
    );
  }
  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="convertQuoteNumber" label="The quote they accepted" error={state.error}>
        <select id="convertQuoteNumber" name="quoteNumber" className="rk-input" required>
          {quotes.map((quote) => (
            <option key={quote.quoteNumber} value={quote.quoteNumber}>
              {quote.label}
            </option>
          ))}
        </select>
      </Field>
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Issuing…' : 'Convert to invoice'}
      </Button>
    </form>
  );
}

/** Withdraw an offer. Never a delete: what was offered stays on the record. */
export function CancelQuoteForm({ quotes }: { quotes: OpenQuote[] }) {
  const [state, action, pending] = useActionState<QuoteFormState, FormData>(cancelQuoteAction, {});
  if (quotes.length === 0) return null;
  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="cancelQuoteNumber" label="The quote to withdraw" error={state.error}>
        <select id="cancelQuoteNumber" name="quoteNumber" className="rk-input" required>
          {quotes.map((quote) => (
            <option key={quote.quoteNumber} value={quote.quoteNumber}>
              {quote.label}
            </option>
          ))}
        </select>
      </Field>
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} variant="secondary">
        {pending ? 'Withdrawing…' : 'Withdraw quote'}
      </Button>
    </form>
  );
}
