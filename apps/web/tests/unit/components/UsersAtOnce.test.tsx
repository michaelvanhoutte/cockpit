import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RegisteredUser } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import ManageUsers from '../../../src/components/ManageUsers';
import SavingMark from '../../../src/components/SavingMark';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A user change as each control makes it, with the server holding the answer -
 * the frontend-with-its-own-backend level (F2), run in this runner as
 * `ConnectionsAtOnce.test.tsx` is. The window, its queries and the tab's queue are
 * the app's own and only the network is replaced: a server that answers when the
 * test says, keeps the register it is told to, and refuses what the real one
 * refuses. What each change draws is tests/unit/registeredUsersDrawnAhead.test.ts
 * and when it stops being drawn is tests/unit/changeQueue.test.ts; what is asked
 * here is that every control is wired to them, and that the saving sign and the
 * leave-site prompt cover each.
 */

type Waiting = {
  kind: 'add' | 'change' | 'access' | 'delete';
  userId: string | undefined;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
  answer: () => void;
  refuse: (status: number, error: string) => void;
};

const held = vi.hoisted(() => {
  const state = {
    /** What the register answers with, and how many times it has been read. */
    users: [] as RegisteredUser[],
    reads: 0,
    /** How many times who is signed in has been read. */
    meReads: 0,
    /** While set, a read of the register looks at what the server holds and is then held until it is released. */
    hold: false,
    releases: [] as (() => void)[],
    /** Whether the account of somebody just added could be prepared. */
    accountReady: true,
    /** Every change the server has been sent and not yet answered, oldest first. */
    waiting: [] as Waiting[],
  };

  /** What the server does with a change it accepts, and the refusal the real one gives. */
  function apply(kind: Waiting['kind'], userId: string | undefined, body: Record<string, unknown>): Response {
    const who = state.users.find((one) => one.id === userId);
    if (kind === 'add') {
      const email = String(body.email).trim().toLowerCase();
      const taken = state.users.find((one) => one.email === email);
      if (taken) return Response.json({ error: `${email} is already how ${taken.id} signs in` }, { status: 409 });
      const name = String(body.name).trim();
      const user: RegisteredUser = {
        id: `user-${name.toLowerCase()}`,
        name,
        email,
        role: 'user',
        accountName: name,
        lastSignedInAt: null,
        disabled: false,
      };
      state.users = [...state.users, user];
      return Response.json({ user, accountReady: state.accountReady }, { status: 201 });
    }
    if (!who) return Response.json({ error: `${String(userId)} is nobody here` }, { status: 404 });
    if (kind === 'delete') {
      state.users = state.users.filter((one) => one !== who);
      return Response.json({ deleted: true });
    }
    const after: RegisteredUser =
      kind === 'change'
        ? { ...who, name: String(body.name).trim(), role: body.role as RegisteredUser['role'], accountName: String(body.name).trim() }
        : { ...who, disabled: Boolean(body.disabled) };
    state.users = state.users.map((one) => (one === who ? after : one));
    return Response.json({ user: after });
  }

  function respond(kind: Waiting['kind'], userId: string | undefined, body: Record<string, unknown>, options?: { init?: RequestInit }) {
    return new Promise<Response>((resolve) => {
      state.waiting.push({
        kind,
        userId,
        body,
        signal: options?.init?.signal ?? undefined,
        answer: () => resolve(apply(kind, userId, body)),
        refuse: (status, error) => resolve(Response.json({ error }, { status })),
      });
    });
  }

  return { state, respond };
});

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  api: {
    v1: {
      admin: {
        users: {
          $get: async () => {
            held.state.reads += 1;
            const seen = structuredClone(held.state.users);
            if (held.state.hold) await new Promise<void>((resolve) => held.state.releases.push(resolve));
            return Response.json({ users: seen });
          },
          $post: ({ json }: { json: Record<string, unknown> }, options?: { init?: RequestInit }) => held.respond('add', undefined, json, options),
          ':userId': {
            $patch: ({ param, json }: { param: { userId: string }; json: Record<string, unknown> }, options?: { init?: RequestInit }) =>
              held.respond('change', param.userId, json, options),
            $delete: ({ param }: { param: { userId: string } }, options?: { init?: RequestInit }) =>
              held.respond('delete', param.userId, {}, options),
            access: {
              $patch: ({ param, json }: { param: { userId: string }; json: Record<string, unknown> }, options?: { init?: RequestInit }) =>
                held.respond('access', param.userId, json, options),
            },
          },
        },
      },
    },
  },
  // Read by the queries the window shares with the rest of the app, which hold the client's own `api`: who is asking, and what an account holds.
  fetchMe: () => {
    held.state.meReads += 1;
    return Promise.resolve({ user: { id: 'user-michael', name: 'Michael', role: 'admin' } });
  },
  fetchAccountHoldings: () => Promise.resolve({ workspaces: 0, empty: true }),
}));

