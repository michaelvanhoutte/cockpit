import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FIRST_WORKSPACE_NAME } from '@cockpit/shared';
import { WelcomePage } from '../../../src/pages/WelcomePage';
import { WHAT_A_WORKSPACE_IS } from '../../../src/whatThingsAre';

/**
 * F1, for the half a browser walk cannot get at.
 *
 * **A walk does reach it, and only one can.** The question is asked while an
 * account still holds the single workspace it arrived with, and neither seeded
 * account stays that way - the walks about managing workspaces make them in
 * Michael's, and tests/e2e/sign-in.test.ts makes one in Ada's and says out loud
 * that it cannot take it back. The one untouched account this tier ever sees is
 * the person *added while it runs*, so that is where the walk lives:
 * tests/e2e/user-management.test.ts signs her in and finds the question.
 *
 * What that walk cannot do is try the answers - it is about somebody being able
 * to get in at all, and it has an account to leave usable behind it. So naming
 * the workspace, skipping, and leaving the box empty are here; and *which*
 * state the app opens on the question in is decided over a list and one
 * remembered fact, proved without a browser (tests/unit/welcoming.test.ts).
 */

const mutate = vi.fn((_args: unknown, options?: { onSuccess?: () => void }) => {
  options?.onSuccess?.();
});
const wentTo: { calls: unknown[] } = { calls: [] };
const remembered = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => (to: unknown) => {
    wentTo.calls.push(to);
    return Promise.resolve();
  },
}));

vi.mock('../../../src/welcoming', () => ({ rememberWelcomed: () => remembered() }));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate, isPending: false, error: null, reset: () => undefined }),
  refusalFrom: () => null,
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      Promise.resolve({
        workspaces: [{ id: 'ws-1', tenantId: 'tenant', name: FIRST_WORKSPACE_NAME }],
      }),
  },
}));

function theQuestion() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WelcomePage />
    </QueryClientProvider>,
  );
  return { user };
}

/** Where the app opens on afterwards, whichever way the question was answered. */
const INTO_THE_WORKSPACE = { to: '/w/$workspaceId', params: { workspaceId: 'ws-1' } };

beforeEach(() => {
  mutate.mockClear();
  remembered.mockClear();
  wentTo.calls = [];
});

describe('Onboarding', () => {
  describe('the question a new account is asked says what a workspace is', () => {
    it('asks it with the sentence the control that makes one also says', async () => {
      theQuestion();

      expect(
        await screen.findByRole('heading', { name: 'What are you going to use Cockpit for?' }),
      ).toBeVisible();
      // Against the sentence and against it saying anything at all.
      expect(WHAT_A_WORKSPACE_IS).not.toBe('');
      expect(screen.getByText(WHAT_A_WORKSPACE_IS, { exact: false })).toBeVisible();
    });
  });

  /**
   * **It renames rather than makes.** The workspace is already there - an
   * account arrives holding one - so every way out of this screen leaves an app
   * that works, and none of them can leave a half-built account behind.
   */
  describe('naming the workspace from the question is the same rename as anywhere else', () => {
    it('renames the workspace it was already holding, and opens it', async () => {
      const { user } = theQuestion();

      await user.type(await screen.findByLabelText('Name of the workspace'), '  Consulting  ');
      await user.click(screen.getByRole('button', { name: 'Open Cockpit' }));

      const [asked] = mutate.mock.calls[0]! as [{ name: string; payload: { name: string } }];
      expect(asked.name).toBe('rename_workspace');
      // Without the blanks around it, like every other name the app takes.
      expect(asked.payload.name).toBe('Consulting');
      await waitFor(() => expect(wentTo.calls).toEqual([INTO_THE_WORKSPACE]));
    });

    it.each([
      { situation: 'Skip is pressed', answer: 'Skip' },
      { situation: 'the box is left empty', answer: 'Open Cockpit' },
    ])('changes nothing and opens the app when $situation', async ({ answer }) => {
      const { user } = theQuestion();

      await screen.findByLabelText('Name of the workspace');
      await user.click(screen.getByRole('button', { name: answer }));

      expect(mutate).not.toHaveBeenCalled();
      await waitFor(() => expect(wentTo.calls).toEqual([INTO_THE_WORKSPACE]));
    });

    it('is not asked again, however it was answered', async () => {
      // Both ways out remember it: naming the workspace and walking past it are
      // the same amount of having seen this.
      const { user } = theQuestion();

      await screen.findByLabelText('Name of the workspace');
      await user.click(screen.getByRole('button', { name: 'Skip' }));

      expect(remembered).toHaveBeenCalledTimes(1);
    });
  });
});
