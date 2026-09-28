import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { AGENT_COLORS } from '@cockpit/shared';
import type { Agent, AgentRun } from '@cockpit/shared';
import { AGENT_BEING_DRAGGED, agentInTheAir } from '../../../src/agentInTheAir';
import { AgentDock } from '../../../src/components/AgentDock';
import { CommandRefused } from '../../../src/api/client';
import { useCommand, useSendCommand, type CommandArgs } from '../../../src/api/queries';

/**
 * F1: what is under test is the dock's own behaviour - what it draws, what it
 * sends, what a right-click or the dock's own "…" offers. Whether a name is
 * actually refused, whether hiding really is per dashboard, and whether Ask
 * Claude's own gates hold are the server's rules, proved against a real store
 * in apps/api/tests/integration/http/agents.test.ts. The rule for which
 * tiles a given state draws is pure and is
 * packages/shared/tests/unit/domain/agent.test.ts's own.
 */

vi.mock('../../../src/api/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/queries')>()),
  useCommand: vi.fn(),
  useSendCommand: vi.fn(),
}));

const mockUseCommand = vi.mocked(useCommand);
const mockUseSendCommand = vi.mocked(useSendCommand);

const SCOPE_IT: Agent = {
  id: 'agent-scope',
  tenantId: 'tenant',
  name: 'Scope it',
  color: AGENT_COLORS[0]!,
  engine: 'claude-code',
  message: '/scoping {title}',
  asksForPrompt: false,
  startsInProgress: true,
  position: 0,
  createdAt: '2026-09-28T10:00:00.000Z',
};
const SHIP_IT: Agent = { ...SCOPE_IT, id: 'agent-ship', name: 'Ship it', color: AGENT_COLORS[1]!, position: 1 };

