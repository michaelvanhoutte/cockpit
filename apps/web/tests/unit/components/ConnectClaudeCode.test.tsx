import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectClaudeCode } from '../../../src/components/ConnectClaudeCode';
import { useConnectClaudeCode } from '../../../src/api/queries';

/**
 * F1: what the form sends and what it shows for a refusal - never what the
 * server stores, which apps/api/tests/integration/http/claude-code-connections.test.ts
 * owns against a real store, Claude faked at the network boundary. Opening
 * this form from a row's Edit… or from Add a connection's Connect is
 * ManageConnections.test.tsx's own.
 */

vi.mock('../../../src/api/queries', () => ({
  useConnectClaudeCode: vi.fn(),
}));

let mutate: ReturnType<typeof vi.fn>;

function showForm(outcome?: { accepted: true } | { accepted: false; message: string }, error: unknown = null) {
  mutate = vi.fn((_body, opts?: { onSuccess?: (o: unknown) => void }) => {
    if (outcome) opts?.onSuccess?.(outcome);
  });
  vi.mocked(useConnectClaudeCode).mockReturnValue({
    mutate,
    isPending: false,
    data: outcome,
    error,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useConnectClaudeCode>);
  const onClose = vi.fn();
  render(
    <ConnectClaudeCode open workspaceId="ws-work" onClose={onClose} returnFocusTo={null} />,
  );
  return { onClose };
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe('Connector management', () => {
  describe('connecting Claude Code fires the test session before anything is sent to be stored', () => {
    it('sends the trimmed routine URL and token typed into the form', async () => {
      showForm({ accepted: true });

      await userEvent.type(
        screen.getByRole('textbox', { name: 'Routine trigger URL' }),
        '  https://api.anthropic.com/v1/claude_code/routines/rt-1/fire  ',
      );
      await userEvent.type(screen.getByLabelText('Routine token'), '  a-token  ');
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

      expect(mutate).toHaveBeenCalledWith(
        {
          routineUrl: 'https://api.anthropic.com/v1/claude_code/routines/rt-1/fire',
          token: 'a-token',
        },
        expect.anything(),
      );
    });

    it('closes once Claude accepts', async () => {
      const { onClose } = showForm({ accepted: true });

      await userEvent.type(screen.getByRole('textbox', { name: 'Routine trigger URL' }), 'x');
      await userEvent.type(screen.getByLabelText('Routine token'), 'y');
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

      expect(onClose).toHaveBeenCalled();
    });

    it('stays open and says why, keeping what was typed, when Claude refuses', async () => {
      const { onClose } = showForm({
        accepted: false,
        message: 'The token is wrong or was revoked.',
      });

      await userEvent.type(screen.getByRole('textbox', { name: 'Routine trigger URL' }), 'x');
      await userEvent.type(screen.getByLabelText('Routine token'), 'y');
      await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The token is wrong or was revoked.',
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox', { name: 'Routine trigger URL' })).toHaveValue('x');
    });
  });

  describe('the form names this Cockpit’s domain as one the routine must be allowed to reach', () => {
    it('shows the domain the page is served from', () => {
      showForm();

      expect(screen.getByText(window.location.hostname, { selector: 'code' })).toBeInTheDocument();
    });
  });

  describe('the prompt is copied exactly, for pasting into the routine', () => {
    it('copies the one-line prompt shown', async () => {
      showForm();

      await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining('Cockpit Item'),
      );
    });
  });
});
