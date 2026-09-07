import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LogonPage } from '../../../src/pages/LogonPage';

/**
 * F1: the sentence a refused sign-in reads as. Which refusal the server gives
 * is proved against a real register at
 * apps/api/tests/integration/http/sign-in.test.ts; what only the browser can
 * show is that the two arrive as different sentences, and that a third thing in
 * the address does not put words in anybody's mouth.
 */

vi.mock('../../../src/session/forget', () => ({ forgetEverything: () => Promise.resolve() }));

const wasAt = window.location.href;
afterEach(() => window.history.replaceState({}, '', wasAt));

function drawnAt(query: string) {
  window.history.replaceState({}, '', `/signin${query}`);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LogonPage />
    </QueryClientProvider>,
  );
}

describe('Sign-in', () => {
  describe('a refused sign-in says what the person can do about it', () => {
    /**
     * "Access removed" is deliberately not the unknown-account sentence ("Take
     * somebody's access away without taking their work", issue 233): the person
     * it happens to is a colleague, and telling them this Cockpit does not know
     * them would send them looking for a sign-in problem that is not theirs.
     */
    it.each([
      {
        situation: 'the account is not one this Cockpit knows',
        query: '?refused=unknown-account',
        says: /not one this Cockpit knows/,
      },
      {
        situation: 'their access was taken away',
        query: '?refused=access-removed',
        says: /access to this Cockpit was removed/,
      },
      {
        situation: 'something else went wrong',
        query: '?refused=something-else',
        says: /did not work/,
      },
    ])('says so when $situation', ({ query, says }) => {
      drawnAt(query);

      expect(screen.getByRole('alert')).toHaveTextContent(says);
    });

    /**
     * Somebody whose access was removed still has everything they had, so the
     * sentence says so: the one thing they must not conclude is that their work
     * went with it.
     */
    it('tells somebody whose access was removed that their work is still there', () => {
      drawnAt('?refused=access-removed');

      expect(screen.getByRole('alert')).toHaveTextContent(/still here/);
    });

    it('says nothing at all when nothing was refused', () => {
      drawnAt('');

      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
