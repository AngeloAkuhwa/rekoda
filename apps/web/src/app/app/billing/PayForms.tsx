'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { startCheckoutAction, type PayFormState } from './pay-actions';

/**
 * "Pay with Paystack" and "I lost my payment link" for one waiting charge.
 *
 * Both post only the charge's reference (and, the first time, the billing
 * email). The amount shown above these forms came from the server and the
 * server prices the checkout again; nothing here is a price.
 */
export function PayForms({
  reference,
  maskedEmail,
}: {
  reference: string;
  /** The billing email on file, masked, or null when there is none yet. */
  maskedEmail: string | null;
}) {
  const [pay, payAction, paying] = useActionState<PayFormState, FormData>(startCheckoutAction, {});
  const [again, againAction, restarting] = useActionState<PayFormState, FormData>(
    startCheckoutAction,
    {},
  );
  /* Controlled, because React clears an uncontrolled form once its action returns, and an email
   * the merchant just typed must survive an error about it. */
  const [typed, setTyped] = useState('');
  const needEmail = maskedEmail === null || pay.askEmail === true;
  const busy = paying || restarting;

  return (
    <>
      <form action={payAction} className="rk-form" noValidate>
        <input type="hidden" name="reference" value={reference} />
        {needEmail ? (
          <Field
            id="payBillingEmail"
            label="Billing email"
            hint="Paystack sends your receipt here. Use an address you read; it is not your WhatsApp number and we never share it."
          >
            <input
              name="billingEmail"
              type="email"
              inputMode="email"
              autoComplete="email"
              className="rk-input"
              maxLength={320}
              required
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </Field>
        ) : (
          <p className="rk-fineprint">
            Your receipt goes to <strong>{maskedEmail}</strong>. You can change it under Billing
            email below.
          </p>
        )}
        {pay.error ? (
          <p className="rk-fineprint" role="alert">
            {pay.error}
          </p>
        ) : null}
        <Button type="submit" disabled={busy}>
          {paying ? 'Opening Paystack…' : 'Pay with Paystack'}
        </Button>
      </form>

      {
        <form action={againAction} className="rk-form" noValidate>
          <input type="hidden" name="reference" value={reference} />
          <input type="hidden" name="restart" value="1" />
          <p className="rk-fineprint">
            Closed the Paystack page, or lost the link? We check with Paystack first. If you have
            already paid we will say so, and you will not be charged twice.
          </p>
          {again.error ? (
            <p className="rk-fineprint" role="alert">
              {again.error}
            </p>
          ) : null}
          <Button type="submit" variant="secondary" disabled={busy}>
            {restarting ? 'Checking with Paystack…' : 'I lost my payment link'}
          </Button>
        </form>
      }
    </>
  );
}
