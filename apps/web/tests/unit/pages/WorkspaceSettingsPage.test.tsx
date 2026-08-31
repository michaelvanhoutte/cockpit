import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceSettingsPage } from '../../../src/pages/WorkspaceSettingsPage';
import { CommandRefused } from '../../../src/api/client';
import { useCommand } from '../../../src/api/queries';

/**
 * F1: what is under test is the page's own behaviour - what it asks for, and
 * what it does with an answer it does not like. Whether a name is actually
 * refused is the server's rule and is proved against a real database in
 * apps/api/tests/integration/http/workspace-management.test.ts; repeating it
 * here would prove nothing twice.
 */
vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      Promise.resolve({
        workspaces: [{ id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5' }],
      }),
  },
}));

const mockUseCommand = vi.mocked(useCommand);

/** The page, with a `useCommand` that answers however the case needs. */
function showPage(answer: { succeeds: boolean; error?: Error }) {
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (answer.succeeds) options?.onSuccess?.();
  });
  mockUseCommand.mockReturnValue({ mutate, isPending: false, error: answer.error ?? null } as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkspaceSettingsPage />
    </QueryClientProvider>,
  );
  return { mutate, box: screen.getByLabelText('Name of the new workspace') };
}

const newWorkspaceButton = () => screen.getByRole('button', { name: 'New workspace' });

describe('Workspace management', () => {
  describe('making a workspace asks for the name you typed and leaves the box ready for the next one', () => {
    it('asks for the name without the blanks around it, then empties the box', async () => {
      const user = userEvent.setup();
      const { mutate, box } = showPage({ succeeds: true });

      await user.type(box, '  Bookkeeping  ');
      await user.click(newWorkspaceButton());

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('create_workspace');
      expect(asked.payload.name).toBe('Bookkeeping');
      expect(box).toHaveValue('');
    });

    it('asks for nothing when the box holds only blanks', async () => {
      const user = userEvent.setup();
      const { mutate, box } = showPage({ succeeds: true });

      await user.type(box, '   ');
      await user.click(newWorkspaceButton());

      expect(mutate).not.toHaveBeenCalled();
    });
  });

  describe('a workspace that could not be made puts the screen back', () => {
    it.each([
      {
        situation: 'the name is already another workspace’s',
        error: new CommandRefused(409, 'a workspace called Work already exists'),
        says: 'a workspace called Work already exists',
      },
      {
        situation: 'the request never reached the server',
        error: new Error('Failed to fetch'),
        says: 'That did not reach the server. Try again.',
      },
    ])('$situation', async ({ error, says }) => {
      const user = userEvent.setup();
      const { box } = showPage({ succeeds: false, error });

      await user.type(box, 'Work');
      await user.click(newWorkspaceButton());

      expect(screen.getByRole('alert')).toHaveTextContent(says);
      // Still there to be corrected, rather than typed again from nothing.
      expect(box).toHaveValue('Work');
    });
  });

  describe('the workspaces you have are listed', () => {
    it('shows each one by name', async () => {
      showPage({ succeeds: true });

      expect(await screen.findByText('Work')).toBeVisible();
    });
  });
});
