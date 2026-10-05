import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LogonPage } from '../../../src/pages/LogonPage';
import { creditLine } from '../../../src/credit';

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
     * it happens to is a colleague, and telling them their Google account
     * cannot sign in here would send them looking for a sign-in problem that is
     * not theirs.
     */
    it.each([
      {
        situation: 'the Google account cannot sign in here',
        query: '?refused=unknown-account',
        says: /cannot sign in to this Cockpit/,
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

  describe('the page credits Conselit under its card', () => {
    it('links to Conselit in a new tab', () => {
      drawnAt('');

      const credit = screen.getByRole('link', { name: creditLine() });
      expect(credit).toHaveAttribute('href', 'https://www.conselit.be');
      expect(credit).toHaveAttribute('target', '_blank');
      expect(credit.getAttribute('rel')).toContain('noopener');
    });
  });

  describe('the guest link says where the person came from', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
      {
        situation: 'the person followed a link from another site',
        referrer: 'https://conselit.com/a?b=1',
        href: '/v1/sign-in/guest?referrer=https%3A%2F%2Fconselit.com%2Fa%3Fb%3D1',
      },
      { situation: 'the browser reported no referrer', referrer: '', href: '/v1/sign-in/guest' },
    ])('is drawn right when $situation', ({ referrer, href }) => {
      vi.spyOn(document, 'referrer', 'get').mockReturnValue(referrer);
      drawnAt('');

      expect(screen.getByRole('link', { name: 'Continue as guest' })).toHaveAttribute('href', href);
    });
  });
});
