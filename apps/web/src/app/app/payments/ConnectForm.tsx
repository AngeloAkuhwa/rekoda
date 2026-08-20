'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { BANKS } from '@/lib/banks';
import { submitConnection, type ConnectFormState } from './actions';

/**
 * Three fields, exactly what §3 allows to be collected: bank, NUBAN, account
 * name. No CAC, no TIN, no BVN — asking for less is the product decision.
 */
export function ConnectForm() {
  const [state, action, pending] = useActionState<ConnectFormState, FormData>(submitConnection, {});

  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="bankCode" label="Bank" error={state.error}>
        <select name="bankCode" id="bankCode" required className="rk-input" defaultValue="">
          <option value="" disabled>
            Choose your bank
          </option>
          {BANKS.map((bank) => (
            <option key={bank.code} value={bank.code}>
              {bank.name}
            </option>
          ))}
        </select>
      </Field>

      <Field id="accountNumber" label="Account number" hint="10 digits, no spaces">
        <input
          name="accountNumber"
          id="accountNumber"
          inputMode="numeric"
          autoComplete="off"
          maxLength={10}
          required
          className="rk-input"
        />
      </Field>

      <Field id="accountName" label="Account name" hint="Exactly as the bank knows it">
        <input
          name="accountName"
          id="accountName"
          autoComplete="off"
          required
          className="rk-input"
        />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save my account'}
      </Button>
    </form>
  );
}
