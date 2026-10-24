'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { sendConfirmationAction, type PayFormState } from './pay-actions';

/** Enter, change or confirm the billing email. Owner-only: the page does not render it otherwise. */
export function EmailForm({ hasEmail, verified }: { hasEmail: boolean; verified: boolean }) {
  const [state, action, pending] = useActionState<PayFormState, FormData>(
    sendConfirmationAction,
    {},
  );
  const [typed, setTyped] = useState('');
  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="billingEmailInput"
        label={hasEmail ? 'Use a different email' : 'Billing email'}
        hint={
          hasEmail
            ? 'Leave empty to keep the address above. A new address needs confirming again.'
            : 'Where Paystack sends your receipt. Use an address you read yourself.'
        }
      >
        <input
          name="billingEmail"
          type="email"
          inputMode="email"
          autoComplete="email"
          className="rk-input"
          maxLength={320}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
      </Field>
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" variant={verified ? 'secondary' : 'primary'} disabled={pending}>
        {pending
          ? 'Saving…'
          : verified
            ? 'Save and confirm the new email'
            : 'Save and send confirmation link'}
      </Button>
    </form>
  );
}
