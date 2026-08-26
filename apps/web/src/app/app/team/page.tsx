import type { Metadata } from 'next';
import { ApiForbidden, businessMembers } from '@/server/api';
import { requireSessionWithToken } from '@/server/guards';
import { AppNav } from '../AppNav';
import { SignOutButton } from '../SignOutButton';
import { InviteForm, RemoveMemberForm } from './TeamForms';
import { heldBy } from '@/lib/capabilities';

export const metadata: Metadata = {
  title: 'Who can see your books',
  robots: { index: false, follow: false },
};

/**
 * The team (spec §35, MASTER-PLAN 5.2.2).
 *
 * The `accountant` role has been enforced since M1 with no way to create one,
 * which made the guard a fence around an empty field. This is the field.
 *
 * Owner only, and the API says so rather than this page: an accountant is
 * inside the tenant and passes every row-level security policy, so hiding a
 * link would be decoration. Reaching the endpoint is what gets refused.
 */
export default async function TeamPage() {
  const { identity, token } = await requireSessionWithToken();

  let members;
  try {
    members = (await businessMembers(token)).members;
  } catch (error) {
    /* Only a 403 means "not yours to see". Anything else — the API down,
     * a bad gateway — must reach the error boundary: telling the OWNER they
     * are not the owner because a request failed is the one wrong answer. */
    if (!(error instanceof ApiForbidden)) throw error;
    return (
      <section className="rk-container rk-dash">
        <header className="rk-dash-head">
          <div>
            <p className="rk-eyebrow">Team</p>
            <h1>Who can see your books</h1>
          </div>
          <SignOutButton />
        </header>
        <AppNav active="team" held={heldBy(identity)} />
        <div className="rk-card">
          <p className="rk-dash-empty-line">
            Only the business owner can see and change who has access. Ask them if you need somebody
            added.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="rk-container rk-dash">
      <header className="rk-dash-head">
        <div>
          <p className="rk-eyebrow">Team</p>
          <h1>Who can see your books</h1>
          <p className="rk-fineprint">
            Everyone here can read your records. Only you can add or remove people.
          </p>
        </div>
        <SignOutButton />
      </header>

      <AppNav active="team" held={heldBy(identity)} />

      <div className="rk-card">
        <h2>People with access</h2>
        <div className="rk-table-scroll">
          <table className="rk-table">
            <thead>
              <tr>
                <th>Phone</th>
                <th>Role</th>
                <th>Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <td>{member.phone}</td>
                  <td>{roleWord(member.role)}</td>
                  <td>{shortDate(member.addedAt)}</td>
                  <td>
                    {member.role === 'owner' ? (
                      <span className="rk-fineprint">that is you</span>
                    ) : (
                      <RemoveMemberForm userId={member.userId} phone={member.phone} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rk-card">
        <h2>Add someone</h2>
        <p className="rk-fineprint">
          They sign in on their own phone with their own code. They do not need a Rekoda account
          first, and you can remove them at any time.
        </p>
        <InviteForm />
      </div>
    </section>
  );
}

/** The role in the words a merchant uses, not the ones the database uses. */
function roleWord(role: string): string {
  if (role === 'owner') return 'Owner';
  if (role === 'accountant') return 'Accountant, can read everything';
  return 'Helper, can record sales';
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-NG', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Lagos',
  });
}
