import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

vi.mock('../../../src/api/queries', () => ({
  registeredUsersQuery: { queryKey: ['registeredUsers'], queryFn: () => reads() },
}));

function drawn() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AdminPage />
    </QueryClientProvider>,
  );
}

describe('User management', () => {
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
