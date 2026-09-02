import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSnapshot, fetchWorkspaces } from '../../../src/api/client';
import { signInAgain, signInAlreadyAttempted } from '../../../src/api/loadFailure';

/**
 * F1: `fetch` replaced at the edge, so what is under test is which read is
 * allowed to forget that this tab has already been sent through sign-in once.
 *
 * That distinction is the whole of the guard. Clearing it on the workspace list
 * looks equivalent and is not: Layout reads that list on every route, and it
 * keeps succeeding while a workspace snapshot is being refused, so the flag
 * would be cleared immediately before the guard is consulted and one sign-in
 * attempt would become an endless round trip through the gate.
 */
const workspace = {
  id: 'ws-work',
  tenantId: 'tenant',
  name: 'Work',
  color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea',
};

function answersWith(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

beforeEach(() => {
  sessionStorage.clear();
  // As if this tab had just been sent through sign-in.
  vi.stubGlobal('location', { ...window.location, assign: vi.fn() });
  signInAgain('/w/ws-work');
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('Sign-in', () => {
  describe('a sign-in already tried is only forgotten once a workspace is reached', () => {
    it('still remembers it after the workspace list comes back', async () => {
      answersWith({ workspaces: [workspace] });

      await fetchWorkspaces();

      expect(signInAlreadyAttempted()).toBe(true);
    });

    it('forgets it once the workspace itself comes back', async () => {
      answersWith({
        workspace,
        items: [],
        dashboards: [],
        panels: [],
        layouts: [],
        associations: [],
        generatedAt: '2026-08-31T10:00:00.000Z',
      });

      await fetchSnapshot('ws-work');

      expect(signInAlreadyAttempted()).toBe(false);
    });
  });
});
