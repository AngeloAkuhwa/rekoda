'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import {
  createProductAction,
  renameProductAction,
  setDescriptionAction,
  setCostAction,
  setPriceAction,
  setProductListedAction,
  uploadProductImageAction,
  type CatalogueFormState,
} from './actions';

export interface Choice {
  id: string;
  label: string;
}

/**
 * A product picker, rich enough to choose from.
 *
 * The label carries the price and the count as well as the name, because two
 * products called something similar is the ordinary case in a shop and a list
 * of bare names is a coin toss. Same reasoning as the withdraw control on the
 * spend register.
 */
function ProductPicker({
  id,
  choices,
  error,
}: {
  id: string;
  choices: Choice[];
  error?: string | undefined;
}) {
  return (
    <Field id={id} label="Product" error={error}>
      <select name="id" id={id} required className="rk-input" defaultValue="">
        <option value="" disabled>
          Choose a product
        </option>
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Result({ state }: { state: CatalogueFormState }) {
  if (!state.done) return null;
  return (
    <p className="rk-fineprint" role="status">
      {state.done}
    </p>
  );
}

export function SetPriceForm({ choices }: { choices: Choice[] }) {
  const [state, action, pending] = useActionState<CatalogueFormState, FormData>(setPriceAction, {});

  return (
    <form action={action} className="rk-form" noValidate>
      <ProductPicker id="price-product" choices={choices} error={state.error} />
      <Field id="price" label="What it sells for" hint="In naira. 8500, or 8.5k">
        <input name="price" id="price" required className="rk-input" placeholder="8500" />
      </Field>
      <Result state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save this price'}
      </Button>
    </form>
  );
}

/**
 * What one of them costs the merchant.
 *
 * Beside the price and deliberately not merged with it: what something sells
 * for and what it cost are different facts, and a shop that reads one as the
 * other reads a profit that is not there.
 */
export function SetCostForm({ choices }: { choices: Choice[] }) {
  const [state, action, pending] = useActionState<CatalogueFormState, FormData>(setCostAction, {});

  return (
    <form action={action} className="rk-form" noValidate>
      <ProductPicker id="cost-product" choices={choices} error={state.error} />
      <Field
        id="cost"
        label="What one costs you"
        hint="In naira, what you pay for it. Recording a purchase sets this on its own"
      >
        <input name="cost" id="cost" required className="rk-input" placeholder="4500" />
      </Field>
      <Result state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save this cost'}
      </Button>
    </form>
  );
}

export function SetDescriptionForm({ choices }: { choices: Choice[] }) {
  const [state, action, pending] = useActionState<CatalogueFormState, FormData>(
    setDescriptionAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
      <ProductPicker id="description-product" choices={choices} error={state.error} />
      <Field
        id="description"
        label="What it is"
        hint="Your words, what a customer would want to know. Leave it empty to clear it"
      >
        <textarea
          name="description"
          id="description"
          maxLength={400}
          rows={3}
          className="rk-input"
          placeholder="Six yards, wax print, sold by the bale"
        />
      </Field>
      <Result state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save this description'}
      </Button>
    </form>
  );
}

export function UploadPhotoForm({ choices, maxBytes }: { choices: Choice[]; maxBytes: number }) {
  const [state, action, pending] = useActionState<CatalogueFormState, FormData>(
    uploadProductImageAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
      <ProductPicker id="photo-product" choices={choices} error={state.error} />
      <Field
        id="photo"
        label="Photo"
        hint={`JPEG, PNG or WEBP, up to ${Math.round(maxBytes / (1024 * 1024))} MB`}
      >
        {/* `capture` is absent on purpose: it would force the camera and stop
            a merchant choosing the photo they already took. */}
        <input
          name="photo"
          id="photo"
          type="file"
          required
          accept="image/jpeg,image/png,image/webp"
          className="rk-input"
        />
      </Field>
      <Result state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Sending…' : 'Save this photo'}
      </Button>
    </form>
  );
}

export function ListingForm({ choices }: { choices: Choice[] }) {
  const [state, action, pending] = useActionState<CatalogueFormState, FormData>(
    setProductListedAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
      <ProductPicker id="listing-product" choices={choices} error={state.error} />
      <Field id="active" label="In the shop">
        <select name="active" id="active" className="rk-input" defaultValue="hide">
          <option value="hide">Take it out of the shop</option>
          <option value="list">Put it back in the shop</option>
        </select>
      </Field>
      <Result state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save this change'}
      </Button>
    </form>
  );
}

/** A new product, typed rather than mentioned (fix-plan 5, H2c). */
export function CreateProductForm() {
  const [state, action, pending] = useActionState<CatalogueFormState, FormData>(
    createProductAction,
    {},
  );
  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="newProductName" label="What it is" error={state.error}>
        <input
          id="newProductName"
          name="name"
          className="rk-input"
          placeholder="Ankara bale"
          maxLength={80}
          required
        />
      </Field>
      <Field
        id="newProductPrice"
        label="Price each (₦, optional)"
        hint="Leave empty to price it later. Only priced, listed products appear in your shop."
      >
        <input
          id="newProductPrice"
          name="price"
          className="rk-input"
          inputMode="decimal"
          placeholder="8500"
        />
      </Field>
      <Result state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add product'}
      </Button>
    </form>
  );
}

/** Fix a typo without splitting the product's history. */
export function RenameProductForm({ choices }: { choices: Choice[] }) {
  const [state, action, pending] = useActionState<CatalogueFormState, FormData>(
    renameProductAction,
    {},
  );
  return (
    <form action={action} className="rk-form" noValidate>
      <ProductPicker id="renameProduct" choices={choices} error={state.error} />
      <Field
        id="renameName"
        label="Its new name"
        hint="The count, the cost and the history come along with it."
      >
        <input
          id="renameName"
          name="name"
          className="rk-input"
          maxLength={80}
          required
          autoComplete="off"
        />
      </Field>
      <Result state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Renaming…' : 'Rename'}
      </Button>
    </form>
  );
}
