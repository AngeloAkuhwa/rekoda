'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const EVERY_MS = 5_000;
const MAX_TRIES = 12;

/**
 * While a payment is still being confirmed, ask the server again every few seconds for a minute.
 * It only re-reads what Rekoda holds; the page never decides an outcome itself. After the last try
 * it says so plainly instead of spinning forever.
 */
export function ReturnPoller() {
  const router = useRouter();
  const [tries, setTries] = useState(0);

  useEffect(() => {
    if (tries >= MAX_TRIES) return;
    const timer = setTimeout(() => {
      setTries((n) => n + 1);
      router.refresh();
    }, EVERY_MS);
    return () => clearTimeout(timer);
  }, [tries, router]);

  if (tries < MAX_TRIES) {
    return (
      <p className="rk-muted" role="status" aria-live="polite">
        Checking again in a few seconds…
      </p>
    );
  }
  return (
    <p role="status" aria-live="polite">
      This is taking longer than usual. Nothing is lost: if you were charged, your plan switches on
      as soon as Paystack confirms it. You can check your billing page later.
    </p>
  );
}
