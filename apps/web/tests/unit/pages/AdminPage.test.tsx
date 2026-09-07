import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RegisteredUser } from '@cockpit/shared';
import { AdminPage } from '../../../src/pages/AdminPage';

/**
 * F1: what the page draws from what it is given. That only an admin may read it
 * is the server's rule and is proved against a real register at
 * apps/api/tests/integration/http/user-management.test.ts; what is asked here
 * is the half that lives in the browser - that every fact the register holds
 * reaches the screen, and that being refused reads as a refusal rather than as
 * an empty page.
 */

const PEOPLE: RegisteredUser[] = [
  {
    id: 'user-michael',
    name: 'Michael',
    email: 'michael@example.com',
    role: 'admin',
    accountName: 'tenant-default',
    hasSignedIn: true,
    disabled: false,
  },
  {
    id: 'user-ada',
    name: 'Ada',
    email: 'ada@example.com',
    role: 'user',
    accountName: 'tenant-ada',
    hasSignedIn: false,
    disabled: false,
  },
];

const reads = vi.fn();
const adds = vi.fn();
const changes = vi.fn();
const access = vi.fn();
/** Who the page believes is asking, which one of the two role refusals is about. */
const iAm = vi.fn();

vi.mock('../../../src/api/queries', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    registeredUsersQuery: { queryKey: ['registeredUsers'], queryFn: () => reads() },
    meQuery: { queryKey: ['me'], queryFn: () => iAm() },
    // The real hooks, minus the cache invalidation they do on success - which
    // needs a client these cases do not have and proves nothing about the form.
    useAddUser: () => useMutation({ mutationFn: adds }),
    useChangeUser: () => useMutation({ mutationFn: changes }),
    useSetAccess: () => useMutation({ mutationFn: access }),
  };
});

// Signed in as the seeded admin unless a case says otherwise: React Query
// refuses an undefined answer, so a query left unanswered would fail in the
// background of every case that is not about who is asking.
beforeEach(() => {
  iAm.mockResolvedValue({ user: { id: 'user-michael', name: 'Michael', role: 'admin' } });
});

// Module-scope mocks, so what one case recorded must not reach the next.
afterEach(() => {
  reads.mockReset();
  adds.mockReset();
  changes.mockReset();
  access.mockReset();
  iAm.mockReset();
});

/**
 * The client is handed back, because one case has to make the list change
 * underneath a form that is already open - which is a re-read, not a redraw.
 */
function drawn() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminPage />
    </QueryClientProvider>,
  );
  return client;
}

