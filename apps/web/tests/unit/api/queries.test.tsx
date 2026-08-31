import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, useQuery } from '@tanstack/react-query';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { snapshotQuery } from '../../../src/api/queries';
import { fetchSnapshot } from '../../../src/api/client';

/**
 * F1, and deliberately not a browser test: whether a screen refreshes itself
 * when you come back to it is decided by the query options this app declares,
 * and the library exposes the "you are back" signal directly. Driving that
 * signal is the real code path. Going through a browser instead means
 * emulating tab visibility, which three separate attempts showed cannot be
 * produced reliably from a test harness — two of them returned a confident
 * null result for a transition that never actually happened.
 *
 * Only the read is replaced, at the edge. The query's own options — including
 * the staleness window this rule is about — are the app's real ones.
 */
vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
}));

const reads = vi.mocked(fetchSnapshot);

const snapshot: WorkspaceSnapshot = {
  workspace: { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5' },
  items: [],
  associations: [],
  generatedAt: '2026-08-31T10:00:00.000Z',
};

function WorkspaceScreen() {
  const { data } = useQuery(snapshotQuery('ws-work'));
  return <p>{data ? 'showing the workspace' : 'still loading'}</p>;
}

async function openTheScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkspaceScreen />
    </QueryClientProvider>,
  );
  await screen.findByText('showing the workspace');
}

beforeEach(() => {
  reads.mockReset();
  reads.mockResolvedValue(snapshot);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  // The manual focus state outlives the test that set it.
  focusManager.setFocused(undefined);
});

describe('Offline', () => {
  describe('coming back to Cockpit brings a screen that has gone stale up to date', () => {
    it('reads the workspace again when you return to it after it has aged', async () => {
      await openTheScreen();
      expect(reads).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_000);
      focusManager.setFocused(true);

      await waitFor(() => expect(reads).toHaveBeenCalledTimes(2));
    });

    it('leaves a screen that is still fresh alone', async () => {
      await openTheScreen();

      await vi.advanceTimersByTimeAsync(5_000);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(reads).toHaveBeenCalledTimes(1);
    });
  });
});
