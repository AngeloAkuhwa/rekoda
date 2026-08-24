'use client';

import { useActionState, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import {
  cancelPurchaseOrderAction,
  createPurchaseOrderAction,
  receivePurchaseOrderAction,
  type PurchaseOrderFormState,
} from './actions';

export interface OpenPurchaseOrder {
  poNumber: string;
  label: string;
}

/**
 * Asking a supplier for goods (fix-plan 4, G4).
 *
 * Lines are free-typed, like a quote's: a thing being ordered by the crate
 * may never have been counted before, and it becomes a counted product the
 * day it lands, not the day it is asked for. No supplier field anywhere,
 * because Rekoda stores nothing about suppliers.
 */
export function CreatePurchaseOrderForm() {
  const [state, action, pending] = useActionState<PurchaseOrderFormState, FormData>(
    createPurchaseOrderAction,
    {},
  );
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
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}

      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="rk-form-row">
          <Field id={`poItem${i}`} label="What">
            <input
              id={`poItem${i}`}
              name={`itemName${i}`}
              className="rk-input"
              placeholder="Ankara bale"
            />
          </Field>
          <Field id={`poQty${i}`} label="How many">
            <input
              id={`poQty${i}`}
              name={`itemQty${i}`}
              className="rk-input"
              inputMode="numeric"
              placeholder="10"
            />
          </Field>
          <Field id={`poPrice${i}`} label="Cost each (₦)">
            <input
              id={`poPrice${i}`}
              name={`itemPrice${i}`}
              className="rk-input"
              inputMode="decimal"
              placeholder="5000"
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
        id="poExpectedOn"
        label="Expected by (optional)"
        hint="The day the goods should land. The list shows it so late deliveries stand out."
      >
        <input id="poExpectedOn" name="expectedOn" type="date" className="rk-input" />
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save purchase order'}
      </Button>
    </form>
  );
}

/** The goods landed: stock comes in, what was not paid is owed. */
export function ReceivePurchaseOrderForm({ orders }: { orders: OpenPurchaseOrder[] }) {
  const [state, action, pending] = useActionState<PurchaseOrderFormState, FormData>(
    receivePurchaseOrderAction,
    {},
  );
  if (orders.length === 0) {
    return (
      <>
        {state.done ? (
          <p className="rk-fineprint" role="status">
            {state.done}
          </p>
        ) : null}
        <p className="rk-fineprint">No open purchase orders right now. Saved ones appear here.</p>
      </>
    );
  }
  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="receivePoNumber" label="The order that arrived" error={state.error}>
        <select id="receivePoNumber" name="poNumber" className="rk-input" required>
          {orders.map((order) => (
            <option key={order.poNumber} value={order.poNumber}>
              {order.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="receivePaid"
        label="Paid so far (₦)"
        hint="Leave empty for nothing yet. The rest goes onto what you owe suppliers."
      >
        <input
          id="receivePaid"
          name="paid"
          className="rk-input"
          inputMode="decimal"
          placeholder="0"
        />
      </Field>
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Recording…' : 'Mark received'}
      </Button>
    </form>
  );
}

/** Withdraw an ask. Never a delete: what was ordered stays on the record. */
export function CancelPurchaseOrderForm({ orders }: { orders: OpenPurchaseOrder[] }) {
  const [state, action, pending] = useActionState<PurchaseOrderFormState, FormData>(
    cancelPurchaseOrderAction,
    {},
  );
  if (orders.length === 0) return null;
  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="cancelPoNumber" label="The order to withdraw" error={state.error}>
        <select id="cancelPoNumber" name="poNumber" className="rk-input" required>
          {orders.map((order) => (
            <option key={order.poNumber} value={order.poNumber}>
              {order.label}
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
        {pending ? 'Withdrawing…' : 'Withdraw order'}
      </Button>
    </form>
  );
}
