import { afterEach, describe, expect, it, vi } from 'vitest';
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
  },
  {
    id: 'user-ada',
    name: 'Ada',
    email: 'ada@example.com',
    role: 'user',
    accountName: 'tenant-ada',
    hasSignedIn: false,
  },
];

const reads = vi.fn();
const adds = vi.fn();

vi.mock('../../../src/api/queries', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    registeredUsersQuery: { queryKey: ['registeredUsers'], queryFn: () => reads() },
    // The real hook, minus the cache invalidation it does on success - which
    // needs a client these cases do not have and proves nothing about the form.
    useAddUser: () => useMutation({ mutationFn: adds }),
  };
});

// Module-scope mocks, so what one case recorded must not reach the next.
afterEach(() => {
  reads.mockReset();
  adds.mockReset();
});

function drawn() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AdminPage />
    </QueryClientProvider>,
  );
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
      { situation: 'an admin who has signed in', person: PEOPLE[0]!, signedIn: 'yes' },
      { situation: 'an ordinary user who never has', person: PEOPLE[1]!, signedIn: 'not yet' },
    ])('draws $situation', async ({ person, signedIn }) => {
      reads.mockResolvedValue({ users: PEOPLE });
      drawn();

      const row = (await screen.findByText(person.name)).closest('tr')!;
      for (const said of [person.email!, person.role, person.accountName, signedIn]) {
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
