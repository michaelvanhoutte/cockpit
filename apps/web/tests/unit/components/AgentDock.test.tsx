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

    it('draws nothing but + New agent where none has been made, connected or not', () => {
      renderDock({ agents: [], hasClaudeCodeConnection: true });

      expect(screen.getAllByRole('button').filter((button) => button.textContent === '+ New agent')).toHaveLength(1);
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

      expect(screen.getByText('1 hidden here')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'What is hidden here' }));
      const menu = await screen.findByRole('menu');
      expect(within(menu).getByText('1 hidden here')).toBeInTheDocument();
      await user.click(within(menu).getByRole('menuitem', { name: 'Show Ship it' }));

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

      await user.click(screen.getByRole('button', { name: 'What is hidden here' }));

      expect(await screen.findByText('Nothing hidden here')).toBeInTheDocument();
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
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

  describe('a right-click anywhere else on the bar opens the dock’s own menu', () => {
    it('opens it from the "…" trigger’s own corner, not only the scrolling tile strip', async () => {
      renderDock();

      fireEvent.contextMenu(screen.getByRole('toolbar', { name: 'Agents' }));

      expect(await screen.findByText('Nothing hidden here')).toBeInTheDocument();
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
  const aRun = (id: string, agentId: string, waiting = false): AgentRun => ({
    id,
    itemId: `item-${id}`,
    agentId,
    agentName: 'Scope it',
    status: 'working',
    sessionUrl: 'https://claude.ai/code/session_01',
    reason: null,
    startedAt: '2026-09-28T10:00:00.000Z',
    waiting,
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

  describe('the dock counts what is waiting on you, on each tile and in all', () => {
    it.each([
      {
        situation: 'one of two runs waiting',
        runs: [aRun('1', SCOPE_IT.id, true), aRun('2', SCOPE_IT.id)],
        tile: 'Scope it21 waiting on you',
        total: '1 waiting on you',
      },
      {
        situation: 'runs of two agents waiting',
        runs: [aRun('1', SCOPE_IT.id, true), aRun('2', SHIP_IT.id, true)],
        tile: 'Scope it11 waiting on you',
        total: '2 waiting on you',
      },
      { situation: 'every run working again', runs: [aRun('1', SCOPE_IT.id), aRun('2', SCOPE_IT.id)], tile: 'Scope it2', total: null },
    ])('with $situation', ({ runs, tile, total }) => {
      renderDock({ agentRuns: runs });

      expect(screen.getByRole('button', { name: /^Scope it/ }).textContent).toBe(tile);
      if (total) expect(screen.getByText(total)).toBeInTheDocument();
      else expect(screen.queryByText(/waiting on you/)).not.toBeInTheDocument();
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
