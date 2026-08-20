'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Stepper } from '@/components/ui/Stepper';
import { requestCode, type FormState } from './actions';

export function StartForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(requestCode, {});

  return (
    <section className="rk-container rk-onboard">
      <Stepper current={1} />
      <h1>What&rsquo;s your WhatsApp number?</h1>
      <p className="rk-lede">
        That&rsquo;s all we need to start. No password, no card, no paperwork.
      </p>

      <form action={action} className="rk-form" noValidate>
        <Field
          id="phone"
          label="WhatsApp number"
          hint="Nigerian mobile, like 0803 123 4567"
          error={state.error}
        >
          <input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            autoFocus
            required
            className="rk-input"
          />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send me a code'}
        </Button>
      </form>

      <p className="rk-fineprint">
        We send a 6-digit code to this number on WhatsApp. Standard message rates from your network
        may apply.
      </p>
    </section>
  );
}
