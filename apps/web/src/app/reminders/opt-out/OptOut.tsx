'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { optOutAction, type OptOutState } from './actions';

/**
 * The page a customer's reminder email links to. The token lives in the URL fragment (never sent to
 * a server, so out of access logs and referrers). It is spent only when the customer presses the
 * button, so a mail scanner that merely opens the link cannot opt anyone out.
 */
export function OptOut() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<OptOutState | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const raw = window.location.hash.replace(/^#/, '');
    const value = raw.startsWith('token=') ? raw.slice('token='.length) : '';
    let decoded = '';
    try {
      decoded = decodeURIComponent(value);
    } catch {
      decoded = '';
    }
    setToken(decoded.length >= 40 ? decoded : null);
    if (decoded) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  if (token === undefined) return <p className="rk-fineprint">One moment…</p>;

  if (state === 'done') {
    return (
      <div className="rk-card" role="status">
        <h2>No more reminders</h2>
        <p>
          You will not get payment reminder emails from this business through Rekoda again. If you
          still owe them money, please contact them directly.
        </p>
      </div>
    );
  }

  if (token === null || state === 'invalid') {
    return (
      <div className="rk-card" role="alert">
        <h2>This link does not work</h2>
        <p>
          It may be incomplete or no longer valid. Open the link from the email again, or call the
          business on the phone number in the email and ask them to stop.
        </p>
      </div>
    );
  }

  return (
    <div className="rk-card">
      <h2>Stop payment reminder emails?</h2>
      <p>
        Press the button to stop payment reminder emails sent through Rekoda on behalf of this
        business. Rekoda is not owed this money and does not hold it.
      </p>
      {state === 'error' ? (
        <p role="alert">We could not reach the service just now. Please try again.</p>
      ) : null}
      <Button
        disabled={pending}
        onClick={() => {
          start(async () => {
            setState(await optOutAction(token));
          });
        }}
      >
        {pending ? 'Stopping…' : 'Stop these reminders'}
      </Button>
    </div>
  );
}
