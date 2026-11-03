'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Money } from '@/components/ui/Money';
import {
  batchIntentScope,
  browserKeyStore,
  heldIntentKey,
  INTENT_KEY_TTL_MS,
  touchIntentKey,
} from '@/lib/intent-key';
import {
  channelName,
  channelsFromChoice,
  channelsPhrase,
  choiceMayEmail,
  invoicesCount,
  lagosDateTime,
  LEFT_OUT_RECHECK_NOTE,
  lagosLocalToIso,
  planAtInput,
  planIntentScope,
  previewReason,
  reminderReason,
  type ChannelChoice,
} from '@/lib/reminder-copy';
import { createBatchAction, previewBatchAction, type BatchFormState } from './actions';
import { ChannelChoices } from './ChannelChoices';
import styles from './reminders.module.css';

export interface RemindableInvoice {
  invoiceNumber: string;
  balanceDueK: number;
  daysOverdue: number;
  dueLabel: string;
}

/**
 * Several reminders at once, now or at a chosen time (REM-05's API, REM-06's screen).
 *
 * Two steps, never one: Preview reads and decides on the server (who would be reminded, on
 * which channel, who is left out and why), and only then does Confirm schedule anything. The
 * selection is held in state so going back to change it keeps what the merchant picked.
 * Balances are the API's, in kobo, rendered by `Money`; nothing here adds them up.
 */