const MICHAEL: RegisteredUser = {
  id: 'user-michael',
  name: 'Michael',
  email: 'michael@example.com',
  role: 'admin',
  accountName: 'Michael',
  lastSignedInAt: '2026-10-20T00:00:00.000Z',
  disabled: false,
};
const ADA: RegisteredUser = {
  id: 'user-ada',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'user',
  accountName: 'Ada',
  lastSignedInAt: '2026-10-19T00:00:00.000Z',
  disabled: false,
};
const GRACE: RegisteredUser = { ...ADA, id: 'user-grace', name: 'Grace', email: 'grace@example.com', accountName: 'Grace', role: 'admin' };

let client: QueryClient;

async function show(users: RegisteredUser[]) {
  held.state.users = [...users];
  held.state.reads = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <SavingMark />
        <ManageUsers open onClose={() => {}} />
      </UndoWhatJustHappened>
    </QueryClientProvider>,
  );
  await screen.findByText(users[0]!.name);
  // Who is asking, which the lockout rules are about.
  await screen.findByRole('button', { name: `Actions for ${users[0]!.name}` });
  return userEvent.setup();
}

const waitingFor = () => held.state.waiting.map((request) => request.kind);
const names = () => screen.queryAllByRole('listitem').map((row) => row.querySelector('p')?.firstChild?.textContent);
/** Everyone listed, by name: the list itself is stalest first, which is the window's own business. */
const people = () => names().sort();
const rowOf = (name: string) => screen.getByText(name).closest('li')!;

/** Lets what the app does between an answer and the read behind it happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The server answers the oldest change it is holding. */
async function answerNext() {
  await act(async () => held.state.waiting.shift()!.answer());
  await settle();
}

async function refuseNext(status: number, error: string) {
  await act(async () => held.state.waiting.shift()!.refuse(status, error));
  await settle();
}

