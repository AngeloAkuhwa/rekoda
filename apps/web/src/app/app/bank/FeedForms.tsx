'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import {
  connectFeedAction,
  connectFeedWithCode,
  syncFeedAction,
  type FeedFormState,
} from './actions';

/** What Mono's loader script hangs on `window`. Only what we call. */
interface MonoConnectCtor {
  new (options: {
    key: string;
    onSuccess: (data: { code: string }) => void;
    onClose?: () => void;
  }): { setup(): void; open(): void };
}

const MONO_SCRIPT = 'https://connect.withmono.com/connect.js';
let monoLoader: Promise<MonoConnectCtor | null> | null = null;

/** Load Mono's widget script once, on demand, never at page load. */
function loadMonoConnect(): Promise<MonoConnectCtor | null> {
  monoLoader ??= new Promise((resolve) => {
    const done = () => {
      const ctor = (window as unknown as { MonoConnect?: MonoConnectCtor }).MonoConnect;
      resolve(ctor ?? null);
    };
    const script = document.createElement('script');
    script.src = MONO_SCRIPT;
    script.async = true;
    script.onload = done;
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return monoLoader;
}

/**
 * The proper front door: Mono's own window, opened from here. The merchant
 * signs in at their bank inside it; `onSuccess` hands back the one-time
 * code and the exchange happens server-side, same as the pasted one. Renders
 * nothing when the deployment has no public key, so the paste-code form
 * stays the whole story exactly as before.
 */
export function MonoConnectLauncher() {
  const publicKey = process.env.NEXT_PUBLIC_MONO_PUBLIC_KEY;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!publicKey) return null;

  async function openWidget() {
    setBusy(true);
    setMessage(null);
    const Ctor = await loadMonoConnect();
    if (!Ctor) {
      setBusy(false);
      setMessage(
        'The bank link window could not load. Check your connection, or use the code option below.',
      );
      return;
    }
    const connect = new Ctor({
      key: publicKey!,
      onSuccess: ({ code }) => {
        void (async () => {
          const outcome = await connectFeedWithCode(code);
          setMessage(outcome.error ?? outcome.done ?? null);
          setBusy(false);
          if (!outcome.error) router.refresh();
        })();
      },
      onClose: () => setBusy(false),
    });
    connect.setup();
    connect.open();
  }

  return (
    <div className="rk-form">
      <Button type="button" onClick={() => void openWidget()} disabled={busy}>
        {busy ? 'Opening your bank…' : 'Link your bank account'}
      </Button>
      {message ? (
        <p className="rk-fineprint" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Linking the account (fix-plan 4, G5).
 *
 * The merchant authorises at their own bank, inside the aggregator's widget;
 * what comes back is a one-time code, and this form is where it lands.
 * Rekoda never sees credentials, and the copy says so because that is the
 * question every merchant rightly asks first.
 */
export function ConnectFeedForm() {
  const [state, action, pending] = useActionState<FeedFormState, FormData>(connectFeedAction, {});
  const hasWidget = Boolean(process.env.NEXT_PUBLIC_MONO_PUBLIC_KEY);
  const form = (
    <form action={action} className="rk-form" noValidate>
      <Field
        id="feedExchangeCode"
        label="The code from the bank link window"
        error={state.error}
        hint="You sign in at your own bank, never here. The window hands back a short code when you finish, and the code is all Rekoda ever sees."
      >
        <input
          id="feedExchangeCode"
          name="exchangeCode"
          className="rk-input"
          autoComplete="off"
          placeholder="code_xxxxxxxx"
        />
      </Field>
      {state.done ? (
        <p className="rk-fineprint" role="status">
          {state.done}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Linking…' : 'Link the account'}
      </Button>
    </form>
  );
  if (!hasWidget) return form;
  /* With the widget available the pasted code is the fallback, kept for the
   * merchant whose popup blocker or WebView will not open the window. */
  return (
    <>
      <MonoConnectLauncher />
      <details className="rk-void">
        <summary>Paste a code instead</summary>
        {form}
      </details>
    </>
  );
}

/** One button: pull what moved since last time, deduplicated on arrival. */
export function SyncFeedForm() {
  const [state, action, pending] = useActionState<FeedFormState, FormData>(syncFeedAction, {});
  return (
    <form action={action} className="rk-form" noValidate>
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
      <Button type="submit" disabled={pending}>
        {pending ? 'Pulling…' : 'Pull new transactions'}
      </Button>
    </form>
  );
}
