'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/Button';
import { optOutAction, type OptOutState } from './actions';
import { keepParsedToken, stateAfterSubmit } from './token';

/**
 * The page a customer's reminder email links to. The token lives in the URL fragment (never sent to
 * a server, so out of access logs and referrers). It is spent only when the customer presses the
 * button, so a mail scanner that merely opens the link cannot opt anyone out.
 */
export function OptOut() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [state, setState] = useState<OptOutState | null>(null);
  const [pending, start] = useTransition();
  const latestToken = useRef(token);
  latestToken.current = token;

  useEffect(() => {
    const read = () => {
      const hash = window.location.hash;
      // Strict mode runs this effect twice in development and the first read clears the fragment, so
      // a token already read survives an empty fragment; a new fragment replaces it.
      setToken((prev) => keepParsedToken(prev, hash));
      if (hash) {
        setState(null);
        window.history.replaceState(null, '', window.location.pathname);
      }
    };
    read();
    // A second reminder link opened in the same tab only changes the fragment.
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
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
            const result = await optOutAction(token);
            setState((prev) => stateAfterSubmit(latestToken.current, token, result, prev));
          });
        }}
      >
        {pending ? 'Stopping…' : 'Stop these reminders'}
      </Button>
    </div>
  );
}
