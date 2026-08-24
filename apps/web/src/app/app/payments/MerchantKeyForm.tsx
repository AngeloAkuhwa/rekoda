'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { submitMerchantKeyAction, type MerchantKeyFormState } from './actions';

/**
 * The merchant's own Paystack key (ADR 0019, fix-plan 6 M5a).
 *
 * Their account, their money, their key: Rekoda charges against their own
 * integration and is never a stop the money makes. The key is verified with
 * Paystack before anything is stored, and after this form it only ever
 * appears as a tail.
 */
export function MerchantKeyForm() {
  const [state, action, pending] = useActionState<MerchantKeyFormState, FormData>(
    submitMerchantKeyAction,
    {},
  );
  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="merchantSecretKey"
        label="Your Paystack secret key"
        error={state.error}
        hint="From your Paystack dashboard under Settings, then API Keys. Start with the test key; swap in the live one when you are ready to take real money."
      >
        <input
          id="merchantSecretKey"
          name="secretKey"
          type="password"
          className="rk-input"
          autoComplete="off"
          placeholder="sk_test_…"
        />
      </Field>
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Checking with Paystack…' : 'Connect my Paystack'}
      </Button>
    </form>
  );
}
