import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SourceAccount } from '@cockpit/shared';
import SettingsWindow, { type SettingsKey } from '../../../src/components/SettingsWindow';

/**
 * F1: what Settings draws and how it switches. The content of each section is
 * the old window's own, and keeps its own tests (ManageTypes.test.tsx,
 * ManageConnections.test.tsx, ManageConnectedApps.test.tsx); that a person can
 * reach them is the browser walks in tests/e2e/item-types.test.ts and
 * connections.test.ts.
 */
const held = vi.hoisted(() => ({
  /** Whether the code of the MCP section has not arrived yet; the first case holds it. */
  mcpCodeHeld: true,
  releaseMcpCode: () => {},
  arrived: null as unknown as Promise<void>,
  accounts: {} as Record<string, unknown[]>,
  /** Whether a change is in flight, which keeps a window open until its answer is in. */
  pending: false,
}));
held.arrived = new Promise<void>((resolve) => {
  held.releaseMcpCode = resolve;
});

vi.mock('../../../src/components/ManageConnectedApps', async (importOriginal) => {
  if (held.mcpCodeHeld) await held.arrived;
  return importOriginal();
});

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: () => undefined, isPending: held.pending, error: null, reset: () => undefined, variables: undefined }),
  useSendCommand: () => () => Promise.resolve({ ok: true, applied: true }),
  useConnectClaudeCode: () => ({ mutate: () => undefined, isPending: false, error: null, data: undefined, reset: () => undefined }),
  useTestClaudeCodeConnection: () => ({ mutate: () => undefined, isPending: false }),
  refusalFrom: () => null,
  itemTypesQuery: { queryKey: ['itemTypes'], queryFn: () => Promise.resolve({ itemTypes: [] }) },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () =>
      Promise.resolve({
        workspaces: [
          { id: 'ws-alpha', name: 'Alpha' },
          { id: 'ws-beta', name: 'Beta' },
        ],
      }),
  },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: [] }),
  }),
}));

vi.mock('../../../src/api/client', () => ({
  api: {
    v1: {
      'connected-apps': { $get: () => Promise.resolve(new Response(JSON.stringify({ apps: [] }))) },
      workspaces: {
        ':workspaceId': {
          connections: {
            $get: ({ param }: { param: { workspaceId: string } }) =>
              Promise.resolve(
                new Response(JSON.stringify({ sourceAccounts: held.accounts[param.workspaceId] ?? [] })),
              ),
          },
        },
      },
    },
  },
  CommandRefused: class extends Error {},
  refusal: (what: string, status: number) => new Error(`${what} failed: ${status}`),
}));

const account = (id: string, connectorId: string, displayName: string): SourceAccount => ({
  id,
  connectorId,
  displayName,
  connectedAt: '2026-09-18T09:00:00.000Z',
  lastTestedAt: null,
  failingBecause: null,
});

function open(
  on: SettingsKey,
  extra: Partial<React.ComponentProps<typeof SettingsWindow>> = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsWindow on={on} startsIn="ws-alpha" onClose={() => undefined} {...extra} />
    </QueryClientProvider>,
  );
}

const selected = () => [...document.querySelectorAll('[aria-current="true"]')].map((el) => el.textContent);
const entry = (name: string) => within(screen.getByRole('navigation', { name: 'Settings' })).getByRole('button', { name });