describe('User management', () => {
  describe('adding somebody asks for a name and the address they sign in with', () => {
    async function fillIn({ name, email }: { name: string; email: string }) {
      const user = userEvent.setup();
      reads.mockResolvedValue({ users: PEOPLE });
      drawn();

      await user.type(await screen.findByLabelText('Name'), name);
      await user.type(screen.getByLabelText('Signs in with'), email);
      return user;
    }

    it('sends what was typed, trimmed', async () => {
      adds.mockResolvedValue({ user: PEOPLE[1]!, accountReady: true });
      const user = await fillIn({ name: '  Anna  ', email: '  anna@example.com  ' });

      await user.click(screen.getByRole('button', { name: 'Add' }));

      // The first argument only: react-query hands the mutation a context of
      // its own as a second, which is its business rather than this page's.
      await waitFor(() => expect(adds).toHaveBeenCalled());
      // The last call rather than the first: these mocks live at module scope
      // and nothing clears them, so indexing from the front would make this
      // depend on being the first case in the file that presses Add.
      expect(adds.mock.lastCall?.[0]).toEqual({ name: 'Anna', email: 'anna@example.com' });
    });

    /**
     * The refusal is the server's own words, because they name what is wrong -
     * which address is already somebody's - and the page has nothing better to
     * say than the reason.
     */
    it('shows the refusal and keeps what was typed', async () => {
      adds.mockRejectedValue(new Error('ada@example.com is already how user-ada signs in'));
      const user = await fillIn({ name: 'Someone', email: 'ada@example.com' });

      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/already how user-ada/);
      expect(screen.getByLabelText('Signs in with')).toHaveValue('ada@example.com');
    });

    it('clears the box once somebody is added', async () => {
      adds.mockResolvedValue({ user: PEOPLE[1]!, accountReady: true });
      const user = await fillIn({ name: 'Anna', email: 'anna@example.com' });

      await user.click(screen.getByRole('button', { name: 'Add' }));

      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue(''));
    });

    /**
     * The person is added either way, so the one thing the page must not do is
     * stay silent: an admin who is not told would find out when that person
     * could not get in.
     */
    it('says so when somebody was added but their account was not ready', async () => {
      adds.mockResolvedValue({ user: PEOPLE[1]!, accountReady: false });
      const user = await fillIn({ name: 'Anna', email: 'anna@example.com' });

      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(await screen.findByRole('status')).toHaveTextContent(/could not be prepared/);
    });

    it.each([
      { situation: 'nothing typed', name: '', email: '' },
      { situation: 'only a name', name: 'Anna', email: '' },
      { situation: 'only an address', name: '', email: 'anna@example.com' },
    ])('does not offer to add on $situation', async ({ name, email }) => {
      await fillIn({ name: name || '{Escape}', email: email || '{Escape}' });

      expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    });
  });

  describe('the list says everything the register knows about a person', () => {
    it.each([
      { situation: 'an admin who has signed in', person: PEOPLE[0]!, role: 'Admin', signedIn: 'yes' },
      {
        situation: 'an ordinary user who never has',
        person: PEOPLE[1]!,
        role: 'User',
        signedIn: 'not yet',
      },
    ])('draws $situation', async ({ person, role, signedIn }) => {
      reads.mockResolvedValue({ users: PEOPLE });
      drawn();

      const row = (await screen.findByText(person.name)).closest('tr')!;
      // The role in the words the screen uses, not the word the register holds:
      // the form beside it offers "Admin", and a page that said both would be
      // saying they might be different things.
      for (const said of [person.email!, role, person.accountName, signedIn]) {
        expect(within(row).getByText(said)).toBeVisible();
      }
    });

    /**
     * The register's address column is nullable, and a row without one is a
     * person nobody can sign in as - the register being the allowlist. Said on
     * the screen rather than left blank, because an empty cell reads as a page
     * that failed rather than as a fact about somebody.
     */
    it('says so when somebody has no address to sign in with', async () => {
      reads.mockResolvedValue({ users: [{ ...PEOPLE[1]!, email: null }] });
      drawn();

      expect(await screen.findByText(/no address/i)).toBeVisible();
    });
  });

  describe('a person’s row opens a form carrying their name and their role', () => {
    /**
     * Opened from the row's own menu, which is the way a keyboard has - the
     * double-click the row also answers is `wasOnTheRow`'s, proved where it
     * lives (components/RowForm.tsx) and used by every other row in the app.
     */
    async function openFormOn(
      person: RegisteredUser,
      { people = PEOPLE, asWho = PEOPLE[0]! }: { people?: RegisteredUser[]; asWho?: RegisteredUser } = {},
    ) {
      const user = userEvent.setup();
      reads.mockResolvedValue({ users: people });
      iAm.mockResolvedValue({ user: { id: asWho.id, name: asWho.name, role: asWho.role } });
      const client = drawn();

      await user.click(await screen.findByRole('button', { name: `Actions for ${person.name}` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
      return Object.assign(user, { client });
    }

    it('opens on the name and role that person already has', async () => {
      await openFormOn(PEOPLE[1]!);

      expect(screen.getByLabelText(`Name of ${PEOPLE[1]!.name}`)).toHaveValue('Ada');
      expect(screen.getByRole('radio', { name: /^User/ })).toBeChecked();
    });

    it('sends the name and the role, trimmed', async () => {
      changes.mockResolvedValue({ user: PEOPLE[1]! });
      const user = await openFormOn(PEOPLE[1]!);

      const box = screen.getByLabelText(`Name of ${PEOPLE[1]!.name}`);
      await user.clear(box);
      await user.type(box, '  Ada Lovelace  ');
      await user.click(screen.getByRole('radio', { name: /^Admin/ }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(changes).toHaveBeenCalled());
      expect(changes.mock.lastCall?.[0]).toEqual({
        userId: 'user-ada',
        name: 'Ada Lovelace',
        role: 'admin',
      });
    });

    it('closes once the change is made', async () => {
      changes.mockResolvedValue({ user: PEOPLE[1]! });
      const user = await openFormOn(PEOPLE[1]!);

      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    /**
     * The server's own words, because they name which rule stopped it - and the
     * form stays open holding what was typed, which is the one case where
     * closing would throw work away.
     */
    it('shows the refusal and keeps the form open', async () => {
      changes.mockRejectedValue(new Error('you cannot take your own admin away'));
      const user = await openFormOn(PEOPLE[1]!);

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/your own admin/);
      expect(screen.getByRole('dialog')).toBeVisible();
    });

    it('does not offer to save a name of only spaces', async () => {
      const user = await openFormOn(PEOPLE[1]!);

      const box = screen.getByLabelText(`Name of ${PEOPLE[1]!.name}`);
      await user.clear(box);
      await user.type(box, '   ');

      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    /**
     * Present and unavailable with the reason on it, rather than gone: an
     * entry that vanishes leaves an admin looking for a choice that was there a
     * moment ago. Both reasons are drawn, because they are said differently -
     * "another admin can do it for you" is false when there is no other admin.
     */
    it.each([
      {
        situation: 'the person is the only admin',
        people: PEOPLE,
        asWho: PEOPLE[0]!,
        says: /only admin/i,
      },
      {
        situation: 'the person is the admin who is asking, and not the only one',
        people: [PEOPLE[0]!, { ...PEOPLE[1]!, role: 'admin' as const }],
        asWho: PEOPLE[0]!,
        says: /your own admin/i,
      },
    ])('says why the role cannot be given up when $situation', async ({ people, asWho, says }) => {
      await openFormOn(asWho, { people, asWho });

      const ordinary = screen.getByRole('radio', { name: /^User/ });
      expect(ordinary).toBeDisabled();
      expect(ordinary.closest('label')).toHaveTextContent(says);
    });

    /**
     * Two admins, and the one who is not looking wins the halves nobody
     * touched: a form that sent what the row held when it opened would put an
     * ordinary user back over somebody else's promotion, and neither refusal
     * would fire - the change is about a third person and there are admins
     * left - so nobody would be told.
     */
    it.each([
      {
        situation: 'the role, when the radio was never touched',
        elsewhere: { role: 'admin' as const },
        sends: { role: 'admin' },
      },
      {
        situation: 'the name, when the box was never typed in',
        elsewhere: { name: 'Ada Lovelace' },
        sends: { name: 'Ada Lovelace' },
      },
    ])('sends $situation as the row now holds it', async ({ elsewhere, sends }) => {
      changes.mockResolvedValue({ user: PEOPLE[1]! });
      const user = await openFormOn(PEOPLE[1]!);

      // Somebody else changes her while this form sits open, and the list is
      // re-read - which is what the page does on its own.
      reads.mockResolvedValue({ users: [PEOPLE[0]!, { ...PEOPLE[1]!, ...elsewhere }] });
      await user.client.invalidateQueries({ queryKey: ['registeredUsers'] });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled(),
      );

      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(changes).toHaveBeenCalled());
      expect(changes.mock.lastCall?.[0]).toMatchObject(sends);
    });

    it('offers the role to an admin who is neither the asker nor the last one', async () => {
      const ada = { ...PEOPLE[1]!, role: 'admin' as const };

      await openFormOn(ada, { people: [PEOPLE[0]!, ada] });

      expect(screen.getByRole('radio', { name: /^User/ })).toBeEnabled();
    });
  });

  describe('a person’s access is taken away and given back from their row', () => {
    async function menuOn(person: RegisteredUser, people: RegisteredUser[] = PEOPLE) {
      const user = userEvent.setup();
      reads.mockResolvedValue({ users: people });
      drawn();

      await user.click(await screen.findByRole('button', { name: `Actions for ${person.name}` }));
      return user;
    }

    it.each([
      { situation: 'somebody who has access', person: PEOPLE[1]!, entry: 'Disable', sends: true },
      {
        situation: 'somebody who has none',
        person: { ...PEOPLE[1]!, disabled: true },
        entry: 'Enable',
        sends: false,
      },
    ])('offers $entry on $situation, and sends that', async ({ person, entry, sends }) => {
      access.mockResolvedValue({ user: person });
      const user = await menuOn(person, [PEOPLE[0]!, person]);

      await user.click(await screen.findByRole('menuitem', { name: entry }));

      await waitFor(() => expect(access).toHaveBeenCalled());
      expect(access.mock.lastCall?.[0]).toEqual({ userId: person.id, disabled: sends });
    });

    /**
     * The row stays where it was and says what happened to it: somebody
     * disabled is still somebody this Cockpit holds, and an admin looking for
     * them would not find them in a list they had dropped out of.
     */
    it('marks the row of somebody with no access', async () => {
      const gone = { ...PEOPLE[1]!, disabled: true };
      reads.mockResolvedValue({ users: [PEOPLE[0]!, gone] });
      drawn();

      const row = (await screen.findByText(gone.name)).closest('tr')!;
      expect(within(row).getByText(/no access/i)).toBeVisible();
    });

    /**
     * The same rule the role choice is refused by, asked of access - and drawn
     * the same way, present and unavailable with the reason on it.
     */
    it.each([
      {
        situation: 'the only admin',
        people: PEOPLE,
        says: /only admin/i,
      },
      {
        situation: 'the admin who is asking, and not the only one',
        people: [PEOPLE[0]!, { ...PEOPLE[1]!, role: 'admin' as const }],
        says: /your own access/i,
      },
    ])('will not take the access of $situation', async ({ people, says }) => {
      const user = await menuOn(PEOPLE[0]!, people);

      const entry = await screen.findByRole('menuitem', { name: /Disable/ });
      expect(entry).toHaveAccessibleName(says);

      await user.click(entry);
      expect(access).not.toHaveBeenCalled();
    });

    /**
     * A menu entry has nowhere of its own to be refused in - the menu is shut
     * by the time the server answers - so without this a refused Disable is a
     * row that simply did not change, which reads exactly like a slow one. The
     * page can be got past its own greyed-out entry: `me` may not have settled,
     * and the server refuses either way.
     */
    it('says what the server refused, rather than leaving the row unchanged in silence', async () => {
      access.mockRejectedValue(new Error('you cannot take your own access away'));
      const user = await menuOn(PEOPLE[1]!);

      await user.click(await screen.findByRole('menuitem', { name: 'Disable' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/your own access/);
    });

    it('offers it on an admin who is neither the asker nor the last one', async () => {
      const ada = { ...PEOPLE[1]!, role: 'admin' as const };

      await menuOn(ada, [PEOPLE[0]!, ada]);

      expect(await screen.findByRole('menuitem', { name: 'Disable' })).toBeVisible();
    });
  });

  describe('being refused the admin page says so rather than showing nothing', () => {
    /**
     * The one thing this page must not do with a refusal is draw an empty
     * table, which reads as "nobody can sign in to this Cockpit" - the most
     * alarming possible answer to the question the page exists to ask.
     */
    it('says it is for admins when the server refuses', async () => {
      reads.mockRejectedValue(new Error('users failed: 403'));
      drawn();

      expect(await screen.findByText(/for admins/i)).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
    });

    /**
     * Everything that is not a refusal says a read failed, because the other
     * sentence would be a false and alarming statement about the person
     * reading it: an admin offline would be told they are not an admin.
     */
    it.each([
      { situation: 'the request never arrived', failure: new TypeError('Failed to fetch') },
      { situation: 'the server broke', failure: new Error('users failed: 500') },
    ])('says a read failed when $situation', async ({ failure }) => {
      reads.mockRejectedValue(failure);
      drawn();

      expect(await screen.findByText(/could not be read/i)).toBeVisible();
      expect(screen.queryByText(/for admins/i)).toBeNull();
    });
  });
});
