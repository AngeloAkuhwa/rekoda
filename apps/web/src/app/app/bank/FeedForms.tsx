'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { connectFeedAction, syncFeedAction, type FeedFormState } from './actions';

/**
 * Linking the account (fix-plan 4, G5).
 *
 * The merchant authorises at their own bank, inside the aggregator's widget;
 * what comes back is a one-time code, and this form is where it lands.
 * Rekoda never sees credentials, and the copy says so because that is the
 * question every merchant rightly asks first.
 */
export function ConnectFeedForm() {
  const [state, action, pending] = useActionState<FeedFormState, FormData>(connectFeedAction, {});
  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="feedExchangeCode"
        label="The code from the bank link window"
        error={state.error}
        hint="You sign in at your own bank, never here. The window hands back a short code when you finish, and the code is all Rekoda ever sees."
      >
        <input
          id="feedExchangeCode"
          name="exchangeCode"
          className="rk-input"
          autoComplete="off"
          placeholder="code_xxxxxxxx"
        />
      </Field>
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Linking…' : 'Link the account'}
      </Button>
    </form>
  );
}

/** One button: pull what moved since last time, deduplicated on arrival. */
export function SyncFeedForm() {
  const [state, action, pending] = useActionState<FeedFormState, FormData>(syncFeedAction, {});
  return (
    <form action={action} className="rk-form" noValidate>
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
      <Button type="submit" disabled={pending}>
        {pending ? 'Pulling…' : 'Pull new transactions'}
      </Button>
    </form>
  );
}
