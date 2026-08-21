'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { createRecurringAction, stopRecurringAction, type RecurringFormState } from './actions';

export interface StoppableSchedule {
  id: string;
  label: string;
}

/**
 * Setting up a cost that repeats.
 *
 * Five fields and no end date. Rent does not come with a final month, and a
 * merchant made to guess one finds out they guessed wrong by their books
 * going quiet. Stopping is one control away and never touches an entry the
 * schedule already raised.
 */
export function CreateRecurringForm() {
  const [state, action, pending] = useActionState<RecurringFormState, FormData>(
    createRecurringAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="description" label="What it is" error={state.error}>
        <input
          name="description"
          id="description"
          required
          minLength={2}
          maxLength={120}
          className="rk-input"
          placeholder="Shop rent"
        />
      </Field>

      <Field id="amount" label="How much" hint="In naira. 150000, or 150k">
        <input name="amount" id="amount" required className="rk-input" placeholder="150000" />
      </Field>

      <Field
        id="anchorDay"
        label="Day of the month"
        hint="A schedule on the 31st falls on the last day of a shorter month"
      >
        <input
          name="anchorDay"
          id="anchorDay"
          type="number"
          min={1}
          max={31}
          required
          defaultValue={1}
          className="rk-input"
        />
      </Field>

      <Field id="category" label="Category" hint="Optional. What you would call it in your books">
        <input
          name="category"
          id="category"
          maxLength={60}
          className="rk-input"
          placeholder="Rent"
        />
      </Field>

      <Field id="method" label="Paid by">
        <select name="method" id="method" className="rk-input" defaultValue="transfer">
          <option value="transfer">Transfer</option>
          <option value="cash">Cash</option>
        </select>
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Setting it up' : 'Set up this cost'}
      </Button>
    </form>
  );
}

/** Stopping one. Never a delete: the entries it raised are real expenses. */
export function StopRecurringForm({ schedules }: { schedules: StoppableSchedule[] }) {
  const [state, action, pending] = useActionState<RecurringFormState, FormData>(
    stopRecurringAction,
    {},
  );

  if (schedules.length === 0) {
    return <p className="rk-fineprint">Nothing here to stop. None of these are still running.</p>;
  }

  return (
    <form action={action} className="rk-form" noValidate>
      <Field id="id" label="Schedule to stop" error={state.error}>
        <select name="id" id="id" required className="rk-input" defaultValue="">
          <option value="" disabled>
            Choose a schedule
          </option>
          {schedules.map((schedule) => (
            <option key={schedule.id} value={schedule.id}>
              {schedule.label}
            </option>
          ))}
        </select>
      </Field>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Stopping' : 'Stop this schedule'}
      </Button>
    </form>
  );
}
