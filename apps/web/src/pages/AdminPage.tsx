import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ADDRESS_LIMIT,
  ADMIN,
  NAME_LIMIT,
  ROLES,
  losingAdminIsRefused,
  type AccountHoldings,
  type RegisteredUser,
  type Role,
} from '@cockpit/shared';
import { NotSignedIn, SIGN_IN_PATH } from '../api/client';
import { statusOf } from '../api/loadFailure';
import {
  accountHoldingsQuery,
  meQuery,
  registeredUsersQuery,
  useAddUser,
  useChangeUser,
  useDeleteUser,
  useSetAccess,
} from '../api/queries';
import { DeleteQuestion } from '../components/DeleteQuestion';
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
 * **Everything an admin does to who exists happens here**: reading the list,
 * adding somebody, changing a name or a role, taking access away or giving it
 * back, and deleting a person with the account they owned. What landed first
 * was the role check that guards all of them.
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
  /**
   * The row being edited, and **only the halves somebody has actually
   * touched** - `null` meaning "as the row has it", the way a workspace's form
   * holds its theme.
   *
   * A half snapshotted when the form opened would carry that value over an edit
   * made somewhere else in the meantime: two admins, one opens Ada's form to
   * fix a typo, the other makes her an admin, and the first one's Save silently
   * puts her back to an ordinary user. Neither refusal fires - the change is
   * about somebody else and there are admins left - so nobody is told.
   */
  const [editing, setEditing] = useState<{
    id: string;
    name: string | null;
    role: Role | null;
  } | null>(null);
  const changing = useChangeUser();
  const access = useSetAccess();
  /** Whose row asked the question that deletes them, if one is being asked. */
  const [deleting, setDeleting] = useState<string | null>(null);
  const removing = useDeleteUser();
  const askedFrom = useRef<HTMLElement | null>(null);
  /**
   * The list itself, which the focus goes back to once a delete has happened:
   * the row's menu it was asked from went with the row, so `returnFocusTo` has
   * nothing to return to, and the question closes by ceasing to exist rather
   * than by being dismissed. Left alone the focus falls to the document and the
   * next Tab starts from the top of the page - the same hole the workspaces'
   * list records.
   */
  const list = useRef<HTMLTableElement>(null);
  /** That the row a question was open on has gone, so the focus is owed to the list. */
  const focusTheList = useRef(false);
  /**
   * The admins a lockout rule counts, for a change about one particular
   * person: the ones who can actually sign in, and that person whatever their
   * access.
   *
   * One whose access was taken away can do nothing for anybody, so counting
   * them would tell the last admin left that somebody else could help. But the
   * rule subtracts the person it is about, so leaving a *disabled* admin out of
   * their own count makes the last one who can sign in look like the last admin
   * there is - which greys out demoting somebody who was disabled first, the
   * ordinary order to do those two things in.
   */
  const signedInAdmins = (data?.users ?? []).filter((user) => user.role === ADMIN && !user.disabled);
  const adminsCounting = (user: RegisteredUser) =>
    signedInAdmins.length + (user.role === ADMIN && user.disabled ? 1 : 0);

  /**
   * Read from the list rather than kept beside the draft, exactly as a
   * workspace's form does it: somebody deleted in another tab is gone from the
   * next list, and a form open on a row nothing holds would save into nothing.
   */
  const beingEdited = data?.users.find((user) => user.id === editing?.id);
  const beingDeleted = data?.users.find((user) => user.id === deleting);
  /**
   * Read only while the question is open, and only ever about the one person it
   * is about: opening every account in the register to draw this page would be
   * the cost of putting it in the list instead.
   */
  const holdings = useQuery({
    ...accountHoldingsQuery(deleting ?? ''),
    enabled: deleting !== null,
  });

  const startEditing = (user: RegisteredUser, openedFrom: HTMLElement | null) => {
    changing.reset();
    askedFrom.current = openedFrom;
    setEditing({ id: user.id, name: null, role: null });
  };
  const closeForm = () => {
    setEditing(null);
    changing.reset();
  };
  /** Starting one leaves the other, so at most one row is ever asking something. */
  const startDeleting = (user: RegisteredUser, openedFrom: HTMLElement | null) => {
    closeForm();
    removing.reset();
    askedFrom.current = openedFrom;
    setDeleting(user.id);
  };
  const stopAsking = () => {
    setDeleting(null);
    removing.reset();
  };

  /**
   * A question about somebody the list no longer holds closes itself, the way
   * the form on a row does.
   *
   * The case it is here for is *another* admin deleting them while the question
   * sat open: the row goes from the next read, and what is left is a question
   * about a person nothing holds, over a button that would ask the server to
   * delete them again. This deletion's own answer closes it too - a re-read that
   * failed would otherwise leave the question up over a person who is gone.
   */
  useEffect(() => {
    if (deleting === null || beingDeleted) return;
    setDeleting(null);
    focusTheList.current = true;
  }, [deleting, beingDeleted]);

  /**
   * The focus, once the row the question was asked from has gone with it.
   *
   * A frame later rather than in the answer itself: the question does not close
   * so much as cease to exist, and its own focus scope puts the focus back as it
   * unmounts - onto a row that is no longer there.
   */
  useEffect(() => {
    if (!focusTheList.current || beingDeleted) return;
    focusTheList.current = false;
    const frame = requestAnimationFrame(() => list.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [beingDeleted, deleting]);

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
      {/* A menu entry has nowhere of its own to be refused in - the menu is
          shut by the time the server answers - so what it could not do is said
          above the list, where the row it was about is. Without this, a refused
          Disable is a row that simply did not change, which reads exactly like
          a slow one. */}
      {access.error && (
        <p role="alert" className="mb-4 text-sm text-over">
          {whatItSaid(access.error)}
        </p>
      )}
      {/* A table rather than the rows the management windows use: every column
          here is a fact about somebody that an admin is comparing across
          people - who has signed in, who is an admin - and a list of rows makes
          that a scan rather than a glance. */}
      <div className="overflow-x-auto">
        {/* `tabIndex={-1}` so the focus can be put on the table and nowhere
            else: it is a destination for a delete that took the row the focus
            was on, not a stop on the way through the page. */}
        <table
          ref={list}
          tabIndex={-1}
          className="w-full min-w-[36rem] border-collapse text-left text-sm focus:outline-none"
        >
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
              <Row
                key={user.id}
                user={user}
                onEdit={startEditing}
                onAccess={(disabled) => access.mutate({ userId: user.id, disabled })}
                // Only a disabling is ever refused, so only a row that still
                // has its access has a reason to carry.
                accessStuck={
                  user.disabled
                    ? null
                    : whyAccessIsStuck(user, { me: me.data?.user.id, admins: adminsCounting(user) })
                }
                onDelete={startDeleting}
                deleteStuck={whyDeletingIsStuck(user, {
                  me: me.data?.user.id,
                  admins: adminsCounting(user),
                })}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* One form for the page: at most one row is being edited, and it covers
          the page while it is. */}
      {beingEdited && editing && (
        <RowForm
          title={`Edit ${beingEdited.name}`}
          // An untouched half reads from the row as it stands now, so what Save
          // sends is what is on the screen and never what was on it when the
          // form opened.
          name={editing.name ?? beingEdited.name}
          nameLabel={`Name of ${beingEdited.name}`}
          onName={(named) => setEditing({ ...editing, name: named })}
          nameLimit={NAME_LIMIT}
          choicesHeading="Role"
          choicesLabel={`Role of ${beingEdited.name}`}
          choicesRole="radiogroup"
          choices={ROLES.map((role) => {
            const stuck = whyTheRoleIsStuck(beingEdited, role, {
              me: me.data?.user.id,
              admins: adminsCounting(beingEdited),
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
                  checked={(editing.role ?? beingEdited.role) === role}
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
              {
                userId: editing.id,
                name: (editing.name ?? beingEdited.name).trim(),
                role: editing.role ?? beingEdited.role,
              },
              { onSuccess: () => setEditing(null) },
            )
          }
          returnFocusTo={askedFrom.current}
        />
      )}

      {/* The one thing here that destroys data nothing can put back, so it is
          asked in the same dialog as every other deletion and says what goes. */}
      {beingDeleted && (
        <DeleteQuestion
          open
          question={whatGoesWithThem(beingDeleted.name, holdings.data, holdings.isError)}
          confirmLabel={`Yes, delete ${beingDeleted.name}`}
          // Answerable as soon as the account has been read *or* has failed to
          // be: what it holds is what the sentence says, not what the deleting
          // needs, so a count that will not come must not trap an admin.
          canConfirm={!holdings.isPending && !removing.isPending}
          refusal={removing.error ? whatItSaid(removing.error) : null}
          onCancel={stopAsking}
          onConfirm={() =>
            removing.mutate(beingDeleted.id, {
              onSuccess: () => {
                setDeleting(null);
                focusTheList.current = true;
              },
            })
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
  // The rule is the server's, shared so the two cannot come apart; only the
  // wording is this page's, a label inside a choice being no place for a
  // sentence.
  const losing = losingAdminIsRefused({
    who: user,
    stillAnAdmin: role === ADMIN,
    askedBy: me,
    admins,
  });
  if (losing === 'the last admin') return 'The only admin, so make somebody else one first';
  if (losing === 'your own') return 'You cannot take your own admin away';
  return null;
}

/**
 * Why this person's access cannot be taken away, or `null` when it can.
 *
 * The same rule the role choice is refused by, asked of access: an admin who
 * cannot sign in is no more use than one who is not an admin, so disabling the
 * last one - or yourself - leaves the admin pages reachable by nobody.
 */
function whyAccessIsStuck(
  user: RegisteredUser,
  who: { me: string | undefined; admins: number },
): string | null {
  return whyItIsStuck(user, who, 'You cannot take your own access away');
}

/**
 * Why this person cannot be deleted, or `null` when they can.
 *
 * The same rule again, and for the same reason: deleting an admin takes their
 * access with everything else, so the last one - or yourself - would leave the
 * admin pages reachable by nobody.
 */
function whyDeletingIsStuck(
  user: RegisteredUser,
  who: { me: string | undefined; admins: number },
): string | null {
  return whyItIsStuck(user, who, 'You cannot delete yourself');
}

/**
 * The shared half of both: the rule is the server's, and only the sentence
 * naming what is being taken away belongs to the caller.
 */
function whyItIsStuck(
  user: RegisteredUser,
  { me, admins }: { me: string | undefined; admins: number },
  yourOwn: string,
): string | null {
  const losing = losingAdminIsRefused({ who: user, stillAnAdmin: false, askedBy: me, admins });
  if (losing === 'the last admin') return 'The only admin, so make somebody else one first';
  if (losing === 'your own') return yourOwn;
  return null;
}

/**
 * The question asked before somebody is deleted, naming what goes with them.
 *
 * **It says what the account holds**, because the account goes too and its
 * contents are the part nobody can see from this page. When that could not be
 * read the question is still answerable - what it holds is what the sentence
 * says, not what the deleting needs - so a failed count reads as unknown rather
 * than trapping an admin behind a number.
 *
 * **Workspaces, said as workspaces.** Items, types, dashboards and deleted
 * workspaces all go too, and an account with none of the first is not an empty
 * one; saying "there is nothing in their account" would be a claim the count
 * does not make. Workspaces are what an admin can size the loss by, and the
 * sentence around them already says the account goes with everything in it.
 */
function whatGoesWithThem(name: string, holds: AccountHoldings | undefined, failed: boolean): string {
  const account = failed
    ? 'what their account holds could not be read'
    : holds === undefined
      ? 'their account is being read'
      : holds.workspaces === 0
        ? 'their account has no workspaces'
        : `their account holds ${holds.workspaces} ${holds.workspaces === 1 ? 'workspace' : 'workspaces'}`;
  return `Delete ${name}? The account they own goes with them - ${account} - and only a backup can bring any of it back.`;
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
      {/* Bounded at what the contract allows, so the one refusal the server
          cannot put in its own words - "validation failed", which is all a
          shape check has to say - cannot be reached by typing. */}
      <label className="flex flex-col gap-1 text-xs text-ink-faint">
        Name
        <input
          className="rounded border border-black/15 px-2 py-1 text-sm text-ink"
          value={name}
          maxLength={NAME_LIMIT}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-faint">
        Signs in with
        <input
          className="rounded border border-black/15 px-2 py-1 text-sm text-ink"
          value={email}
          maxLength={ADDRESS_LIMIT}
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
  onAccess,
  accessStuck,
  onDelete,
  deleteStuck,
}: {
  user: RegisteredUser;
  onEdit: (user: RegisteredUser, openedFrom: HTMLElement | null) => void;
  onAccess: (disabled: boolean) => void;
  /** Why this person's access cannot be taken away, when it cannot. */
  accessStuck: string | null;
  onDelete: (user: RegisteredUser, openedFrom: HTMLElement | null) => void;
  /** Why this person cannot be deleted, when they cannot. */
  deleteStuck: string | null;
}) {
  return (
    <tr
      className="border-b border-black/5"
      onDoubleClick={(event) => {
        if (wasOnTheRow(event)) onEdit(user, null);
      }}
    >
      <td className="py-2 pr-4">
        {user.name}
        {/* The row stays where it was and says what happened to it, rather than
            leaving the list: somebody disabled is still somebody this Cockpit
            holds, and an admin looking for them would not find them in a list
            they had dropped out of. */}
        {user.disabled && (
          <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-xs text-ink-faint">
            No access
          </span>
        )}
      </td>
      {/* A person with no address is one nobody can sign in as, since the
          register is the allowlist. Said rather than left blank, because a
          blank cell reads as a page that failed to draw. */}
      <td className="py-2 pr-4 text-ink-faint">{user.email ?? 'no address — cannot sign in'}</td>
      <td className="py-2 pr-4">{roleName(user.role)}</td>
      <td className="py-2 pr-4 text-ink-faint">{user.accountName}</td>
      <td className="py-2 pr-4 text-ink-faint">{user.hasSignedIn ? 'yes' : 'not yet'}</td>
      <td className="py-2">
        <RowMenu
          label={`Actions for ${user.name}`}
          entries={[
            { label: 'Edit…', onSelect: (openedFrom) => onEdit(user, openedFrom) },
            {
              // One entry that says which way it goes, rather than two with one
              // of them always meaningless.
              label: user.disabled ? 'Enable' : 'Disable',
              keepsFocus: true,
              // Present and unavailable with the reason on it, the way the role
              // it repeats refuses - and the server refuses it as well.
              unavailable: accessStuck ?? undefined,
              destructive: !user.disabled,
              onSelect: () => onAccess(!user.disabled),
            },
            {
              label: 'Delete…',
              destructive: true,
              unavailable: deleteStuck ?? undefined,
              onSelect: (openedFrom) => onDelete(user, openedFrom),
            },
          ]}
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
