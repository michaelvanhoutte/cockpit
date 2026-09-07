import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ADMIN, ROLES, type RegisteredUser, type Role } from '@cockpit/shared';
import { NotSignedIn, SIGN_IN_PATH } from '../api/client';
import { statusOf } from '../api/loadFailure';
import { meQuery, registeredUsersQuery, useAddUser, useChangeUser } from '../api/queries';
import { RowForm, wasOnTheRow } from '../components/RowForm';
import { RowMenu } from '../components/Menu';

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
 * **It reads, it adds, and it changes a person's name and role.** Disabling and
 * deleting are the issues after this one; what landed here first was the role
 * check that guards all of them.
 *
 * **The server is what refuses**, not this page. The entry to it is hidden from
 * an ordinary user, and hiding is a courtesy: whoever types the address anyway
 * is refused by the gate in `auth/admin.ts`, and what they see here is that
 * refusal drawn.
 */
export function AdminPage() {
  const { data, error, isPending } = useQuery(registeredUsersQuery);
  // Who is asking, which one of the two refusals is about. A read that has not
  // settled or has failed simply leaves that refusal to the server, which makes
  // it either way.
  const me = useQuery(meQuery);
  const [editing, setEditing] = useState<{ id: string; name: string; role: Role } | null>(null);
  const changing = useChangeUser();
  const askedFrom = useRef<HTMLElement | null>(null);

  /**
   * Read from the list rather than kept beside the draft, exactly as a
   * workspace's form does it: somebody deleted in another tab is gone from the
   * next list, and a form open on a row nothing holds would save into nothing.
   */
  const beingEdited = data?.users.find((user) => user.id === editing?.id);

  const startEditing = (user: RegisteredUser, openedFrom: HTMLElement | null) => {
    changing.reset();
    askedFrom.current = openedFrom;
    setEditing({ id: user.id, name: user.name, role: user.role });
  };
  const closeForm = () => {
    setEditing(null);
    changing.reset();
  };

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
      <AddSomebody />
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
              <th className="py-2 pr-4 font-medium">Signed in</th>
              {/* The menu's column, named for a reader who cannot see that it
                  holds a control rather than a fact. */}
              <th className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((user) => (
              <Row key={user.id} user={user} onEdit={startEditing} />
            ))}
          </tbody>
        </table>
      </div>

      {/* One form for the page: at most one row is being edited, and it covers
          the page while it is. */}
      {beingEdited && editing && (
        <RowForm
          title={`Edit ${beingEdited.name}`}
          name={editing.name}
          nameLabel={`Name of ${beingEdited.name}`}
          onName={(named) => setEditing({ ...editing, name: named })}
          nameLimit={120}
          choicesHeading="Role"
          choicesLabel={`Role of ${beingEdited.name}`}
          choices={ROLES.map((role) => {
            const stuck = whyTheRoleIsStuck(beingEdited, role, {
              me: me.data?.user.id,
              admins: data.users.filter((user) => user.role === ADMIN).length,
            });
            return (
              /* Present and unavailable with the reason on it, the way a
                 workspace's last dashboard refuses to be deleted: an entry that
                 vanishes leaves an admin looking for a choice that was there a
                 moment ago, and one that is offered and then refused makes
                 them find out by trying. The server refuses it as well - this
                 is the courtesy, not the rule. */
              <label
                key={role}
                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                  stuck ? 'border-black/5 text-ink-faint' : 'border-black/10'
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value={role}
                  checked={editing.role === role}
                  disabled={changing.isPending || Boolean(stuck)}
                  onChange={() => setEditing({ ...editing, role })}
                />
                <span>
                  {roleName(role)}
                  {/* Inside the label rather than beside it, so the reason is
                      part of what the choice is called. */}
                  {stuck && <span className="block text-xs">{stuck}</span>}
                </span>
              </label>
            );
          })}
          refusal={changing.error ? whatItSaid(changing.error) : null}
          saving={changing.isPending}
          onCancel={closeForm}
          onSave={() =>
            changing.mutate(
              { userId: editing.id, name: editing.name.trim(), role: editing.role },
              { onSuccess: () => setEditing(null) },
            )
          }
          returnFocusTo={askedFrom.current}
        />
      )}
    </Framed>
  );
}

/** What a role is called on the screen, rather than the word the register holds. */
function roleName(role: Role): string {
  return role === ADMIN ? 'Admin' : 'User';
}

/**
 * Why this role cannot be chosen for this person, or `null` when it can.
 *
 * **Both reasons are about the same danger and are said differently**, because
 * "another admin can do it for you" is false when there is no other admin. Only
 * losing the role is ever refused: making somebody an admin cannot lock anybody
 * out.
 *
 * Its own words rather than the server's, exactly as a workspace's last
 * dashboard has its own: this is a short label inside a choice, and the
 * server's sentence is what appears under the form if somebody gets past it.
 */
