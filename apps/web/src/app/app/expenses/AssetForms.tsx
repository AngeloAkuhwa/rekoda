'use client';

import { useActionState } from 'react';
import { formatKobo } from '@rekoda/core';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { recordAssetAction, withdrawAssetAction, type VoidSpendFormState } from './actions';

export interface OwnedAsset {
  id: string;
  description: string;
  costK: number;
  bookValueK: number;
  status: string;
}

/**
 * Buying something the business keeps.
 *
 * The life is asked in YEARS, not months. A merchant thinks "about five
 * years", and asking for the number already in their head is the difference
 * between a figure they checked and a figure they typed to get past the form.
 *
 * What is paid defaults to the whole cost and stays editable, because taking
 * a freezer partly on credit is ordinary and the remainder belongs on the
 * supplier ageing where the rest of what they owe already lives.
 */
export function RecordAssetForm() {
  const [state, action, pending] = useActionState<VoidSpendFormState, FormData>(
    recordAssetAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="assetDescription"
        label="What you bought"
        hint="A generator, a freezer, a delivery bike, a laptop"
        error={state.error}
      >
        <input
          name="description"
          id="assetDescription"
          required
          minLength={2}
          maxLength={120}
          className="rk-input"
          placeholder="Generator, 5.5kVA"
        />
      </Field>

      <Field id="assetCost" label="What it cost">
        <input
          name="cost"
          id="assetCost"
          required
          inputMode="decimal"
          className="rk-input"
          placeholder="450000"
        />
      </Field>

      <Field
        id="assetPaid"
        label="What you paid now"
        hint="Leave empty if you paid in full. Anything left over goes onto what you owe suppliers"
      >
        <input name="paid" id="assetPaid" inputMode="decimal" className="rk-input" />
      </Field>

      <Field
        id="assetYears"
        label="How many years will you get out of it"
        hint="Your best honest guess. Rekoda spreads the cost evenly across that time"
      >
        <input
          name="years"
          id="assetYears"
          required
          type="number"
          min={1}
          max={12}
          step={1}
          defaultValue={5}
          className="rk-input"
        />
      </Field>

      <Field id="assetMethod" label="How you paid">
        <select name="method" id="assetMethod" className="rk-input" defaultValue="cash">
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
        {pending ? 'Recording' : 'Record this equipment'}
      </Button>
    </form>
  );
}

/**
 * Taking one back out.
 *
 * Deliberately NOT called "sell" or "dispose". Selling equipment is a real
 * event with a gain or a loss against what it is still worth, and Rekoda does
 * not model that yet, so the wording keeps a merchant from reaching for this
 * when they mean a sale and quietly getting the wrong answer.
 */
export function WithdrawAssetForm({ assets }: { assets: OwnedAsset[] }) {
  const [state, action, pending] = useActionState<VoidSpendFormState, FormData>(
    withdrawAssetAction,
    {},
  );
  const removable = assets.filter((a) => a.status === 'recorded');

  if (removable.length === 0) {
    return (
      <>
        {state.done ? (
          <p className="rk-fineprint" role="status">
            {state.done}
          </p>
        ) : null}
        <p className="rk-fineprint">Nothing here to take back out.</p>
      </>
    );
  }

  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="withdrawAssetId" label="Which item" error={state.error}>
        <select name="assetId" id="withdrawAssetId" required className="rk-input" defaultValue="">
          <option value="" disabled>
            Choose an item
          </option>
          {removable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.description} · {formatKobo(a.costK)}
            </option>
          ))}
        </select>
      </Field>

      <Field id="withdrawAssetReason" label="Why" hint="Goes on the record">
        <input
          name="reason"
          id="withdrawAssetReason"
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
        {pending ? 'Taking it out' : 'Take it back out'}
      </Button>
    </form>
  );
}
