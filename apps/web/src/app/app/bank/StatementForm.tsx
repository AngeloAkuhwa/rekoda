'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { importStatementAction, type StatementState } from './actions';

/**
 * One file, picked from wherever the bank put it.
 *
 * `accept` names the extensions rather than a MIME type: Nigerian banks
 * email files whose type the browser guesses differently on every platform,
 * and a filter that hides the merchant's own statement is worse than no
 * filter at all.
 */
export function StatementForm() {
  const [state, action, pending] = useActionState<StatementState, FormData>(
    importStatementAction,
    {},
  );

  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="statement"
        label="Your bank statement"
        hint="The CSV your bank emails or lets you download. Not the PDF"
        error={state.error}
      >
        <input
          type="file"
          name="statement"
          id="statement"
          accept=".csv,.txt,text/csv,text/plain"
          className="rk-input"
        />
      </Field>

      <p className="rk-fineprint">
        Rekoda reads the day, the amount and the bank&rsquo;s description of each line. Importing
        the same statement twice changes nothing, so you can upload whenever you like.
      </p>

      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Reading' : 'Read this statement'}
      </Button>
    </form>
  );
}