async function chooseOnRow(user: ReturnType<typeof userEvent.setup>, name: string, entry: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

async function add(user: ReturnType<typeof userEvent.setup>, name: string, email: string) {
  await user.type(screen.getByLabelText('Name'), name);
  await user.type(screen.getByLabelText('Signs in with'), email);
  await user.click(screen.getByRole('button', { name: 'Add' }));
}

async function edit(user: ReturnType<typeof userEvent.setup>, name: string, { to, role }: { to?: string; role?: RegExp }) {
  await chooseOnRow(user, name, 'Edit…');
  if (to !== undefined) {
    const box = screen.getByLabelText(`Name of ${name}`);
    await user.clear(box);
    await user.type(box, to);
  }
  if (role) await user.click(screen.getByRole('radio', { name: role }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

async function remove(user: ReturnType<typeof userEvent.setup>, name: string) {
  await chooseOnRow(user, name, 'Delete');
  const yes = await screen.findByRole('button', { name: `Yes, delete ${name}` });
  await waitFor(() => expect(yes).toBeEnabled());
  await user.click(yes);
}

const leave = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  held.state.waiting = [];
  held.state.hold = false;
  held.state.releases = [];
  held.state.accountReady = true;
});

afterEach(async () => {
  cleanup();
  resetStanding();
  for (let round = 0; round < 6 && changes.unanswered() > 0; round += 1) {
    await act(async () => held.state.waiting.splice(0).forEach((request) => request.answer()));
    await settle();
  }
  changes.forgetAnswered();
});

describe('User management', () => {
  describe('a change to a user shows the moment it is made, with the server still holding the answer', () => {
    it('puts somebody added in the list with the name typed, and empties the boxes', async () => {
      const user = await show([MICHAEL, ADA]);

      await add(user, 'Anna', 'anna@example.com');

      expect(names()).toContain('Anna');
      expect(within(rowOf('Anna')).getByText('anna@example.com')).toBeVisible();
      expect(screen.getByLabelText('Name')).toHaveValue('');
      expect(screen.getByLabelText('Signs in with')).toHaveValue('');
      expect(waitingFor()).toEqual(['add']);
    });

    it('offers nothing to change on somebody just added, whose id the server has yet to give', async () => {
      const user = await show([MICHAEL, ADA]);

      await add(user, 'Anna', 'anna@example.com');

      expect(screen.queryByRole('button', { name: 'Actions for Anna' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Actions for Ada' })).toBeVisible();
    });

    it('names the new name on the row, and the account they own, and closes the form when somebody is renamed', async () => {
      const user = await show([MICHAEL, ADA]);

      await edit(user, 'Ada', { to: 'Ada Lovelace' });

      expect(names()).toContain('Ada Lovelace');
      expect(names()).not.toContain('Ada');
      expect(rowOf('Ada Lovelace')).toHaveTextContent('User · Ada Lovelace');
      expect(screen.queryByRole('dialog', { name: /^Edit / })).toBeNull();
      expect(waitingFor()).toEqual(['change']);
    });

    it('shows the new role on the row and closes the form when a role is changed', async () => {
      const user = await show([MICHAEL, ADA]);

      await edit(user, 'Ada', { role: /^Admin/ });

      expect(rowOf('Ada')).toHaveTextContent('Admin ·');
      expect(screen.queryByRole('dialog', { name: /^Edit / })).toBeNull();
      expect(waitingFor()).toEqual(['change']);
    });

    it('says the row has no access once somebody is blocked, and stops saying so once they are unblocked', async () => {
      const user = await show([MICHAEL, ADA]);

      await chooseOnRow(user, 'Ada', 'Disable');
      expect(within(rowOf('Ada')).getByText('No access')).toBeVisible();
      await answerNext();

      await chooseOnRow(user, 'Ada', 'Enable');
      expect(within(rowOf('Ada')).queryByText('No access')).toBeNull();
      expect(waitingFor()).toEqual(['access']);
    });

    it('takes the row away and closes the question when somebody is deleted', async () => {
      const user = await show([MICHAEL, ADA]);

      await remove(user, 'Ada');

      expect(names()).toEqual(['Michael']);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(waitingFor()).toEqual(['delete']);
    });
  });

  describe('a user change stays on the screen until the register is read after its answer', () => {
    it('keeps the new name under a read begun before the answer, and shows the server’s register after one begun later', async () => {
      const user = await show([MICHAEL, ADA]);
      await edit(user, 'Ada', { to: 'Ada Lovelace' });

      // A read begins now and is held: it saw the register as the server held it before the answer.
      held.state.hold = true;
      void client.invalidateQueries({ queryKey: ['registeredUsers'] });
      await waitFor(() => expect(held.state.releases).toHaveLength(1));
      await answerNext();
      await act(async () => held.state.releases.splice(0).forEach((release) => release()));
      // It has landed with the old name, and the read owed behind the answer is on its way.
      await waitFor(() => expect(held.state.releases).toHaveLength(1));
      expect(names()).toContain('Ada Lovelace');
      held.state.hold = false;
      await act(async () => held.state.releases.splice(0).forEach((release) => release()));
      await settle();
      expect(names()).toContain('Ada Lovelace');

      // Another admin renames her again once the answer has been read: that is the server's now.
      held.state.users = held.state.users.map((one) => (one.id === 'user-ada' ? { ...one, name: 'Ada King' } : one));
      await act(async () => void (await client.invalidateQueries({ queryKey: ['registeredUsers'] })));

      await waitFor(() => expect(names()).toContain('Ada King'));
    });

    it('keeps a deleted person gone under a read begun before the answer', async () => {
      const user = await show([MICHAEL, ADA]);
      await remove(user, 'Ada');

      held.state.hold = true;
      void client.invalidateQueries({ queryKey: ['registeredUsers'] });
      await waitFor(() => expect(held.state.releases).toHaveLength(1));
      await answerNext();
      await act(async () => held.state.releases.splice(0).forEach((release) => release()));
      await waitFor(() => expect(held.state.releases).toHaveLength(1));

      expect(names()).toEqual(['Michael']);
      held.state.hold = false;
      await act(async () => held.state.releases.splice(0).forEach((release) => release()));
    });

    it('reads the register once after the answers when several changes are made together', async () => {
      const user = await show([MICHAEL, ADA]);
      await edit(user, 'Ada', { to: 'Ada Lovelace' });
      await add(user, 'Anna', 'anna@example.com');
      const before = held.state.reads;

      await answerNext();
      await waitFor(() => expect(waitingFor()).toEqual(['add']));
      expect(held.state.reads).toBe(before);
      await answerNext();

      await waitFor(() => expect(held.state.reads).toBe(before + 1));
      await settle();
      expect(held.state.reads).toBe(before + 1);
      expect(names()).toEqual(expect.arrayContaining(['Michael', 'Ada Lovelace', 'Anna']));
    });
  });

  describe('a rename or a change of access reads who is signed in too, since the header’s name comes from it', () => {
    it.each([
      { situation: 'somebody renamed', change: (user: ReturnType<typeof userEvent.setup>) => edit(user, 'Ada', { to: 'Ada Lovelace' }), reads: 1 },
      { situation: 'somebody blocked', change: (user: ReturnType<typeof userEvent.setup>) => chooseOnRow(user, 'Ada', 'Disable'), reads: 1 },
      { situation: 'somebody added', change: (user: ReturnType<typeof userEvent.setup>) => add(user, 'Anna', 'anna@example.com'), reads: 0 },
      { situation: 'somebody deleted', change: (user: ReturnType<typeof userEvent.setup>) => remove(user, 'Ada'), reads: 0 },
    ])('reads it $reads times after $situation', async ({ change, reads }) => {
      const user = await show([MICHAEL, ADA]);
      await change(user);
      const before = held.state.meReads;

      await answerNext();
      await waitFor(() => expect(held.state.reads).toBeGreaterThan(1));
      await settle();

      expect(held.state.meReads - before).toBe(reads);
    });
  });

  describe('what the server decides about a new user fills in when the register is read after the answer', () => {
    it('offers the changes to somebody added once the register has been read, with the account the server made', async () => {
      const user = await show([MICHAEL, ADA]);
      await add(user, 'Anna', 'anna@example.com');
      expect(screen.queryByRole('button', { name: 'Actions for Anna' })).toBeNull();

      await answerNext();

      expect(await screen.findByRole('button', { name: 'Actions for Anna' })).toBeVisible();
      expect(rowOf('Anna')).toHaveTextContent('User · Anna');
      expect(names().filter((name) => name === 'Anna')).toHaveLength(1);
    });

    it('says so when somebody was added but their account was not ready', async () => {
      held.state.accountReady = false;
      const user = await show([MICHAEL, ADA]);
      await add(user, 'Anna', 'anna@example.com');

      await answerNext();

      expect(await screen.findByText(/Anna was added, but their account could not be prepared/)).toBeVisible();
    });
  });

  describe('a user change the server refuses is put back, and says why', () => {
    it('takes the person out again and says why under the box, with what was typed back in it, when the address is already somebody’s', async () => {
      const user = await show([MICHAEL, ADA]);
      await add(user, 'Someone', 'ada@example.com');
      expect(names()).toContain('Someone');

      await answerNext();

      expect(people()).toEqual(['Ada', 'Michael']);
      expect(await screen.findByRole('alert')).toHaveTextContent('ada@example.com is already how user-ada signs in');
      expect(screen.getByLabelText('Name')).toHaveValue('Someone');
      expect(screen.getByLabelText('Signs in with')).toHaveValue('ada@example.com');
    });

    it('leaves what was typed since in the boxes when an add is refused after the person has moved on', async () => {
      const user = await show([MICHAEL, ADA]);
      await add(user, 'Someone', 'ada@example.com');
      await user.type(screen.getByLabelText('Name'), 'Anna');

      await answerNext();

      expect(await screen.findByRole('alert')).toHaveTextContent('already how user-ada signs in');
      expect(screen.getByLabelText('Name')).toHaveValue('Anna');
      expect(screen.getByLabelText('Signs in with')).toHaveValue('');
    });

    it('says it in the undo bar instead when the window has been closed by then', async () => {
      held.state.users = [MICHAEL, ADA];
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      function ClosableWindow() {
        const [open, setOpen] = useState(true);
        return (
          <>
            {open && <ManageUsers open onClose={() => {}} />}
            <button type="button" onClick={() => setOpen(false)}>
              Shut the window
            </button>
          </>
        );
      }
      render(
        <QueryClientProvider client={client}>
          <UndoWhatJustHappened>
            <ClosableWindow />
          </UndoWhatJustHappened>
        </QueryClientProvider>,
      );
      await screen.findByText('Michael');
      await screen.findByRole('button', { name: 'Actions for Michael' });
      const user = userEvent.setup();
      await add(user, 'Someone', 'ada@example.com');
      // Outside the modal, which takes pointer events from everything behind it.
      fireEvent.click(screen.getByRole('button', { name: 'Shut the window', hidden: true }));

      await answerNext();

      expect(await screen.findByText(/“Someone” was not added\. ada@example\.com is already how user-ada signs in/)).toBeInTheDocument();
    });

    it('brings the form back with what was typed and the server’s words when a rename is refused', async () => {
      const user = await show([MICHAEL, ADA]);
      await edit(user, 'Ada', { to: 'Ada Lovelace' });
      expect(names()).toContain('Ada Lovelace');

      await refuseNext(409, 'a name must leave something an account can be called');

      expect(await screen.findByRole('alert')).toHaveTextContent('a name must leave something an account can be called');
      expect(screen.getByLabelText('Name of Ada')).toHaveValue('Ada Lovelace');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(people()).toEqual(['Ada', 'Michael']);
    });

    it('says it in the undo bar instead when another row is open by then', async () => {
      const user = await show([MICHAEL, ADA]);
      await edit(user, 'Ada', { to: 'Ada Lovelace' });
      await chooseOnRow(user, 'Michael', 'Edit…');

      await refuseNext(409, 'a name must leave something an account can be called');

      expect(await screen.findByText(/“Ada” was not changed\. a name must leave something an account can be called/)).toBeInTheDocument();
      expect(screen.getByLabelText('Name of Michael')).toHaveValue('Michael');
    });

    it('brings the row back with the reason above the list when taking access away is refused', async () => {
      const user = await show([MICHAEL, ADA]);
      await chooseOnRow(user, 'Ada', 'Disable');
      expect(within(rowOf('Ada')).getByText('No access')).toBeVisible();

      await refuseNext(409, 'this is the only admin, so make somebody else an admin before taking this one’s access away');

      expect(within(rowOf('Ada')).queryByText('No access')).toBeNull();
      expect(await screen.findByRole('alert')).toHaveTextContent('this is the only admin');
    });

    it('brings the row back with the reason in the undo bar when deleting the last admin is refused', async () => {
      // Two admins as this page last read them; by the time Grace is deleted another admin has lost the role.
      const user = await show([MICHAEL, GRACE]);
      held.state.users = [{ ...MICHAEL, role: 'user' }, GRACE];
      await remove(user, 'Grace');
      expect(names()).toEqual(['Michael']);

      await refuseNext(409, 'this is the only admin, so make somebody else an admin before deleting this one');

      expect(people()).toEqual(['Grace', 'Michael']);
      expect(await screen.findByText(/“Grace” was not deleted\. this is the only admin, so make somebody else an admin before deleting this one/)).toBeInTheDocument();
    });
  });

  describe('a user change counts on the saving sign and guards leaving the page until it is answered', () => {
    it.each([
      { situation: 'somebody added', change: (user: ReturnType<typeof userEvent.setup>) => add(user, 'Anna', 'anna@example.com') },
      { situation: 'somebody renamed', change: (user: ReturnType<typeof userEvent.setup>) => edit(user, 'Ada', { to: 'Ada Lovelace' }) },
      { situation: 'somebody blocked', change: (user: ReturnType<typeof userEvent.setup>) => chooseOnRow(user, 'Ada', 'Disable') },
      { situation: 'somebody deleted', change: (user: ReturnType<typeof userEvent.setup>) => remove(user, 'Ada') },
    ])('shows the sign counting it and asks before leaving, then neither once it is answered: $situation', async ({ change }) => {
      const user = await show([MICHAEL, ADA]);
      expect(leave()).toBe(false);

      await change(user);

      expect(await screen.findByRole('status', { hidden: true, name: 'Saving 1 change…' })).toBeInTheDocument();
      expect(leave()).toBe(true);

      await answerNext();

      await waitFor(() => expect(screen.queryByRole('status', { hidden: true, name: 'Saving 1 change…' })).toBeNull());
      expect(leave()).toBe(false);
    });
  });
});
