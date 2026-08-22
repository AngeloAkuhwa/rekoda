'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { matchLineAction, unmatchLineAction, type StatementState } from './actions';

export interface Candidate {
  transactionId: string;
  occurredOn: string;
  amountK: number;
  memo: string;
}

/**
 * What the books say about one line, and what a merchant can do about it.
 *
 * The candidates offered here are already narrowed to the same amount, on
 * the server, by the same rule that governs an automatic match. Showing a
 * merchant an option the server will refuse would be a worse experience than
 * showing none: they would pick it, be told no, and learn nothing about why.
 *
 * What is deliberately NOT narrowed is the date. A merchant who recorded a
 * transfer a month after it happened knows it is the same money, and no rule
 * can know that.
 */
export function LineMatchCell({
  lineId,
  matchedTo,
  candidates,
}: {
  lineId: string;
  matchedTo: { memo: string; decidedBy: 'auto' | 'manual' } | null;
  candidates: readonly Candidate[];
}) {
  const [matchState, match, matching] = useActionState<StatementState, FormData>(
    matchLineAction,
    {},
  );
  const [releaseState, release, releasing] = useActionState<StatementState, FormData>(
    unmatchLineAction,
    {},
  );
  const state = matchState.error || matchState.done ? matchState : releaseState;

  if (matchedTo) {
    return (
      <div className="rk-match">
        <span>{matchedTo.memo}</span>
        <span className="rk-fineprint">
          {matchedTo.decidedBy === 'manual' ? 'You matched this' : 'Rekoda matched this'}
        </span>
        {state.error ? (
          <p className="rk-fineprint" role="alert">
            {state.error}
          </p>
        ) : null}
        <form action={release}>
          <input type="hidden" name="lineId" value={lineId} />
          <Button type="submit" variant="ghost" disabled={releasing}>
            {releasing ? 'Releasing' : 'Release'}
          </Button>
        </form>
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <span className="rk-fineprint">
        Nothing in your books for this amount. Record it, then match it.
      </span>
    );
  }

  return (
    <div className="rk-match">
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      <form action={match} className="rk-match-pick">
        <input type="hidden" name="lineId" value={lineId} />
        <label className="rk-sr-only" htmlFor={`m-${lineId}`}>
          Which entry in your books is this line
        </label>
        <select id={`m-${lineId}`} name="transactionId" defaultValue={candidates[0]!.transactionId}>
          {candidates.map((c) => (
            <option key={c.transactionId} value={c.transactionId}>
              {c.occurredOn} · {c.memo}
            </option>
          ))}
        </select>
        <Button type="submit" variant="ghost" disabled={matching}>
          {matching ? 'Matching' : 'This one'}
        </Button>
      </form>
    </div>
  );
}
