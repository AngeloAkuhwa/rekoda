import type { Metadata } from 'next';
import { lagosDay } from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { bankFeedState, bankPosition } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { StatementForm } from './StatementForm';
import { ConnectFeedForm, SyncFeedForm } from './FeedForms';
import { ForgetDayForm } from './ForgetDayForm';
import { ReconcileForm } from './ReconcileForm';
import { LineMatchCell } from './LineMatchCell';
import { canReconcileBank, isOwner } from '@/lib/permissions';
import { heldBy } from '@/lib/capabilities';

export const metadata: Metadata = {
  title: 'Bank',
  robots: { index: false, follow: false },
};

/**
 * What the bank says, beside what the books say.
 *
 * Rekoda's books are built from what a merchant told it. This page holds the
 * other version: what actually moved, according to somebody with no reason to
 * agree. Its whole value is in the two disagreeing, which is how a merchant
 * finds out that a payment they were sure arrived never did.
 *
 * The difference is offered as something to look into rather than as a
 * verdict, because it is only a real gap once a merchant has imported from
 * the beginning, and almost nobody does. Saying "these disagree by ₦40,000"
 * to somebody who imported one month would be a lie dressed as arithmetic.
 *
 * Nothing here is matched to anything yet.
 */
export default async function BankPage() {
  const { identity, token } = await requireSessionWithToken();
  const [{ position, lines, reconciliation, openMovements }, feed] = await Promise.all([
    bankPosition(token),
    bankFeedState(token),
  ]);
  const today = lagosDay(new Date());
  const started = position.lines > 0;
  const lineById = new Map(lines.map((line) => [line.id, line]));

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">{identity.businessName}</p>
          <h1>What your bank says</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="bank" held={heldBy(identity)} role={identity.role} />

      {started ? (
        <div className="rk-card rk-dash-card">
          <h2>Your books, and your bank</h2>
          <div className="rk-table-scroll">
            <table className="rk-statement">
              <tbody>
                <tr>
                  <td>What your books say is in the bank</td>
                  <td>
                    <Money kobo={position.ledgerK} />
                  </td>
                </tr>
                <tr>
                  <td>What the statements you imported add up to</td>
                  <td>
                    <Money kobo={position.statementK} />
                  </td>
                </tr>
                <tr className="rk-statement-total">
                  <td>Difference</td>
                  <td>
                    <Money kobo={position.differenceK} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {/* The honest caveat, and it is not small print for its own sake:
              these two only mean the same thing once a merchant has imported
              from the day their books began. Until then the difference is
              arithmetic about two different spans of time. */}
          <p className="rk-fineprint">
            {position.differenceK === 0
              ? 'These agree. If you have imported every statement since you started, your books and your bank tell the same story.'
              : 'These two only mean the same thing once you have imported every statement since your books began. Until then the difference is mostly the months you have not imported yet.'}
          </p>
        </div>
      ) : (
        <div className="rk-card rk-dash-empty">
          <h2>Nothing imported yet</h2>
          <p>
            Rekoda knows what you have told it. Your bank knows what actually moved. Import a
            statement and you can hold the two side by side, which is how you find the payment you
            were sure had landed.
          </p>
        </div>
      )}

      {/* What is left over is the answer, not the leftovers. A line nothing
          explains is money nobody recorded; an entry nothing explains is
          money the books claim and the bank has never seen. Both are worth
          more to a merchant than the count of what agreed. */}
      {started ? (
        <div className="rk-card rk-dash-card">
          <h2>Matching the two</h2>
          <div className="rk-table-scroll">
            <table className="rk-statement">
              <tbody>
                <tr>
                  <td>Lines matched to an entry in your books</td>
                  <td>{reconciliation.matched}</td>
                </tr>
                {reconciliation.pairable > 0 ? (
                  <tr>
                    <td>Lines Rekoda can match for you now</td>
                    <td>{reconciliation.pairable}</td>
                  </tr>
                ) : null}
                <tr>
                  <td>Lines your books do not explain</td>
                  <td>
                    {reconciliation.unmatchedLines}
                    {reconciliation.unmatchedLines > 0 ? (
                      <>
                        {' '}
                        (<Money kobo={reconciliation.unmatchedLinesK} />)
                      </>
                    ) : null}
                  </td>
                </tr>
                <tr>
                  <td>Entries the statement does not show</td>
                  <td>
                    {reconciliation.unmatchedMovements}
                    {reconciliation.unmatchedMovements > 0 ? (
                      <>
                        {' '}
                        (<Money kobo={reconciliation.unmatchedMovementsK} />)
                      </>
                    ) : null}
                  </td>
                </tr>
                {reconciliation.ambiguous > 0 ? (
                  <tr>
                    <td>Lines that could be more than one entry</td>
                    <td>{reconciliation.ambiguous}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="rk-fineprint">
            Rekoda only matches a line when the amount is exact, the day is within a few days, and
            there is exactly one entry it could be. When two entries would both fit, it leaves the
            line for you rather than guessing: a wrong match makes your books and your bank look
            like they agree when they do not.
          </p>
          {/* Tier-3 proposals (§22.1): the payment reference says these two
              belong together, the amounts say otherwise. Shown, explained,
              never applied — two figures are two facts, and the difference
              is usually a bank charge the merchant should record. */}
          {reconciliation.proposals.length > 0 ? (
            <div className="rk-void">
              <h3>Worth a look</h3>
              {reconciliation.proposals.map((proposal) => {
                const line = lineById.get(proposal.lineId);
                return (
                  <p key={`${proposal.lineId}:${proposal.transactionId}`} className="rk-fineprint">
                    {line ? `The line from ${presentDay(line.postedOn)} (` : 'A statement line ('}
                    {line ? <Money kobo={line.amountK} /> : null}
                    {line ? ') ' : ''}
                    carries the payment reference of &ldquo;{proposal.movementMemo}&rdquo; (
                    <Money kobo={proposal.movementAmountK} />
                    {proposal.movementOccurredOn
                      ? `, ${presentDay(proposal.movementOccurredOn)}`
                      : ''}
                    ), but the amounts differ, so Rekoda has not matched them. If your bank took a
                    charge, record the charge as its own expense; the two will then agree.
                  </p>
                );
              })}
            </div>
          ) : null}
          {canReconcileBank(identity.role) ? (
            <ReconcileForm pairable={reconciliation.pairable} />
          ) : null}
        </div>
      ) : null}

      {/* The second door into the same statement: a feed the merchant
          authorises at their own bank. Hidden entirely when the deployment
          has no aggregator key, because a button that cannot work is worse
          than no button. */}
      {feed.state !== 'not_configured' && canReconcileBank(identity.role) ? (
        <div className="rk-card rk-dash-card">
          <h2>Your bank, connected</h2>
          {feed.state === 'linked' ? (
            <>
              <p className="rk-fineprint">
                Linked to your {feed.bankName}
                {feed.accountLast4 ? ` account ending ${feed.accountLast4}` : ''}.{' '}
                {feed.lastSyncedOn
                  ? `Last pulled on ${presentDay(feed.lastSyncedOn)}.`
                  : 'Nothing pulled yet.'}{' '}
                Pulled movements land in the statement below exactly as an uploaded file does, and
                nothing is ever counted twice.
              </p>
              <SyncFeedForm />
            </>
          ) : null}
          {feed.state === 'lapsed' ? (
            <>
              <p className="rk-fineprint">
                Your {feed.bankName}
                {feed.accountLast4 ? ` account ending ${feed.accountLast4}` : ' account'} needs to
                be authorised again. Banks ask for this from time to time; nothing you pulled is
                lost.
              </p>
              {isOwner(identity.role) ? <ConnectFeedForm /> : null}
            </>
          ) : null}
          {feed.state === 'not_linked' ? (
            <>
              <p className="rk-fineprint">
                Instead of downloading and uploading statements, you can let Rekoda pull what moved
                straight from your bank. You authorise it at your own bank and can withdraw that
                permission there any time. Rekoda never sees your bank sign-in.
              </p>
              {isOwner(identity.role) ? (
                <ConnectFeedForm />
              ) : (
                <p className="rk-fineprint">Only the owner can link a bank account.</p>
              )}
            </>
          ) : null}
        </div>
      ) : null}

      {canReconcileBank(identity.role) ? (
        <div className="rk-card rk-dash-card">
          <h2>Import a statement</h2>
          <StatementForm />
        </div>
      ) : null}

      {/* Full width, and not beside the form. A transaction table has three
          columns and one of them is money: squeezed into half a row it puts
          the amount off the right edge, which is the column a merchant came
          to read. */}
      <div className="rk-card rk-dash-card">
        <h2>What your bank reported</h2>
        {started ? (
          <>
            {/* `position.lines` is every line imported; the table below is a
                page of the newest hundred. Saying the first above the second
                with nothing between them told a merchant with four hundred
                lines that four hundred were on the screen. */}
            <p className="rk-fineprint">
              {position.lines === 1 ? 'One line' : `${position.lines} lines`}
              {position.latestOn ? `, up to ${presentDay(position.latestOn)}` : ''}. Anything still
              to decide comes first, then the newest.
              {position.lines > lines.length
                ? ` Showing ${lines.length} of them; the rest are settled or older, and all of them are counted above.`
                : ''}
            </p>
            <div className="rk-table-scroll">
              <table className="rk-table rk-table-tall">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>What the bank called it</th>
                    <th className="rk-num">Amount</th>
                    <th>In your books</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td data-label="Day">{presentDay(line.postedOn)}</td>
                      {/* The bank's own words, shown to the merchant who
                            downloaded them and to nobody else. Never sent to a
                            model, never put in a WhatsApp message. */}
                      <td data-label="What the bank called it">
                        {line.narration || <span className="rk-fineprint">No description</span>}
                      </td>
                      <td className="rk-num" data-label="Amount">
                        <Money kobo={line.amountK} />
                      </td>
                      {/* Candidates narrowed to the same amount here, on the
                            server, by the rule the endpoint enforces. Offering
                            an option that will be refused teaches a merchant
                            nothing about why. */}
                      <td data-label="In your books">
                        <LineMatchCell
                          lineId={line.id}
                          lineLabel={`${presentDay(line.postedOn)}, ${line.narration || 'no narration'}`}
                          matchedTo={line.matchedTo}
                          candidates={openMovements.filter((m) => m.amountK === line.amountK)}
                          canPair={canReconcileBank(identity.role)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {isOwner(identity.role) ? (
              <details className="rk-void">
                <summary>Remove a day you imported by mistake</summary>
                <p className="rk-fineprint">
                  For when you uploaded the wrong account&rsquo;s statement. Rekoda never edits what
                  your bank reported, so the only way to correct an import is to take it out and
                  import the right file.
                </p>
                <ForgetDayForm today={today} />
              </details>
            ) : null}
          </>
        ) : (
          <p className="rk-fineprint">
            Lines appear here once you import a statement, exactly as your bank wrote them.
          </p>
        )}
      </div>
    </section>
  );
}

/** `12 Aug 2026`, Lagos, from a plain calendar day. */
function presentDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}
