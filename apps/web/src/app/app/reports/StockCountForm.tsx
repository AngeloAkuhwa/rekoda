'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { countStockAction, type StockCountState } from './actions';

/**
 * One button, because there is nothing to type.
 *
 * The merchant has already counted: the shelf is what the stock page says it
 * is, and what it cost is on the catalogue. Asking them to retype a total
 * here would be asking them for a figure Rekoda already holds and inviting a
 * third, different answer.
 */
export function StockCountForm({ short }: { short: boolean }) {
  const [state, action, pending] = useActionState<StockCountState, FormData>(countStockAction, {});

  return (
    <form action={action}>
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
        {pending ? 'Posting…' : short ? 'Write the difference off' : 'Bring the books to the count'}
      </Button>
    </form>
  );
}
