'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import {
  clearPaymentInstructionAction,
  savePaymentInstructionAction,
  savePublicContactAction,
  type SimpleFormState,
} from '../reminders/actions';
import styles from '../reminders/reminders.module.css';

/**
 * Where a reminder asks customers to pay (REM-04, OWN-64). Saving is the owner approving this
 * account for reminders, so the approval is a box they tick, not an assumption. Rekoda never
 * fills these in: a reminder without them points the customer to the business phone instead.
 */
export function PaymentInstructionForm({
  current,
}: {
  current: { bankName: string; accountName: string; accountNumber: string } | null;
}) {
  const [state, action, saving] = useActionState<SimpleFormState, FormData>(
    savePaymentInstructionAction,
    {},
  );
  const [clearState, clear, clearing] = useActionState<SimpleFormState, FormData>(
    clearPaymentInstructionAction,
    {},
  );
  const f = state.fields ?? {};
  /* Controlled, so a refused save keeps what the owner typed: React resets an uncontrolled form
   * after its action returns, which would wipe the account number they are correcting. */
  /* One decision at a time: a save and a removal must never both be in flight, or whichever
   * finished last would decide the account customers are told to pay into. */
  const busy = saving || clearing;
  /* A saved message describes the saved account; once a field is edited it would describe an
   * account that is not saved, so it is hidden until the next save answers. */
  const [edited, setEdited] = useState(false);
  /* Only the action that answered last may speak: a save and a removal make opposite statements
   * about where customers pay, and both must never show at once. */
  const [last, setLast] = useState<'save' | 'clear' | null>(null);
  const firstSave = useRef(true);
  const firstClear = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    setEdited(false);
    setLast('save');
  }, [state]);
  useEffect(() => {
    if (firstClear.current) {
      firstClear.current = false;
      return;
    }
    setLast('clear');
  }, [clearState]);
  const [bankName, setBankName] = useState(current?.bankName ?? '');
  const [accountName, setAccountName] = useState(current?.accountName ?? '');
  const [accountNumber, setAccountNumber] = useState(current?.accountNumber ?? '');
  /* What is saved changed under the form (saved in its normalised form, or removed): show that,
   * without remounting, so the answer to the save stays on screen. */
  const savedKey = current
    ? `${current.bankName}|${current.accountName}|${current.accountNumber}`
    : '';
  useEffect(() => {
    setBankName(current?.bankName ?? '');
    setAccountName(current?.accountName ?? '');
    setAccountNumber(current?.accountNumber ?? '');
  }, [savedKey]);
  return (
    <>
      <form action={action} className="rk-form" noValidate>
        <Field id="piBank" label="Bank" error={f.bankName}>
          <input
            name="bankName"
            className="rk-input"
            value={bankName}
            onChange={(e) => {
              setBankName(e.target.value);
              setEdited(true);
            }}
            maxLength={60}
            autoComplete="off"
            readOnly={busy}
            placeholder="GTBank"
          />
        </Field>
        <Field
          id="piName"
          label="Account name"
          hint="Exactly as the bank shows it, so customers recognise it."
          error={f.accountName}
        >
          <input
            name="accountName"
            className="rk-input"
            value={accountName}
            onChange={(e) => {
              setAccountName(e.target.value);
              setEdited(true);
            }}
            maxLength={80}
            autoComplete="off"
            readOnly={busy}
          />
        </Field>
        <Field id="piNumber" label="Account number" hint="10 digits." error={f.accountNumber}>
          <input
            name="accountNumber"
            className="rk-input"
            value={accountNumber}
            onChange={(e) => {
              setAccountNumber(e.target.value);
              setEdited(true);
            }}
            inputMode="numeric"
            maxLength={14}
            autoComplete="off"
            readOnly={busy}
          />
        </Field>
        <div>
          <label className={styles.attest} data-invalid={f.approve ? 'true' : undefined}>
            <input
              type="checkbox"
              name="approve"
              value="yes"
              aria-describedby={f.approve ? 'piApproveError' : undefined}
            />
            <span>
              This is my business account. I approve Rekoda showing it in reminders as the account
              my customers should pay into.
            </span>
          </label>
          {f.approve ? (
            <p id="piApproveError" className={styles.groupError} role="alert">
              {f.approve}
            </p>
          ) : null}
        </div>
        {state.error ? (
          <p className="rk-fineprint" role="alert">
            {state.error}
          </p>
        ) : null}
        {last === 'save' && state.done && !edited ? (
          <p className="rk-fineprint" role="status">
            {state.done}
          </p>
        ) : null}
        {/* Here, not in the removal form, which unmounts once nothing is saved. */}
        {last === 'clear' && clearState.done ? (
          <p className="rk-fineprint" role="status">
            {clearState.done}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button type="submit" disabled={busy}>
            {saving ? 'Saving…' : 'Save bank details'}
          </Button>
        </div>
      </form>
      {current ? (
        <form action={clear} className="rk-form" noValidate>
          {clearState.error ? (
            <p className="rk-fineprint" role="alert">
              {clearState.error}
            </p>
          ) : null}
          <div>
            <Button type="submit" variant="secondary" disabled={busy}>
              {clearing ? 'Removing…' : 'Stop showing bank details'}
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}

/** The phone a reminder tells customers to call. The owner's choice; never assumed to be the sign-in number. */
export function PublicContactForm() {
  const [state, action, saving] = useActionState<SimpleFormState, FormData>(
    savePublicContactAction,
    {},
  );
  const [phone, setPhone] = useState('');
  return (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="publicPhone"
        label="Business phone for customers"
        hint="Shown in every reminder so customers can call or message you. Saving replaces the number reminders show now."
        error={state.fields?.publicPhone}
      >
        <input
          name="publicPhone"
          className="rk-input"
          inputMode="tel"
          autoComplete="tel"
          maxLength={20}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0803 123 4567"
        />
      </Field>
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
      <div>
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save phone'}
        </Button>
      </div>
    </form>
  );
}
