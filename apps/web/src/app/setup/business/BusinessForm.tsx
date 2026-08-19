'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Stepper } from '@/components/ui/Stepper';
import { createBusiness, type FormState } from './actions';

/** Broad on purpose — a vendor should find themselves in under two seconds. */
const TYPES = [
  'Fashion & clothing',
  'Beauty & cosmetics',
  'Food & drinks',
  'Electronics & phones',
  'Pharmacy & health',
  'Provisions & groceries',
  'Services & freelance',
  'Wholesale & trading',
  'Something else',
];

export function BusinessForm({ phone }: { phone: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createBusiness, {});

  return (
    <section className="rk-container rk-onboard">
      <Stepper current={3} />
      <h1>What should Rekoda call your business?</h1>
      <p className="rk-lede">This is the name on your invoices and receipts. You can change it.</p>

      <form action={action} className="rk-form" noValidate>
        <input type="hidden" name="phone" value={phone} />
        <Field id="name" label="Business name" hint="For example: Ada Fashion" error={state.error}>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="organization"
            maxLength={80}
            autoFocus
            required
            className="rk-input"
            aria-invalid={state.error ? true : undefined}
          />
        </Field>

        <Field id="type" label="What kind of business is it?">
          <select id="type" name="type" required defaultValue={TYPES[0]} className="rk-input">
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>

        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create my business'}
        </Button>
      </form>

      <p className="rk-fineprint">
        No CAC or TIN needed. If you have them, you can add them later to unlock extra features.
      </p>
    </section>
  );
}