function renderDock(
  overrides: Partial<React.ComponentProps<typeof AgentDock>> = {},
  answer: { succeeds: boolean; error?: Error; refusesTheForm?: Error } = { succeeds: true },
) {
  const mutate = vi.fn(
    (_args: CommandArgs, options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => {
      if (answer.succeeds) options?.onSuccess?.();
      else options?.onError?.(answer.error ?? new Error('refused'));
    },
  );
  const sent = vi.fn((_args: CommandArgs) =>
    answer.refusesTheForm
      ? Promise.reject(answer.refusesTheForm)
      : Promise.resolve({ ok: true, applied: true }),
  );
  mockUseSendCommand.mockReturnValue(sent as never);
  mockUseCommand.mockReturnValue({
    mutate,
    isPending: false,
    error: answer.error ?? null,
    variables: undefined,
    reset: vi.fn(),
  } as never);

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AgentDock
        workspaceId="ws-work"
        dashboardId="dash-1"
        agents={[SCOPE_IT, SHIP_IT]}
        hiddenAgents={[]}
        hasClaudeCodeConnection={false}
        askClaudeEnabled={true}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { mutate, sent };
}

describe('Agents', () => {
  describe('a dashboard shows every agent except those hidden on it', () => {
    it('draws a tile for every agent this dashboard does not hide', () => {
      renderDock();

      expect(screen.getByRole('button', { name: 'Scope it' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ship it' })).toBeInTheDocument();
    });

    it('leaves out an agent hidden on this dashboard', () => {
      renderDock({ hiddenAgents: [{ dashboardId: 'dash-1', agentId: 'agent-ship' }] });

      expect(screen.queryByRole('button', { name: 'Ship it' })).toBeNull();
    });

    it('draws Ask Claude only where the workspace is connected and it is enabled', () => {
      renderDock({ hasClaudeCodeConnection: true, askClaudeEnabled: true });

      expect(screen.getByText('Ask Claude')).toBeInTheDocument();
    });

    it('leaves out Ask Claude where the workspace holds no connection', () => {
      renderDock({ hasClaudeCodeConnection: false, askClaudeEnabled: true });

      expect(screen.queryByText('Ask Claude')).toBeNull();
    });
  });

  describe('agents are made, changed and deleted from the dock', () => {
    it('sends a create for a new agent', async () => {
      const user = userEvent.setup();
      const { sent } = renderDock({ agents: [] });

      await user.click(screen.getByRole('button', { name: '+ New agent' }));
      await user.type(screen.getByRole('textbox', { name: 'Name of the agent' }), 'Review it');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'create_agent',
          payload: expect.objectContaining({ name: 'Review it', engine: 'claude-code' }),
        }),
      );
    });

    it('opens Edit… with the agent’s own fields, and sends every field together', async () => {
      const user = userEvent.setup();
      const { sent } = renderDock();

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Scope it' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));

      const nameBox = screen.getByRole('textbox', { name: 'Name of the agent' });
      expect(nameBox).toHaveValue('Scope it');
      await user.clear(nameBox);
      await user.type(nameBox, 'Scope it well');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(sent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'update_agent',
          payload: expect.objectContaining({ agentId: 'agent-scope', name: 'Scope it well' }),
        }),
      );
    });

    it('asks before deleting, and sends the delete once confirmed', async () => {
      const user = userEvent.setup();
      const { mutate } = renderDock();

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Scope it' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));

      expect(screen.getByText('Delete Scope it?')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Yes, delete Scope it' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'delete_agent', payload: expect.objectContaining({ agentId: 'agent-scope' }) }),
        expect.anything(),
      );
    });

    it('does not offer Edit… or Delete… on Ask Claude', () => {
      renderDock({ hasClaudeCodeConnection: true, askClaudeEnabled: true });

      const tile = screen.getByText('Ask Claude').closest('div')!;
      fireEvent.contextMenu(tile);

      expect(screen.queryByRole('menuitem', { name: 'Edit…' })).toBeNull();
    });
  });

  describe('hiding and showing are per dashboard', () => {
    it('sends a hide for this dashboard from the tile’s own menu', async () => {
      const user = userEvent.setup();
      const { mutate } = renderDock();

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Scope it' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Hide on this dashboard' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'hide_agent_on_dashboard',
          payload: expect.objectContaining({ agentId: 'agent-scope', dashboardId: 'dash-1', workspaceId: 'ws-work' }),
        }),
      );
    });

    it('says how many are hidden here, and shows one again from the dock’s own "…"', async () => {
      const user = userEvent.setup();
      const { mutate } = renderDock({ hiddenAgents: [{ dashboardId: 'dash-1', agentId: 'agent-ship' }] });

      await user.click(screen.getByRole('button', { name: 'What is hidden here, and the Ask Claude switch' }));

      expect(await screen.findByText('1 hidden here')).toBeInTheDocument();
      await user.click(screen.getByRole('menuitem', { name: 'Show Ship it' }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'show_agent_on_dashboard',
          payload: expect.objectContaining({ agentId: 'agent-ship', dashboardId: 'dash-1' }),
        }),
      );
    });

    it('says nothing is hidden here where nothing is', async () => {
      const user = userEvent.setup();
      renderDock();

      await user.click(screen.getByRole('button', { name: 'What is hidden here, and the Ask Claude switch' }));

      expect(await screen.findByText('Nothing hidden here')).toBeInTheDocument();
    });
  });

  describe('Ask Claude can be turned off everywhere, and on again, from the dock’s own "…"', () => {
    it.each([
      { situation: 'enabled, offers to turn it off', askClaudeEnabled: true, offers: 'Turn off Ask Claude everywhere' },
      { situation: 'disabled, offers to turn it on', askClaudeEnabled: false, offers: 'Turn on Ask Claude everywhere' },
    ])('$situation', async ({ askClaudeEnabled, offers }) => {
      const user = userEvent.setup();
      const { mutate } = renderDock({ askClaudeEnabled });

      await user.click(screen.getByRole('button', { name: 'What is hidden here, and the Ask Claude switch' }));
      await user.click(await screen.findByRole('menuitem', { name: offers }));

      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_ask_claude_enabled',
          payload: expect.objectContaining({ enabled: !askClaudeEnabled }),
        }),
      );
    });
  });

  describe('a right-click on a tile opens only that tile’s own menu', () => {
    it('does not also open the dock’s own empty-area menu', async () => {
      renderDock();

      fireEvent.contextMenu(screen.getByRole('button', { name: 'Scope it' }));
      await screen.findByRole('menuitem', { name: 'Edit…' });

      expect(screen.queryByText('Nothing hidden here')).toBeNull();
    });
  });

  describe('a name another agent already has is refused', () => {
    it('keeps the form open with a refusal, and what was typed', async () => {
      const user = userEvent.setup();
      renderDock(
        {},
        {
          succeeds: true,
          refusesTheForm: new CommandRefused(409, 'an agent called Ship it already exists'),
        },
      );

      await user.click(screen.getByRole('button', { name: '+ New agent' }));
      await user.type(screen.getByRole('textbox', { name: 'Name of the agent' }), 'Ship it');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('an agent called Ship it already exists');
      expect(screen.getByRole('textbox', { name: 'Name of the agent' })).toHaveValue('Ship it');
    });
  });
});

