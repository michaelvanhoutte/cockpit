import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { workspaceListSchema } from '@cockpit/shared';
import { LoadFailure } from '../../../src/components/LoadFailure';
import {
  goToLogonPage,
  signInAgain,
  type Reach,
  type Surroundings,
} from '../../../src/api/loadFailure';

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
  signInAgain: vi.fn(),
  goToLogonPage: vi.fn(),
}));

const askedToSignIn = vi.mocked(signInAgain);
const sentToTheLogonPage = vi.mocked(goToLogonPage);

function world(definitelyOffline: boolean, reach: Reach): Surroundings {
  return {
    isDefinitelyOffline: () => definitelyOffline,
    reachServer: () => Promise.resolve(reach),
  };
}

/** A real shape mismatch, not a hand-made stand-in for one. */
function unreadableAnswer(): unknown {
  try {
    workspaceListSchema.parse({ workspaces: 'not a list' });
    throw new Error('expected the shape to be rejected');
  } catch (error) {
    return error;
  }
}

const refused = new TypeError('Failed to fetch');

beforeEach(() => {
  sessionStorage.clear();
});

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
        surroundings: world(false, 'healthy'),
        headline: "You're signed out",
      },
      {
        // Nothing of ours answered at all while the deployment says it is well,
        // so what swallowed the request is the gate in front of it.
        situation: 'the deployment is healthy and nothing of Cockpit answered',
        error: refused,
        surroundings: world(false, 'healthy'),
        headline: 'Your sign-in expired',
      },
      {
        situation: 'the deployment answers, but reports itself unwell',
        error: refused,
        surroundings: world(false, 'unhealthy'),
        headline: 'Cockpit is having trouble',
      },
      {
        situation: 'the read itself comes back as a failure',
        error: new Error('workspaces failed: 500'),
        surroundings: world(false, 'healthy'),
        headline: 'Cockpit is having trouble',
      },
      {
        situation: 'the answer is something this version cannot read',
        error: unreadableAnswer(),
        surroundings: world(false, 'healthy'),
        headline: 'Cockpit has been updated',
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
   * on screen, and going blank each time is what made "Sign in again" take
   * several attempts to hit.
   */
  describe('Cockpit keeps the reason it has named while it checks again', () => {
    it('leaves the way to sign in on screen, and working, when the read fails again', async () => {
      askedToSignIn.mockClear();
      const user = userEvent.setup();
      const { rerender } = render(
        <LoadFailure error={refused} surroundings={world(false, 'healthy')} />,
      );
      expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeInTheDocument();

      // The next refused read: the same failure, told again as a new error.
      rerender(
        <LoadFailure error={new TypeError('Failed to fetch')} surroundings={world(false, 'healthy')} />,
      );

      // Synchronously, in the instant the click has to land in.
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Sign in again' }));
      expect(askedToSignIn).toHaveBeenCalledTimes(1);
    });

    it('replaces the reason once the situation behind it has changed', async () => {
      const { rerender } = render(
        <LoadFailure error={refused} surroundings={world(false, 'healthy')} />,
      );
      expect(await screen.findByRole('heading', { name: 'Your sign-in expired' })).toBeInTheDocument();

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
  describe('being signed out of Cockpit offers Cockpit’s own logon page', () => {
    it('sends you there when you ask, and never by itself', async () => {
      sentToTheLogonPage.mockClear();
      askedToSignIn.mockClear();
      const user = userEvent.setup();

      // `canTakeOver`, so nothing of the person's is on screen - the one case
      // where the perimeter's sign-in *would* move by itself.
      render(
        <LoadFailure
          error={new Error('workspaces failed: 401')}
          surroundings={world(false, 'healthy')}
          canTakeOver
        />,
      );

      expect(await screen.findByRole('heading', { name: "You're signed out" })).toBeInTheDocument();
      expect(sentToTheLogonPage).not.toHaveBeenCalled();
      expect(askedToSignIn).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Sign in' }));
      expect(sentToTheLogonPage).toHaveBeenCalledTimes(1);
      // Never out through the perimeter: that is a different gate, and going
      // back through a perfectly happy one fixes nothing.
      expect(askedToSignIn).not.toHaveBeenCalled();
    });
  });

  describe('Cockpit only takes over the screen to sign you in when it has nothing to show', () => {
    it('goes straight to signing in, remembering the page, when nothing is on screen', async () => {
      askedToSignIn.mockClear();
      window.history.pushState({}, '', '/w/ws-work');

      render(<LoadFailure error={refused} surroundings={world(false, 'healthy')} canTakeOver />);

      expect(await screen.findByText('Signing you back in…')).toBeInTheDocument();
      // Waited for rather than asserted outright: saying so and doing it are
      // one render and the effect after it, and nothing makes the effect have
      // run by the moment the words are on screen. Asserted straight, this
      // passes on a quick machine and fails on a loaded one - which is what it
      // did, once, on CI under coverage while passing everywhere else.
      await waitFor(() => expect(askedToSignIn).toHaveBeenCalledWith('/w/ws-work'));
    });

    it('asks rather than moves, once a sign-in has already been tried and did not help', async () => {
      askedToSignIn.mockClear();
      // As if this tab had just come back from signing in and failed anyway.
      sessionStorage.setItem('cockpit-sign-in-attempted', '1');

      render(<LoadFailure error={refused} surroundings={world(false, 'healthy')} canTakeOver />);

      expect(await screen.findByRole('heading', { name: 'Your sign-in expired' })).toBeInTheDocument();
      expect(askedToSignIn).not.toHaveBeenCalled();
    });

    it('waits to be asked, leaving the page alone, when work is already on screen', async () => {
      askedToSignIn.mockClear();
      const user = userEvent.setup();

      render(<LoadFailure error={refused} surroundings={world(false, 'healthy')} />);

      expect(await screen.findByRole('heading', { name: 'Your sign-in expired' })).toBeInTheDocument();
      expect(askedToSignIn).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Sign in again' }));
      expect(askedToSignIn).toHaveBeenCalledTimes(1);
    });
  });
});
