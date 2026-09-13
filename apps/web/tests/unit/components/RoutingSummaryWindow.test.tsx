import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RoutingSummaryWindow } from '../../../src/components/RoutingSummaryWindow';
import { useSendCommand } from '../../../src/api/queries';

vi.mock('../../../src/api/loadFailure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/loadFailure')>()),
  diagnose: () => Promise.resolve('offline' as const),
}));

/**
 * F1: what this screen draws, and nothing about what the server stores.
 * Whether a correction is really kept is proved against a real store in
 * apps/api/tests/integration/http/routing-summary-correction.test.ts, and
 * that it survives a close and a reopen for a person is the one browser walk
 * in tests/e2e/routing-summary.test.ts.
 *
 * **Here because a paragraph was taken off this screen** ("Drop the nightly
 * filing summary, keep the sentence you wrote", issue 392). The generated
 * summary it drew was rewritten nightly and read back by nothing; the columns
 * behind it are still on the row and still hold what they held, so "it is not
 * written any more" is not the same claim as "it is not drawn any more" and
 * the second is what a person sees.
 */

/** Whatever the snapshot answers with for this Workspace. */
const held = vi.hoisted(() => ({ routingSummary: null as unknown }));

vi.mock('../../../src/api/queries', () => ({
  useSendCommand: vi.fn(),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ routingSummary: held.routingSummary }),
  }),
}));

function showWindow() {
  vi.mocked(useSendCommand).mockReturnValue(vi.fn().mockResolvedValue(undefined));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RoutingSummaryWindow workspaceId="ws-work" open onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('What Cockpit has learned', () => {
  describe('the workspace settings screen shows the sentence you wrote and nothing Cockpit generated', () => {
    /**
     * **Every case carries a sentence, so there is something to wait on.** The
     * box is drawn empty and filled once the read lands, so asserting on a
     * window that has not read anything yet would pass before the answer under
     * test ever reached the component - and the absences below it would pass
     * for the same empty reason.
     */
    it.each([
      {
        situation: 'a workspace with a sentence written for it',
        answer: {
          correction: 'Sign-off questions go to Laurens.',
          correctionSetAt: '2026-09-12T09:00:00.000Z',
        },
      },
      {
        /**
         * The row still carries what the nightly job left on it. The snapshot
         * stopped reading those columns, so a stray `summary` can only reach
         * this component from an older client cache or a server not yet
         * deployed - and either way it must not be drawn.
         */
        situation: 'a workspace whose row still holds an old generated summary',
        answer: {
          correction: 'Sign-off questions go to Laurens.',
          correctionSetAt: '2026-09-12T09:00:00.000Z',
          summary: 'You file compliance questions to Compliance questions.',
          summaryGeneratedAt: '2026-09-09T03:00:00.000Z',
        },
      },
    ])('draws the box and nothing above it, for $situation', async ({ answer }) => {
      held.routingSummary = answer;

      showWindow();

      const box = await screen.findByLabelText('Your correction');
      await waitFor(() => expect(box).toHaveValue('Sign-off questions go to Laurens.'));
      // Nothing generated is drawn, whatever the answer carried: neither the
      // old empty-state sentence nor a summary sitting on the row.
      expect(screen.queryByText(/Not enough has been filed here yet/)).toBeNull();
      expect(screen.queryByText(/Filing pattern/)).toBeNull();
      expect(
        screen.queryByText(/You file compliance questions to Compliance questions\./),
      ).toBeNull();
    });
  });
});