/** F1: what the dock draws of the runs and the connection, and what a picked-up tile carries (issue 571). */
describe('Agents', () => {
  const aRun = (id: string, agentId: string): AgentRun => ({
    id,
    itemId: `item-${id}`,
    agentId,
    agentName: 'Scope it',
    status: 'working',
    sessionUrl: 'https://claude.ai/code/session_01',
    reason: null,
    startedAt: '2026-09-28T10:00:00.000Z',
  });

  describe('each tile counts its agent’s open runs', () => {
    it.each([
      { situation: 'two runs', runs: [aRun('1', SCOPE_IT.id), aRun('2', SCOPE_IT.id)], count: '2' },
      { situation: 'none', runs: [aRun('3', SHIP_IT.id)], count: null },
    ])('an agent with $situation', ({ runs, count }) => {
      renderDock({ agentRuns: runs });

      const tile = screen.getByRole('button', { name: /^Scope it/ });
      expect(tile.textContent).toBe(`Scope it${count ?? ''}`);
    });
  });

  describe('the dock says what stands between its tiles and Claude', () => {
    it.each([
      { situation: 'no connection', connected: false, failing: null, says: 'Connect Claude Code to this workspace to start an agent.' },
      { situation: 'a connection Claude refused', connected: true, failing: 'The token is wrong or was revoked.', says: 'Claude Code is failing: The token is wrong or was revoked.' },
      { situation: 'a connection that works', connected: true, failing: null, says: null },
    ])('$situation', ({ connected, failing, says }) => {
      renderDock({ hasClaudeCodeConnection: connected, claudeCodeFailing: failing });

      const toolbar = screen.getByRole('toolbar', { name: 'Agents' });
      for (const line of ['Connect Claude Code', 'Claude Code is failing']) {
        const shown = within(toolbar).queryByText(new RegExp(`^${line}`));
        expect(shown?.textContent ?? null).toBe(says?.startsWith(line) ? says : null);
      }
    });
  });

  describe('a tile picked up carries its agent to the rows', () => {
    it('lifts the agent, and lands it when the drag ends', () => {
      renderDock();
      const carried: Record<string, string> = {};
      const dataTransfer = {
        setData: (type: string, value: string) => (carried[type] = value),
        effectAllowed: 'none',
      };

      fireEvent.dragStart(screen.getByRole('button', { name: 'Scope it' }), { dataTransfer });
      expect({ carried: carried[AGENT_BEING_DRAGGED], inTheAir: agentInTheAir() }).toEqual({
        carried: SCOPE_IT.id,
        inTheAir: SCOPE_IT.id,
      });
      fireEvent.dragEnd(screen.getByRole('button', { name: 'Scope it' }));
      expect(agentInTheAir()).toBeNull();
    });
  });
});