describe('Across the app', () => {
  describe('Settings stays open while you switch section, even one whose content is still arriving', () => {
    it('keeps the window and waits on the section that has not arrived', async () => {
      const user = userEvent.setup();
      open('types');
      await screen.findByRole('heading', { name: 'Types' });

      await user.click(entry('MCP'));

      // The code of that section is held: the window is still there, the list
      // beside it still works, and the section says it is waiting.
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible();
      expect(await screen.findByText('Loading…')).toBeVisible();
      await user.click(entry('Types'));
      expect(await screen.findByRole('heading', { name: 'Types' })).toBeVisible();

      held.mcpCodeHeld = false;
      held.releaseMcpCode();
    });

    it.each(['Connections', 'Agent settings', 'MCP', 'Types'])('stays open on %s', async (name) => {
      const user = userEvent.setup();
      open('types');
      await screen.findByRole('heading', { name: 'Types' });

      await user.click(entry(name));

      expect(await screen.findByRole('heading', { name })).toBeVisible();
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    });
  });

  describe('Settings stays open while a change in a section is waiting for its answer', () => {
    it('ignores Escape until the answer is in', async () => {
      held.pending = true;
      const user = userEvent.setup();
      open('types');
      await screen.findByRole('heading', { name: 'Types' });

      await user.keyboard('{Escape}');

      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeVisible();
      held.pending = false;
    });
  });

  describe('each section of Settings is headed by the name of its entry', () => {
    it.each(['Types', 'Connections', 'Agent settings', 'MCP'])('heads %s with its own name', async (name) => {
      const user = userEvent.setup();
      open('types');
      await user.click(entry(name));

      const headings = await screen.findAllByRole('heading', { name });
      expect(headings).toHaveLength(1);
    });
  });

  describe('Settings opens on the section asked for, with only that one selected and focus on it', () => {
    it.each([
      { situation: 'from the profile menu', on: 'types' as const, name: 'Types' },
      { situation: 'from the dock', on: 'agents' as const, name: 'Agent settings' },
      { situation: 'on return from Microsoft', on: 'connections' as const, name: 'Connections' },
    ])('$situation selects and focuses $name and no other', async ({ on, name }) => {
      open(on);

      await waitFor(() => expect(entry(name)).toHaveFocus());
      expect(selected()).toEqual([name]);
    });
  });

  describe('Connections and Agent settings are about one workspace at a time, starting with the open one', () => {
    it('lists each kind under its own section and only for the workspace picked', async () => {
      held.accounts = {
        'ws-alpha': [
          account('a1', 'teams', 'Ada Teams'),
          account('a2', 'claude-code', 'Alpha Claude'),
          account('a3', 'gmail', 'ada@example.com'),
        ],
        'ws-beta': [account('b1', 'teams', 'Bea Teams')],
      };
      const user = userEvent.setup();
      open('connections');

      const picker = await screen.findByRole('combobox', { name: /Workspace/ });
      expect(picker).toHaveValue('ws-alpha');
      expect(await screen.findByText('Ada Teams')).toBeVisible();
      // Gmail sits beside Teams under Connections (issue 724).
      expect(screen.getByText('ada@example.com')).toBeVisible();
      expect(screen.queryByText('Alpha Claude')).toBeNull();

      await user.selectOptions(picker, 'ws-beta');
      expect(await screen.findByText('Bea Teams')).toBeVisible();
      expect(screen.queryByText('Ada Teams')).toBeNull();

      await user.click(entry('Agent settings'));
      expect(await screen.findByRole('combobox', { name: /Workspace/ })).toHaveValue('ws-alpha');
      expect(await screen.findByText('Alpha Claude')).toBeVisible();
      expect(screen.queryByText('Ada Teams')).toBeNull();
      expect(screen.queryByText('ada@example.com')).toBeNull();
    });

    it('still names the workspace when the account has only one', async () => {
      held.accounts = {};
      open('agents');
      const picker = await screen.findByRole('combobox', { name: /Workspace/ });
      expect(within(picker).getAllByRole('option').length).toBeGreaterThan(0);
    });
  });

  describe('coming back from Microsoft says how it went, for the workspace it was started from', () => {
    it.each([
      { situation: 'it connected', outcome: 'connected' as const, said: 'Connected.' },
      { situation: 'it was refused', outcome: 'refused' as const, said: /Nothing was stored/ },
    ])('$situation', async ({ outcome, said }) => {
      held.accounts = {};
      open('connections', { startsIn: 'ws-alpha', outcome: { workspaceId: 'ws-beta', outcome } });

      expect(await screen.findByText(said)).toBeVisible();
      expect(await screen.findByRole('combobox', { name: /Workspace/ })).toHaveValue('ws-beta');
    });
  });
});
