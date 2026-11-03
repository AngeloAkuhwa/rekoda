'use client';

import { useActionState, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  browserKeyStore,
  heldIntentKey,
  heldIntentMeta,
  INTENT_KEY_TTL_MS,
  releaseIntentKey,
  touchIntentKey,
} from '@/lib/intent-key';
import { choiceMayEmail, type ChannelChoice } from '@/lib/reminder-copy';
import { sendReminderAction, type SendFormState } from '../actions';
import { ChannelChoices } from '../ChannelChoices';
import { StatusText } from '../StatusText';
import styles from '../reminders.module.css';

/**
 * One reminder, now. The key is per INTENTION, as on the payment form: a second press of the
 * same request (a dropped response, an impatient tap) carries the same key and the API sends
 * nothing twice; once an answer settles, the next press is a new reminder with a new key.
 * The key is held in session storage per invoice, so a form remounted by the error boundary after
 * the browser lost the answer keeps the key the lost press used.
 */
export function SendReminderForm({ invoiceNumber }: { invoiceNumber: string }) {
  const [state, action, sending] = useActionState<SendFormState, FormData>(sendReminderAction, {});
  const [choice, setChoice] = useState<ChannelChoice>('auto');
  const [generation, setGeneration] = useState(0);
  const scope = `remind:${invoiceNumber}`;
  /* Empty until mounted: the key comes from session storage, so Send stays disabled until it is
   * there. A press before hydration would post a key nothing holds, and a lost answer to it could
   * not be retried under the same key. */
  const [key, setKey] = useState('');
  useEffect(() => {
    const store = browserKeyStore();
    const now = Date.now();
    setKey(heldIntentKey(store, scope, now, INTENT_KEY_TTL_MS, () => crypto.randomUUID()));
    /* A press whose answer was lost asked for a channel choice; show it again, so the retry is
     * the same request under the same key and never adds a channel the merchant did not pick. */
    const asked = heldIntentMeta(store, scope, now, INTENT_KEY_TTL_MS);
    if (asked === 'auto' || asked === 'whatsapp' || asked === 'email' || asked === 'both') {
      setChoice(asked);
    }
  }, [scope, generation]);
  useEffect(() => {
    if (!state.settled) return;
    releaseIntentKey(browserKeyStore(), scope);
    setGeneration((g) => g + 1);
  }, [state, scope]);
  const attestError = state.fields?.attest;

  return (
    <form
      action={action}
      className="rk-form"
      noValidate
      /* The hold restarts at the press, so a form left open for a while still keeps this key. */
      onSubmit={() => touchIntentKey(browserKeyStore(), scope, key, Date.now(), choice)}
    >
      <input type="hidden" name="invoiceNumber" value={invoiceNumber} />
      {key ? <input type="hidden" name="idempotencyKey" value={key} /> : null}
      <ChannelChoices name="channels" value={choice} onChange={setChoice} idPrefix="one" />
      {choiceMayEmail(choice) ? (
        <div>
          <label className={styles.attest} data-invalid={attestError ? 'true' : undefined}>
            <input
              type="checkbox"
              name="attest"
              value="yes"
              aria-describedby={attestError ? 'oneAttestError' : undefined}
            />
            <span>
              I confirm I have a lawful reason to contact this customer by email about what they owe
              me. The email names my business, shows my business phone and lets the customer stop
              reminders.
            </span>
          </label>
          {attestError ? (
            <p id="oneAttestError" className={styles.groupError} role="alert">
              {attestError}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.results ? (
        <div role="status" className={styles.reveal}>
          <ul className={styles.rows} aria-label="What happened">
            {state.results.length === 0 ? (
              <li className={styles.row}>
                <span className={styles.rowDetail}>Nothing was sent.</span>
              </li>
            ) : (
              state.results.map((r) => (
                <li key={r.channel} className={styles.row}>
                  <div className={styles.rowHead}>
                    <strong>{r.channel}</strong>
                    <StatusText label={r.label} tone={r.tone} />
                  </div>
                  {r.detail ? <p className={styles.rowDetail}>{r.detail}</p> : null}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}

      <div className={styles.actions}>
        <Button type="submit" disabled={sending || !key}>
          {sending ? 'Sending…' : 'Send a reminder now'}
        </Button>
      </div>
    </form>
  );
}
