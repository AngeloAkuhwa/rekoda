import type { Metadata } from 'next';
import { lagosDay } from '@rekoda/core';
import { Money } from '@/components/ui/Money';
import { bankPosition } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { StatementForm } from './StatementForm';
import { ForgetDayForm } from './ForgetDayForm';

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
  const { position, lines } = await bankPosition(token);
  const today = lagosDay(new Date());
  const started = position.lines > 0;

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">{identity.businessName}</p>
          <h1>What your bank says</h1>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="bank" />

      {started ? (
        <div className="rk-card rk-dash-card">
          <h2>Your books, and your bank</h2>
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

      <div className="rk-card rk-dash-card">
        <h2>Import a statement</h2>
        <StatementForm />
      </div>

      {/* Full width, and not beside the form. A transaction table has three
          columns and one of them is money: squeezed into half a row it puts
          the amount off the right edge, which is the column a merchant came
          to read. */}
      <div className="rk-card rk-dash-card">
        <h2>What your bank reported</h2>
        {started ? (
          <>
            <p className="rk-fineprint">
              {position.lines === 1 ? 'One line' : `${position.lines} lines`}
              {position.latestOn ? `, up to ${position.latestOn}` : ''}. Newest first.
            </p>
            <div className="rk-table-scroll">
              <table className="rk-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>What the bank called it</th>
                    <th className="rk-num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.postedOn}</td>
                      {/* The bank's own words, shown to the merchant who
                            downloaded them and to nobody else. Never sent to a
                            model, never put in a WhatsApp message. */}
                      <td>
                        {line.narration || <span className="rk-fineprint">No description</span>}
                      </td>
                      <td className="rk-num">
                        <Money kobo={line.amountK} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details className="rk-void">
              <summary>Remove a day you imported by mistake</summary>
              <p className="rk-fineprint">
                For when you uploaded the wrong account&rsquo;s statement. Rekoda never edits what
                your bank reported, so the only way to correct an import is to take it out and
                import the right file.
              </p>
              <ForgetDayForm today={today} />
            </details>
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
