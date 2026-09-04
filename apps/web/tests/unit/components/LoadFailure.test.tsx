import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoadFailure } from '../../../src/components/LoadFailure';
import { goToLogonPage, type Reach, type Surroundings } from '../../../src/api/loadFailure';

/**
 * F1: every branch here is a decision over facts about the world, and all of
 * them are injected, so nothing about this needs a network or a browser. The
 * one thing this level cannot prove — that the component is reached at all when
 * a read fails in a real browser, through a real service worker — is the single
 * F3 walk in tests/e2e/load-failure.test.ts.
 *
 * Only the navigation is replaced, at the edge; `diagnose` runs for real, so
 * these cases exercise the actual classification rather than a mock of it.
 */
vi.mock('../../../src/api/loadFailure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/loadFailure')>()),
  goToLogonPage: vi.fn(),
}));

const sentToTheLogonPage = vi.mocked(goToLogonPage);

function world(definitelyOffline: boolean, reach: Reach): Surroundings {
  return {
    isDefinitelyOffline: () => definitelyOffline,
    reachServer: () => Promise.resolve(reach),
  };
}

const refused = new TypeError('Failed to fetch');

describe('Offline', () => {
  describe('Cockpit says which of the reasons it could not load your work', () => {
    const situations = [
      {
        situation: 'the device knows it has no connection',
        error: refused,
        surroundings: world(true, 'unreachable'),
        headline: "Cockpit can't be reached",
      },
      {
        // The one the browser gets wrong: a page reloaded while already offline
        // insists it is online, so nothing may be concluded from that claim.
        situation: 'nothing answers, however online the browser claims to be',
        error: refused,
        surroundings: world(false, 'unreachable'),
        headline: "Cockpit can't be reached",
      },
      {
        // Cockpit's own gate: it answered, in Cockpit's own format, and what it
        // said was that this browser is nobody.
        situation: 'Cockpit itself says this browser is not signed in',
        error: new Error('workspaces failed: 401'),
        surroundings: world(false, 'reachable'),
        headline: "You're signed out",
      },
      {
        // Something answered while our own request got nowhere, so whatever
        // swallowed it sits between this browser and the Worker. Cockpit cannot
        // say what, and trying again is the only move it can offer.
        situation: 'something answers and nothing of Cockpit does',
        error: refused,
        surroundings: world(false, 'reachable'),
        headline: 'Cockpit is having trouble',
      },
      {
        // A refusal that is not Cockpit's own 401 is somebody else's, and this
        // app cannot say whose.
        situation: 'the read is refused by something that is not Cockpit',
        error: new Error('workspaces failed: 403'),
        surroundings: world(false, 'reachable'),
        headline: 'Cockpit is having trouble',
      },
      {
        situation: 'the read itself comes back as a failure',
        error: new Error('workspaces failed: 500'),
        surroundings: world(false, 'reachable'),
        headline: 'Cockpit is having trouble',
      },
    ];

    it.each(situations)('$situation', async ({ error, surroundings, headline }) => {
      render(<LoadFailure error={error} surroundings={surroundings} />);

      expect(await screen.findByRole('heading', { name: headline })).toBeInTheDocument();
    });
  });

  describe('Cockpit names no reason until it has worked out which one it is', () => {
    it('says it is still working it out while the check is unfinished', () => {
      const neverAnswers: Surroundings = {
        isDefinitelyOffline: () => false,
        reachServer: () => new Promise<Reach>(() => {}),
      };

      render(<LoadFailure error={refused} surroundings={neverAnswers} />);

      expect(screen.getByText('Working out what went wrong…')).toBeInTheDocument();
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });
  });

  /**
   * A failure that persists is *re-*read: the workspace is re-read on the push
   * stream's backoff, and each refusal arrives as its own new error object. So
   * this is not an edge case — it is what the screen does for as long as it is
   * on screen, and going blank each time is what made the way out take several
   * attempts to hit.
   */
  describe('Cockpit keeps the reason it has named while it checks again', () => {
    it('leaves the way out on screen, and working, when the read fails again', async () => {
      const retry = vi.fn();
      const user = userEvent.setup();
      const { rerender } = render(
        <LoadFailure error={refused} surroundings={world(false, 'reachable')} onRetry={retry} />,
      );
      expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();

      // The next refused read: the same failure, told again as a new error.
      rerender(
        <LoadFailure
          error={new TypeError('Failed to fetch')}
          surroundings={world(false, 'reachable')}
          onRetry={retry}
        />,
      );

      // Synchronously, in the instant the click has to land in.
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it('replaces the reason once the situation behind it has changed', async () => {
      const { rerender } = render(
        <LoadFailure error={refused} surroundings={world(false, 'reachable')} />,
      );
      expect(
        await screen.findByRole('heading', { name: 'Cockpit is having trouble' }),
      ).toBeInTheDocument();

      // The connection has since gone, so the same failure now has a different
      // reason and the screen has to follow it rather than keep the old one.
      rerender(<LoadFailure error={refused} surroundings={world(true, 'unreachable')} />);

      expect(
        await screen.findByRole('heading', { name: "Cockpit can't be reached" }),
      ).toBeInTheDocument();
    });
  });
});

describe('Sign-in', () => {
  describe('being signed out offers the logon page, and never goes there by itself', () => {
    it('waits to be asked, leaving the page alone until it is', async () => {
      sentToTheLogonPage.mockClear();
      const user = userEvent.setup();

      render(
        <LoadFailure
          error={new Error('workspaces failed: 401')}
          surroundings={world(false, 'reachable')}
        />,
      );

      expect(await screen.findByRole('heading', { name: "You're signed out" })).toBeInTheDocument();
      // Reading what you already have is a promise the app keeps (functional
      // definition, "Offline / local-first behavior"), so nothing here may
      // navigate off the page on its own.
      expect(sentToTheLogonPage).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(sentToTheLogonPage).toHaveBeenCalledTimes(1);
    });
  });
});
