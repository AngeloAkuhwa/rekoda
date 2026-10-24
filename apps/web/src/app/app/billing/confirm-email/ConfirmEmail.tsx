'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { confirmCopy, type ConfirmState } from '@/lib/billing-pay-copy';
import { confirmBillingEmailAction } from './actions';

/**
 * The page the emailed link opens. The token lives in the URL fragment, which the
 * browser never sends to a server; it is read here, removed from the address bar,
 * and spent only when the owner presses the button (so nothing that merely opens
 * the link can use it up).
 */
export function ConfirmEmail() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<ConfirmState | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const read = () => {
      const raw = window.location.hash.replace(/^#/, '');
      const found = new URLSearchParams(raw).get('token') ?? (raw.length >= 16 ? raw : null);
      /* Nothing in the address bar means keep what we already hold (we clear it after reading). */
      if (found === null && raw === '') return;
      setToken(found);
      setState(null);
      if (found) window.history.replaceState(null, '', window.location.pathname);
    };
    read();
    setToken((current) => (current === undefined ? null : current));
    window.addEventListener('hashchange', read);
    return () => {
      window.removeEventListener('hashchange', read);
    };
  }, []);

  if (token === undefined) return <p className="rk-fineprint">One moment…</p>;

  const shown: ConfirmState | null = state ?? (token === null ? 'none' : null);
  if (shown) {
    const copy = confirmCopy(shown);
    return (
      <div className="rk-card" role={shown === 'verified' ? 'status' : 'alert'}>
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <p>
          <Button href="/app/billing" variant={shown === 'verified' ? 'primary' : 'secondary'}>
            Back to billing
          </Button>
        </p>
        {shown === 'error' && token ? (
          <Button
            variant="secondary"
            onClick={() => {
              setState(null);
            }}
          >
            Try again
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rk-card">
      <h2>Confirm your billing email</h2>
      <p>
        Press the button to confirm that the address we emailed is yours. This works once and only
        for the owner of this account.
      </p>
      <Button
        disabled={pending}
        onClick={() => {
          if (!token) return;
          start(async () => {
            setState(await confirmBillingEmailAction(token));
          });
        }}
      >
        {pending ? 'Confirming…' : 'Confirm this email'}
      </Button>
    </div>
  );
}
