'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Stepper } from '@/components/ui/Stepper';
import { confirmCode, resendCode, type FormState, type ResendState } from '../start/actions';

export function VerifyForm({ phone, e2eCode }: { phone: string; e2eCode?: string | undefined }) {
  const [state, action, pending] = useActionState<FormState, FormData>(confirmCode, {});
  const [resendState, resend, resending] = useActionState<ResendState, FormData>(resendCode, {});

  return (
    <section className="rk-container rk-onboard">
      <Stepper current={2} />
      <h1>Enter the code</h1>
      <p className="rk-lede">
        We sent a 6-digit code to <strong>{phone}</strong> on WhatsApp.{' '}
        <a href={`/start?phone=${encodeURIComponent(phone)}`}>Not your number?</a>
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

      {/* One tap, same number. The old affordance was a walk back to /start
          that forgot the phone on the way, for the most ordinary failure the
          funnel has: a slow message. */}
      <form action={resend} className="rk-form" noValidate>
        <input type="hidden" name="phone" value={phone} />
        {resendState.done ? (
          <p className="rk-fineprint" role="status">
            {resendState.done}
          </p>
        ) : null}
        {resendState.error ? (
          <p className="rk-fineprint" role="alert">
            {resendState.error}
          </p>
        ) : null}
        <p className="rk-fineprint">
          Didn&rsquo;t get it?{' '}
          <Button type="submit" variant="ghost" disabled={resending}>
            {resending ? 'Sending…' : 'Send a new code'}
          </Button>{' '}
          Codes expire after 10 minutes.
        </p>
      </form>
    </section>
  );
}