function whyTheRoleIsStuck(
  user: RegisteredUser,
  role: Role,
  { me, admins }: { me: string | undefined; admins: number },
): string | null {
  if (user.role !== ADMIN || role === ADMIN) return null;
  if (admins <= 1) return 'The only admin, so make somebody else one first';
  if (user.id === me) return 'You cannot take your own admin away';
  return null;
}

/**
 * What to put under the form when a change did not happen.
 *
 * A lapsed sign-in is not a refusal of what was typed, and saying "401" would
 * leave an admin retrying a request that cannot work - the same reason the box
 * above says it, and the same sentence.
 */
function whatItSaid(failure: Error): string {
  return failure instanceof NotSignedIn
    ? 'Your sign-in has ended, so nothing was changed. Sign in again to continue.'
    : failure.message;
}

/**
 * The box that adds somebody, above the list rather than on a page of its own:
 * adding is the thing an admin comes here to do, and the list is what says
 * whether it worked ("Add a user on the admin page, so a second person no
 * longer needs SQL", issue 231).
 *
 * **What is typed is a name and an address, and nothing else.** Everybody
 * arrives ordinary and is made an admin afterwards on their own row, where the
 * rules protecting that role live; the account is made with the person rather
 * than chosen. So a field for either would be asking for something this box
 * does not decide.
 */
function AddSomebody() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const adding = useAddUser();

  return (
    <form
      className="mb-6 flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        adding.mutate(
          { name: name.trim(), email: email.trim() },
          // Cleared only once it worked: a refusal keeps what was typed, so
          // fixing an address is an edit rather than typing it all again.
          { onSuccess: () => { setName(''); setEmail(''); } },
        );
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-ink-faint">
        Name
        <input
          className="rounded border border-black/15 px-2 py-1 text-sm text-ink"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-faint">
        Signs in with
        <input
          className="rounded border border-black/15 px-2 py-1 text-sm text-ink"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <button
        type="submit"
        className="rounded bg-black/80 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        disabled={adding.isPending || name.trim() === '' || email.trim() === ''}
      >
        {adding.isPending ? 'Adding…' : 'Add'}
      </button>
      {/* The server's own words, because they name which address is already
          somebody's and what a name left nothing of. */}
      {adding.error && (
        <p role="alert" className="w-full text-sm text-ink-faint">
          {/* A sign-in that lapsed while the page sat open is not a refusal of
              what was typed, and saying "401" under the box would leave an
              admin retrying a request that cannot work. Everywhere else in the
              app a lost sign-in offers the way back in; so does this. */}
          {adding.error instanceof NotSignedIn ? (
            <>
              Your sign-in has ended, so nobody was added.{' '}
              <a className="underline" href={SIGN_IN_PATH}>
                Sign in again
              </a>
              .
            </>
          ) : (
            adding.error.message
          )}
        </p>
      )}
      {/* Said rather than swallowed: the person is added either way, and an
          admin who is not told would find out when that person could not get
          in. */}
      {adding.data?.accountReady === false && (
        <p role="status" className="w-full text-sm text-ink-faint">
          {adding.data.user.name} was added, but their account could not be prepared. It will be
          made when they first sign in.
        </p>
      )}
    </form>
  );
}

/**
 * One person, and the two ways their form opens - a double-click on the row and
 * **Edit…** in its own menu, which is the only way a keyboard has and the
 * comfortable one on a phone, where a double-tap is a gesture the browser has
 * already spent on zooming (`components/RowForm.tsx`).
 */
function Row({
  user,
  onEdit,
}: {
  user: RegisteredUser;
  onEdit: (user: RegisteredUser, openedFrom: HTMLElement | null) => void;
}) {
  return (
    <tr
      className="border-b border-black/5"
      onDoubleClick={(event) => {
        if (wasOnTheRow(event)) onEdit(user, null);
      }}
    >
      <td className="py-2 pr-4">{user.name}</td>
      {/* A person with no address is one nobody can sign in as, since the
          register is the allowlist. Said rather than left blank, because a
          blank cell reads as a page that failed to draw. */}
      <td className="py-2 pr-4 text-ink-faint">{user.email ?? 'no address — cannot sign in'}</td>
      <td className="py-2 pr-4">{user.role}</td>
      <td className="py-2 pr-4 text-ink-faint">{user.accountName}</td>
      <td className="py-2 pr-4 text-ink-faint">{user.hasSignedIn ? 'yes' : 'not yet'}</td>
      <td className="py-2">
        <RowMenu
          label={`Actions for ${user.name}`}
          entries={[{ label: 'Edit…', onSelect: (openedFrom) => onEdit(user, openedFrom) }]}
        />
      </td>
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
        Everyone this Cockpit knows. Add somebody and they can sign in straight away.
      </p>
      {children}
    </main>
  );
}
