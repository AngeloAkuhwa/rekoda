'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { inviteMemberAction, removeMemberAction, type TeamActionState } from './actions';

/**
 * The two forms on the team page.
 *
 * Together in one file because they share a state shape and neither is big
 * enough to earn its own, and as a namespace so the page reads as
 * `TeamForms.Invite` rather than importing two names that only make sense
 * side by side.
 */
function Invite() {
  const [state, action, pending] = useActionState<TeamActionState, FormData>(
    inviteMemberAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="phone"
        label="Their phone number"
        hint="The number they use for WhatsApp"
        error={state.error}
      >
        <input
          name="phone"
          id="phone"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          placeholder="08031234567"
          required
          className="rk-input"
        />
      </Field>

      <Field id="role" label="What they can do">
        <select name="role" id="role" className="rk-input" defaultValue="accountant">
          <option value="accountant">Accountant, can read everything</option>
          <option value="delegate">Helper, can record sales</option>
        </select>
      </Field>

      {state.invited ? (
        <p className="rk-fineprint">Added. {state.invited} can sign in on their own phone now.</p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Adding' : 'Add them'}
      </Button>
    </form>
  );
}

function Remove({ userId, phone }: { userId: string; phone: string }) {
  const [state, action, pending] = useActionState<TeamActionState, FormData>(
    removeMemberAction,
    {},
  );

  return (
    <form action={action}>
      <input type="hidden" name="userId" value={userId} />
      {/* Named in the label rather than only in the row, so the button says
          what it does when a screen reader reads it on its own. */}
      <Button type="submit" variant="ghost" disabled={pending} aria-label={`Remove ${phone}`}>
        {pending ? 'Removing' : 'Remove'}
      </Button>
      {state.error ? <span className="rk-fineprint">{state.error}</span> : null}
    </form>
  );
}

export const TeamForms = { Invite, Remove };
