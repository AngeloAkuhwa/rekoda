'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Stepper } from '@/components/ui/Stepper';
import { requestCode, type FormState } from './actions';

const PLAN_WORDS: Record<string, string> = {
  chat: 'Rekoda Chat',
  integrate: 'Rekoda Integrate',
  complete: 'Rekoda Complete',
};

export function StartForm({
  initialPhone = '',
  plan,
}: {
  initialPhone?: string;
  plan?: string | undefined;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(requestCode, {});
  const planWord = plan ? PLAN_WORDS[plan] : undefined;

  return (
    <section className="rk-container rk-onboard">
      <Stepper current={1} />
      <h1>What&rsquo;s your WhatsApp number?</h1>
      <p className="rk-lede">
        That&rsquo;s all we need to start. No password, no card, no paperwork.
      </p>
      {planWord ? (
        <p className="rk-fineprint">
          You picked {planWord}. Your 30-day trial includes everything; choose your plan on the
          billing page when it ends.
        </p>
      ) : null}

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
            defaultValue={initialPhone}
            className="rk-input"
          />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Sending…' : 'Send me a code'}
        </Button>
      </form>

      <p className="rk-fineprint">
        We send a 6-digit code to this number on WhatsApp. Standard message rates from your network
        may apply. By continuing you accept the <a href="/terms">terms</a> and{' '}
        <a href="/privacy">privacy policy</a>.
      </p>
    </section>
  );
}