export function NewBatchForm({
  invoices,
  nowInput,
  maxInput,
}: {
  invoices: RemindableInvoice[];
  /** Lagos `datetime-local` bounds, computed on the server at render. */
  nowInput: string;
  maxInput: string;
}) {
  const [previewState, preview, previewing] = useActionState<BatchFormState, FormData>(
    previewBatchAction,
    {},
  );
  const [confirmState, confirm, confirming] = useActionState<BatchFormState, FormData>(
    createBatchAction,
    {},
  );
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [choice, setChoice] = useState<ChannelChoice>('auto');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [editing, setEditing] = useState(true);
  /* One key per exact selection, held in session storage: if the error boundary remounts this
   * form after the browser lost a Confirm answer, picking the same invoices, channels and time
   * again carries the same key, and the API replays the batch it made instead of making another. */
  const scope = batchIntentScope([...picked], choice, when === 'later' ? at : '');
  const [intentKey, setIntentKey] = useState('');
  useEffect(() => {
    setIntentKey(
      heldIntentKey(browserKeyStore(), scope, Date.now(), INTENT_KEY_TTL_MS, () =>
        crypto.randomUUID(),
      ),
    );
  }, [scope]);
  const summaryRef = useRef<HTMLHeadingElement>(null);
  /* Which answer is newest: a Confirm refusal keeps the preview it was made from, and a fresh
   * preview after "Change the selection" replaces both. */
  const [latest, setLatest] = useState<'preview' | 'confirm'>('preview');
  const initialConfirm = useRef(confirmState);

  /* A preview that came back moves to step two; a new preview is a new answer to show. */
  useEffect(() => {
    setLatest('preview');
    if (previewState.preview) setEditing(false);
  }, [previewState]);
  /* Step two takes the focus, so a keyboard or screen-reader user lands on what changed. */
  useEffect(() => {
    if (!editing) summaryRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (confirmState !== initialConfirm.current) setLatest('confirm');
  }, [confirmState]);

  const confirmNewest = latest === 'confirm';
  const shown =
    confirmNewest && confirmState.plan && confirmState.preview ? confirmState : previewState;
  const attestError = confirmNewest ? confirmState.fields?.attest : undefined;
  const plan = shown.plan;
  const result = shown.preview;

  const allPicked = picked.size === invoices.length && invoices.length > 0;
  const toggle = (n: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  if (!editing && plan && result) {
    const scheduledFor = plan.scheduledFor ?? null;
    const mayEmail = choiceMayEmail(plan.choice);
    return (
      <div className={`${styles.reveal} ${styles.step}`}>
        <h3 ref={summaryRef} tabIndex={-1}>
          Check before you confirm
        </h3>
        <p className={styles.summary}>
          <strong>{invoicesCount(result.eligibleCount)}</strong> can be reminded{' '}
          {channelsPhrase(channelsFromChoice(plan.choice)!)},{' '}
          {scheduledFor ? `on ${lagosDateTime(scheduledFor)}` : 'as soon as you confirm'}.
          {result.excludedCount > 0 ? (
            <>
              {' '}
              <strong>{invoicesCount(result.excludedCount)}</strong>{' '}
              {result.excludedCount === 1 ? 'is' : 'are'} left out; the reason is beside each.
            </>
          ) : null}{' '}
          {result.excludedCount > 0
            ? LEFT_OUT_RECHECK_NOTE
            : 'Rekoda checks every invoice again just before sending, so one paid in the meantime is not chased.'}
        </p>
        {result.duplicates.length > 0 ? (
          <p className={styles.note}>
            {result.duplicates.join(', ')} {result.duplicates.length === 1 ? 'was' : 'were'} picked
            more than once and will be reminded once.
          </p>
        ) : null}

        <ul className={styles.rows} aria-label="Who would be reminded">
          {result.recipients.map((r) => {
            const going = r.channels.some((c) => c.eligible);
            return (
              <li key={r.invoiceNumber} className={styles.row}>
                <div className={styles.rowHead}>
                  <span className={styles.rowTitle}>{r.invoiceNumber}</span>
                  {r.balanceK !== null ? <Money kobo={r.balanceK} /> : null}
                </div>
                <span className={styles.status} data-tone={going ? 'ok' : 'neutral'}>
                  {!r.found ? 'Not found' : going ? 'Will be reminded' : 'Left out'}
                </span>
                {!r.found ? (
                  <p className={styles.rowDetail}>{reminderReason('invoice_not_found')}</p>
                ) : (
                  r.channels.map((c) => (
                    <p key={c.channel} className={styles.channelLine}>
                      <strong>{channelName(c.channel)}:</strong>{' '}
                      {c.eligible ? 'will send' : previewReason(c.reasonCode, c.channel)}
                    </p>
                  ))
                )}
                {r.alsoScheduled ? (
                  <p className={styles.rowDetail}>
                    This invoice is already waiting in another scheduled batch. Confirming sends it
                    a second reminder.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>

        <form
          action={confirm}
          className="rk-form"
          noValidate
          /* The hold restarts at the press, so a preview read for a while still keeps this key. */
          onSubmit={() =>
            touchIntentKey(
              browserKeyStore(),
              planIntentScope(plan),
              plan.idempotencyKey,
              Date.now(),
            )
          }
        >
          {plan.invoiceNumbers.map((n) => (
            <input key={n} type="hidden" name="invoice" value={n} />
          ))}
          <input type="hidden" name="channels" value={plan.choice} />
          <input type="hidden" name="when" value={scheduledFor ? 'later' : 'now'} />
          <input type="hidden" name="at" value={planAtInput(plan.scheduledFor)} />
          <input type="hidden" name="idempotencyKey" value={plan.idempotencyKey} />
          <input type="hidden" name="previewJson" value={JSON.stringify(result)} />

          {result.eligibleCount === 0 ? (
            <p className={styles.note} role="status">
              None of these can be reminded right now. The reason is beside each invoice.
            </p>
          ) : (
            <>
              {mayEmail ? (
                <div>
                  <label className={styles.attest} data-invalid={attestError ? 'true' : undefined}>
                    <input
                      type="checkbox"
                      name="attest"
                      value="yes"
                      aria-describedby={attestError ? 'batchAttestError' : undefined}
                    />
                    <span>
                      I confirm I have a lawful reason to contact these customers by email about
                      what they owe me. Each email names my business, shows my business phone and
                      lets the customer stop reminders.
                    </span>
                  </label>
                  {attestError ? (
                    <p id="batchAttestError" className={styles.groupError} role="alert">
                      {attestError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {confirmNewest && confirmState.error ? (
                <p className="rk-fineprint" role="alert">
                  {confirmState.error}
                </p>
              ) : null}
            </>
          )}

          <div className={styles.actions}>
            {result.eligibleCount > 0 ? (
              <Button type="submit" disabled={confirming}>
                {confirming
                  ? 'Confirming…'
                  : scheduledFor
                    ? 'Confirm and schedule'
                    : 'Confirm and send'}
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
              Change the selection
            </Button>
          </div>
        </form>
      </div>
    );
  }

  const whenError = previewState.fields?.when;
  /* Gone once something is picked: an error about an empty selection is stale after that. */
  const invoicesError = picked.size === 0 ? previewState.fields?.invoices : undefined;
  return (
    <form
      action={preview}
      className="rk-form"
      noValidate
      onSubmit={() => touchIntentKey(browserKeyStore(), scope, intentKey, Date.now())}
    >
      {intentKey ? <input type="hidden" name="idempotencyKey" value={intentKey} /> : null}
      <fieldset
        className={styles.group}
        aria-describedby={invoicesError ? 'batchInvoicesError' : undefined}
      >
        <legend>Which invoices</legend>
        <div className={styles.actions}>
          <button
            type="button"
            className="rk-link-button"
            onClick={() =>
              setPicked(allPicked ? new Set() : new Set(invoices.map((i) => i.invoiceNumber)))
            }
          >
            {allPicked ? 'Clear the selection' : `Select all ${invoicesCount(invoices.length)}`}
          </button>
          <span className={styles.groupHint} aria-live="polite">
            {picked.size === 0 ? 'None picked yet' : `${invoicesCount(picked.size)} picked`}
          </span>
        </div>
        <ul className={styles.pickList}>
          {invoices.map((inv) => (
            <li key={inv.invoiceNumber}>
              <label className={styles.pick}>
                <input
                  type="checkbox"
                  name="invoice"
                  value={inv.invoiceNumber}
                  checked={picked.has(inv.invoiceNumber)}
                  onChange={() => toggle(inv.invoiceNumber)}
                />
                <span className={styles.pickMeta}>
                  <span className={styles.pickNumber}>{inv.invoiceNumber}</span>
                  <span className={styles.pickSub}>
                    {inv.daysOverdue > 0
                      ? `${inv.daysOverdue} ${inv.daysOverdue === 1 ? 'day' : 'days'} late`
                      : inv.dueLabel}
                  </span>
                </span>
                <span className={styles.pickAmount}>
                  <Money kobo={inv.balanceDueK} />
                </span>
              </label>
            </li>
          ))}
        </ul>
        {invoicesError ? (
          <p id="batchInvoicesError" className={styles.groupError} role="alert">
            {invoicesError}
          </p>
        ) : null}
      </fieldset>

      <ChannelChoices name="channels" value={choice} onChange={setChoice} idPrefix="batch" />

      <fieldset className={styles.group}>
        <legend>When</legend>
        <div className={styles.choices}>
          <label className={styles.choice}>
            <input
              type="radio"
              name="when"
              value="now"
              checked={when === 'now'}
              onChange={() => setWhen('now')}
            />
            <span className={styles.choiceText}>As soon as you confirm</span>
          </label>
          <label className={styles.choice}>
            <input
              type="radio"
              name="when"
              value="later"
              checked={when === 'later'}
              onChange={() => setWhen('later')}
            />
            <span className={styles.choiceText}>
              At a time you choose
              <span className={styles.choiceSub}>Lagos time, up to 30 days ahead</span>
            </span>
          </label>
        </div>
        {when === 'later' ? (
          <div>
            <label htmlFor="batchAt" className="rk-sr-only">
              Date and time to send
            </label>
            <input
              id="batchAt"
              name="at"
              type="datetime-local"
              className="rk-input"
              min={nowInput}
              max={maxInput}
              value={at}
              disabled={previewing}
              onChange={(e) => setAt(e.target.value)}
              aria-invalid={whenError ? true : undefined}
              aria-describedby={whenError ? 'batchWhenError' : undefined}
            />
          </div>
        ) : null}
        {whenError ? (
          <p id="batchWhenError" className={styles.groupError} role="alert">
            {whenError}
          </p>
        ) : null}
        {when === 'later' && at && lagosLocalToIso(at) ? (
          <p className={styles.groupHint}>Sends on {lagosDateTime(lagosLocalToIso(at)!)}.</p>
        ) : null}
      </fieldset>

      {previewState.error ? (
        <p className="rk-fineprint" role="alert">
          {previewState.error}
        </p>
      ) : null}

      <div className={styles.actions}>
        {/* Disabled until the held key is in place: a preview posted before hydration would carry
         * a key nothing holds. */}
        <Button type="submit" disabled={previewing || !intentKey}>
          {previewing ? 'Checking…' : 'Preview reminders'}
        </Button>
      </div>
      <p className="rk-fineprint">
        Preview sends nothing. It shows who would be reminded and who would be left out, and why.
      </p>
    </form>
  );
}
