'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Stepper } from '@/components/ui/Stepper';
import { confirmCode, type FormState } from '../start/actions';

export function VerifyForm({ phone, e2eCode }: { phone: string; e2eCode?: string | undefined }) {
  const [state, action, pending] = useActionState<FormState, FormData>(confirmCode, {});

  return (
    <section className="rk-container rk-onboard">
      <Stepper current={2} />
      <h1>Enter the code</h1>
      <p className="rk-lede">
        We sent a 6-digit code to <strong>{phone}</strong> on WhatsApp.
      </p>

      {/* Present only under REKODA_E2E_REVEAL_OTP=1. Never in a deployment. */}
      {e2eCode ? <span hidden data-e2e-otp={e2eCode} /> : null}

      <form action={action} className="rk-form" noValidate>
        <input type="hidden" name="phone" value={phone} />
        <Field id="code" label="6-digit code" error={state.error}>
          <input
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            autoFocus
            required
            className="rk-input rk-input-code"
          />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Checking…' : 'Confirm'}
        </Button>
      </form>

      <p className="rk-fineprint">
        Didn&rsquo;t get it? <a href="/start">Start again</a> to send a new code. Codes expire after
        10 minutes.
      </p>
    </section>
  );
}
