'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  classifyLineAction,
  matchLineAction,
  unmatchLineAction,
  type StatementState,
} from './actions';

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
  lineLabel,
  matchedTo,
  candidates,
  canPair,
}: {
  lineId: string;
  /** The line in a person's words ("12 Aug, TRF FROM ADA"), so the buttons in
   * this cell can say WHICH line they act on when read out of the table. */
  lineLabel: string;
  matchedTo: {
    memo: string;
    decidedBy: 'auto' | 'manual';
    /** Which §22.1 tier decided it: 1 exact reference, 2 strong
     * deterministic, 4 manual. */
    tier?: number;
    /** The person's sentence on a manual match. */
    reason?: string | null;
  } | null;
  candidates: readonly Candidate[];
  /**
   * Presentation of the role matrix: pairing is owner and accountant work.
   * A member who cannot pair still READS the column, because what the books
   * say about a line is information, not an action.
   */
  canPair: boolean;
}) {
  const [matchState, match, matching] = useActionState<StatementState, FormData>(
    matchLineAction,
    {},
  );
  const [releaseState, release, releasing] = useActionState<StatementState, FormData>(
    unmatchLineAction,
    {},
  );
  /* Both states live as long as the page does, so "which one is current"
   * is the action the merchant took LAST, never whichever has a message. */
  const [last, setLast] = useState<'match' | 'release' | null>(null);
  const state = last === 'match' ? matchState : releaseState;
  const matchNow = (formData: FormData) => {
    setLast('match');
    match(formData);
  };
  const releaseNow = (formData: FormData) => {
    setLast('release');
    release(formData);
  };

  if (matchedTo) {
    if (!canPair) {
      return (
        <div className="rk-match">
          <span>{matchedTo.memo}</span>
          <span className="rk-fineprint">{decidedLabel(matchedTo, 'Matched by hand')}</span>
        </div>
      );
    }
    return (
      <div className="rk-match">
        <span>{matchedTo.memo}</span>
        <span className="rk-fineprint">{decidedLabel(matchedTo, 'You matched this')}</span>
        {state.error ? (
          <p className="rk-fineprint" role="alert">
            {state.error}
          </p>
        ) : null}
        <form action={releaseNow}>
          <input type="hidden" name="lineId" value={lineId} />
          <Button
            type="submit"
            variant="ghost"
            disabled={releasing}
            aria-label={`Release the match on ${lineLabel}`}
          >
            {releasing ? 'Releasing…' : 'Release'}
          </Button>
        </form>
      </div>
    );
  }

  if (!canPair) {
    return <span className="rk-fineprint">Not matched yet.</span>;
  }

  /* What a release just did (G-95). The line is unmatched after it, so the
   * sentence has to be said HERE: a classification's entry was reversed,
   * an ordinary entry was untouched, and the merchant is told which. */
  const released = last === 'release' ? (releaseState.done ?? null) : null;

  if (candidates.length === 0) {
    return <ClassifyCell lineId={lineId} lineLabel={lineLabel} released={released} />;
  }

  return (
    <div className="rk-match">
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      {released ? (
        <p className="rk-fineprint" role="status">
          {released}
        </p>
      ) : null}
      <form action={matchNow} className="rk-match-pick">
        <input type="hidden" name="lineId" value={lineId} />
        <label className="rk-sr-only" htmlFor={`m-${lineId}`}>
          Which entry in your books is this line
        </label>
        <select id={`m-${lineId}`} name="transactionId" defaultValue={candidates[0]!.transactionId}>
          {candidates.map((c) => (
            <option key={c.transactionId} value={c.transactionId}>
              {presentDay(c.occurredOn)} · {c.memo}
            </option>
          ))}
        </select>
        {/* §22.1 tier 4: a person decides, with a reason recorded. Optional
            here; left blank, the record says it was paired on this screen. */}
        <input
          type="text"
          name="reason"
          maxLength={300}
          placeholder="Why these are the same money (optional)"
          aria-label={`Why ${lineLabel} matches the chosen entry`}
        />
        <Button
          type="submit"
          variant="ghost"
          disabled={matching}
          aria-label={`Match ${lineLabel} to the chosen entry`}
        >
          {matching ? 'Matching…' : 'This one'}
        </Button>
      </form>
    </div>
  );
}

/**
 * What one decided match should say about itself: whose judgement it was,
 * and — for a person's — their recorded reason (§22.1 tier 4).
 */
function decidedLabel(
  matchedTo: { decidedBy: 'auto' | 'manual'; tier?: number; reason?: string | null },
  manualWord: string,
): string {
  if (matchedTo.decidedBy === 'manual') {
    return matchedTo.reason ? `${manualWord}: ${matchedTo.reason}` : manualWord;
  }
  return matchedTo.tier === 1
    ? 'Rekoda matched this by its payment reference'
    : 'Rekoda matched this';
}

/**
 * §22.2's WHEN, on the line it is about. Nothing in the books explains
 * this money, and the merchant says what it WAS: owner capital, a supplier
 * refund, their own cash moving. One submit posts the entry that judgement
 * implies and pairs it — Rekoda never decides this silently.
 */
function ClassifyCell({
  lineId,
  lineLabel,
  released,
}: {
  lineId: string;
  lineLabel: string;
  /** What the release that left this line unmatched did, if one just ran. */
  released: string | null;
}) {
  const [state, classify, classifying] = useActionState<StatementState, FormData>(
    classifyLineAction,
    {},
  );
  return (
    <div className="rk-match">
      <span className="rk-fineprint">
        Nothing in your books for this amount. Record it and match it, or say what it was:
      </span>
      {state.error ? (
        <p className="rk-fineprint" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.done ? <p className="rk-fineprint">{state.done}</p> : null}
      {released && !state.done && !state.error ? (
        <p className="rk-fineprint" role="status">
          {released}
        </p>
      ) : null}
      <form action={classify} className="rk-match-pick">
        <input type="hidden" name="lineId" value={lineId} />
        <label className="rk-sr-only" htmlFor={`c-${lineId}`}>
          What this money was
        </label>
        <select id={`c-${lineId}`} name="classification" defaultValue="OWNER_CAPITAL">
          <option value="OWNER_CAPITAL">Owner capital (my own money in or out)</option>
          <option value="SUPPLIER_REFUND">Supplier refund</option>
          <option value="INTERNAL_TRANSFER">Cash transfer (till and bank)</option>
        </select>
        <input
          type="text"
          name="note"
          maxLength={300}
          placeholder="In your own words (optional)"
          aria-label={`Your words for ${lineLabel}`}
        />
        <Button
          type="submit"
          variant="ghost"
          disabled={classifying}
          aria-label={`Record ${lineLabel} as what you chose`}
        >
          {classifying ? 'Recording…' : 'That is what it was'}
        </Button>
      </form>
    </div>
  );
}

/** `12 Aug`, Lagos, from a plain calendar day. */
function presentDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Africa/Lagos',
  });
}
