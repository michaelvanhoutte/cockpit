import { useQuery } from '@tanstack/react-query';
import type { RegisteredUser } from '@cockpit/shared';
import { statusOf } from '../api/loadFailure';
import { registeredUsersQuery } from '../api/queries';

/**
 * Who can sign in to this Cockpit, on a page only an admin can open ("See who
 * can sign in, on a page only an admin can open", issue 230).
 *
 * **A screen rather than a window over a workspace**, which is the one
 * exception to the rule that managing is a window (functional definition,
 * "Managing the Account is a window over the Workspace you are in"). The three
 * windows manage an *Account* - its workspaces, its types, its dashboards - and
 * this manages the environment: who exists at all, across every account. There
 * is no workspace behind it to keep, so it heads itself the way Capture does
 * rather than borrowing the band above.
 *
 * **It only reads.** Adding, renaming, promoting, disabling and deleting are
 * the issues after this one; what lands here first is the role check, with
 * nothing yet able to change anything through it.
 *
 * **The server is what refuses**, not this page. The entry to it is hidden from
 * an ordinary user, and hiding is a courtesy: whoever types the address anyway
 * is refused by the gate in `auth/admin.ts`, and what they see here is that
 * refusal drawn.
 */
export function AdminPage() {
  const { data, error, isPending } = useQuery(registeredUsersQuery);

  if (isPending) return <Framed>Reading who can sign in…</Framed>;
  /**
   * **Only a 403 is "you are not an admin".** Everything else - offline, a
   * deploy in flight, a 500 - would be a false statement about the person
   * reading it, and the alarming one: it tells an admin they have lost their
   * role when what has happened is that a request failed.
   */
  if (error) {
    return (
      <Framed>
        <p className="text-ink-faint">
          {statusOf(error) === '403'
            ? 'This page is for admins, and Cockpit does not have you down as one.'
            : 'Who can sign in could not be read just now. Try again in a moment.'}
        </p>
      </Framed>
    );
  }

  return (
    <Framed>
      {/* A table rather than the rows the management windows use: every column
          here is a fact about somebody that an admin is comparing across
          people - who has signed in, who is an admin - and a list of rows makes
          that a scan rather than a glance. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-black/10 text-xs uppercase tracking-wide text-ink-faint">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Signs in with</th>
              <th className="py-2 pr-4 font-medium">Role</th>
              <th className="py-2 pr-4 font-medium">Account</th>
              <th className="py-2 font-medium">Signed in</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((user) => (
              <Row key={user.id} user={user} />
            ))}
          </tbody>
        </table>
      </div>
    </Framed>
  );
}

function Row({ user }: { user: RegisteredUser }) {
  return (
    <tr className="border-b border-black/5">
      <td className="py-2 pr-4">{user.name}</td>
      {/* A person with no address is one nobody can sign in as, since the
          register is the allowlist. Said rather than left blank, because a
          blank cell reads as a page that failed to draw. */}
      <td className="py-2 pr-4 text-ink-faint">{user.email ?? 'no address — cannot sign in'}</td>
      <td className="py-2 pr-4">{user.role}</td>
      <td className="py-2 pr-4 text-ink-faint">{user.accountName}</td>
      <td className="py-2 text-ink-faint">{user.hasSignedIn ? 'yes' : 'not yet'}</td>
    </tr>
  );
}

/**
 * The page's own heading and frame. Written here rather than taken from the
 * shell for the reason the page exists outside a workspace: the band above
 * belongs to whichever workspace you were last in, and a page about the whole
 * environment must not wear one account's colour.
 */
function Framed({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6">
      <h1 className="mb-1 text-lg font-semibold">Who can sign in</h1>
      <p className="mb-4 text-sm text-ink-faint">
        Everyone this Cockpit knows. Adding and changing them comes next.
      </p>
      {children}
    </main>
  );
}
