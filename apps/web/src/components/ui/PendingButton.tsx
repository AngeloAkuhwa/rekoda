'use client';

import { useFormStatus } from 'react-dom';

/**
 * A submit button that says so while its form is in flight.
 *
 * For server-component forms whose OUTCOME already arrives another way (a
 * redirect, a query-param banner) and which therefore never converted to
 * useActionState. They still owe the merchant the in-between state: a "Buy"
 * that stays live while the request runs invites the second tap, and on the
 * billing page the second tap is a second attempt to spend money. The server
 * already refuses duplicates; the button should not be relying on that.
 */
export function PendingButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className ?? 'rk-btn'} disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
