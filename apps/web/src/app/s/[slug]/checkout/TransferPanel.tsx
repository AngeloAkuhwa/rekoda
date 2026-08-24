'use client';

import { useState } from 'react';
import { formatKobo } from '@rekoda/core';
import { Field } from '@/components/ui/Field';
import { checkTransferStatus, requestTransferAccount } from './actions';

/**
 * Pay now, by bank transfer, on the confirmation (fix-plan 6, M5c).
 *
 * Optional by design: the WhatsApp handoff below it remains the way most
 * customers settle, and a shop whose merchant has not connected their own
 * Paystack key simply never grows this panel past its first refusal. When
 * it works, the account shown is temporary and belongs to THIS order alone;
 * "I have sent it" asks the server, which asks Paystack, and never takes
 * anyone's word for money.
 */
interface Account {
  bankName: string;
  accountNumber: string;
  accountName: string | null;
  amountK: number;
  expiresAt: string | null;
}

export function TransferPanel({
  slug,
  clientRef,
  displayName,
}: {
  slug: string;
  clientRef: string;
  displayName: string;
}) {
  const [email, setEmail] = useState('');
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [paid, setPaid] = useState<{ receiptNumber: string | null } | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  async function getAccount() {
    const address = email.trim();
    if (!address.includes('@') || address.length < 5) {
      setMessage('An email address, for the payment record the bank needs.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await requestTransferAccount(slug, { clientRef, email: address });
      if (!outcome) {
        setMessage('That did not go through. Check the email address and try again.');
        return;
      }
      switch (outcome.outcome) {
        case 'account':
          setAccount({
            bankName: outcome.bankName,
            accountNumber: outcome.accountNumber,
            accountName: outcome.accountName,
            amountK: outcome.amountK,
            expiresAt: outcome.expiresAt,
          });
          return;
        case 'not_available':
          /* The merchant settles on WhatsApp; the panel bows out. */
          setUnavailable(true);
          return;
        case 'nothing_to_pay':
          setPaid({ receiptNumber: null });
          return;
        case 'order_gone':
          setMessage('We could not find this order any more. Message the seller on WhatsApp.');
          return;
        case 'provider_down':
          setMessage('The transfer service is not answering right now. Try again in a minute.');
          return;
      }
    } catch {
      setMessage('That did not go through. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function checkPaid() {
    setChecking(true);
    setMessage(null);
    try {
      const outcome = await checkTransferStatus(slug, clientRef);
      if (!outcome) {
        setMessage('We could not check just now. Try again in a moment.');
        return;
      }
      switch (outcome.state) {
        case 'paid':
          setPaid({ receiptNumber: outcome.receiptNumber });
          return;
        case 'pending':
          setMessage('Not seen yet. Transfers usually land within a minute; check again shortly.');
          return;
        case 'expired':
          setAccount(null);
          setMessage(
            'That account number lapsed before the transfer arrived. Your order is still open; get a fresh number and try again.',
          );
          return;
        case 'order_gone':
          setMessage('We could not find this order any more. Message the seller on WhatsApp.');
          return;
      }
    } catch {
      setMessage('We could not check just now. Try again in a moment.');
    } finally {
      setChecking(false);
    }
  }

  if (unavailable) return null;

  if (paid) {
    return (
      <div className="rk-transfer" role="status">
        <h3>Payment confirmed</h3>
        <p className="rk-fineprint">
          {paid.receiptNumber
            ? `The bank confirmed your transfer. Receipt ${paid.receiptNumber} is on its way to ${displayName}.`
            : `This order is fully paid. ${displayName} has the record.`}
        </p>
      </div>
    );
  }

  return (
    <div className="rk-transfer">
      <h3>Pay now by bank transfer</h3>
      {account ? (
        <>
          <p>
            Transfer <strong>{formatKobo(account.amountK)}</strong> to
          </p>
          <p className="rk-transfer-account">
            <strong>{account.accountNumber}</strong> · {account.bankName}
            {account.accountName ? ` · ${account.accountName}` : ''}
          </p>
          <p className="rk-fineprint">
            This account number belongs to your order alone
            {account.expiresAt ? ` and works until ${lagosTime(account.expiresAt)}` : ''}. If it
            lapses, your order stays open and you can get a fresh one here.
          </p>
          <button type="button" className="rk-btn" onClick={checkPaid} disabled={checking}>
            {checking ? 'Checking with the bank…' : 'I have sent it'}
          </button>
        </>
      ) : (
        <>
          <Field
            id="transfer-email"
            label="Email for the payment"
            hint="The bank record needs one. It goes to the payment provider, not to Rekoda's records."
          >
            <input
              className="rk-input"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              maxLength={120}
            />
          </Field>
          <button type="button" className="rk-btn" onClick={getAccount} disabled={busy}>
            {busy ? 'Getting your account number…' : 'Get account number'}
          </button>
        </>
      )}
      {message ? (
        <p className="rk-fineprint" role="alert">
          {message}
        </p>
      ) : null}
      <p className="rk-fineprint">
        Or skip this and settle directly with {displayName} on WhatsApp below.
      </p>
    </div>
  );
}

/** `4:30 pm` in Lagos, from an ISO instant — when the number stops working. */
function lagosTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Lagos',
    hour: 'numeric',
    minute: '2-digit',
  });
}
