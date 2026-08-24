'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { saveSettingsAction, type SettingsFormState } from './actions';

export function SettingsForm({
  name,
  rcNumber,
  tin,
}: {
  name: string;
  rcNumber: string | null;
  tin: string | null;
}) {
  const [state, action, pending] = useActionState<SettingsFormState, FormData>(
    saveSettingsAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      <Field
        id="settingsName"
        label="Business name"
        hint="The name on your invoices, receipts and statements from the next one issued."
      >
        <input
          id="settingsName"
          name="name"
          className="rk-input"
          defaultValue={name}
          maxLength={80}
          required
        />
      </Field>
      <Field
        id="settingsRc"
        label="CAC registration number (optional)"
        hint="Leave empty if you are not registered yet. Nothing in Rekoda needs it to work."
      >
        <input
          id="settingsRc"
          name="rcNumber"
          className="rk-input"
          defaultValue={rcNumber ?? ''}
          maxLength={20}
          autoComplete="off"
        />
      </Field>
      <Field id="settingsTin" label="Tax identification number (optional)">
        <input
          id="settingsTin"
          name="tin"
          className="rk-input"
          defaultValue={tin ?? ''}
          maxLength={20}
          autoComplete="off"
        />
      </Field>
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}
