import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectedApp } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import ManageConnectedApps from '../../../src/components/ManageConnectedApps';

/**
 * F1: what the window draws and what it sends. That an app really is cut off,
 * and that only your own are listed, are the server's rules, proved against
 * the real Worker in apps/api/tests/integration/http/connected-apps.test.ts;
 * that a person can find the window, copy the address and disconnect an app is
 * the browser walk in tests/e2e/connected-apps.test.ts; what a disconnect shows
 * while the server has yet to answer is
 * tests/unit/components/ConnectedAppsAtOnce.test.tsx.
 */
const held = vi.hoisted(() => ({
  apps: [] as unknown[],
  deleted: [] as string[],
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  api: {
    v1: {
      'connected-apps': {
        $get: () => Promise.resolve(new Response(JSON.stringify({ apps: held.apps }))),
        ':appId': {
          $delete: ({ param }: { param: { appId: string } }) => {
            held.deleted.push(param.appId);
            held.apps = (held.apps as ConnectedApp[]).filter((app) => app.id !== param.appId);
            return Promise.resolve(new Response(JSON.stringify({ disconnected: true })));
          },
        },
      },
    },
  },
}));

const CLAUDE: ConnectedApp = {
  id: 'grant-claude',
  name: 'Claude',
  kind: 'captures',
  connectedAt: '2026-09-30T09:00:00.000Z',
  lastCapturedAt: '2026-10-01T08:00:00.000Z',
  lastReadAt: null,
};
const QUIET: ConnectedApp = {
  id: 'grant-quiet',
  name: 'Quiet app',
  kind: 'captures',
  connectedAt: '2026-09-30T10:00:00.000Z',
  lastCapturedAt: null,
  lastReadAt: null,
};
const WIDGET: ConnectedApp = {
  id: 'grant-widget',
  name: 'Cockpit widget',
  kind: 'reads-panels',
  connectedAt: '2026-10-02T10:00:00.000Z',
  lastCapturedAt: null,
  lastReadAt: '2026-10-23T09:30:00.000Z',
};
const NEW_WIDGET: ConnectedApp = { ...WIDGET, id: 'grant-new-widget', lastReadAt: null };

function showWindow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ManageConnectedApps open onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  held.apps = [];
  held.deleted = [];
});

afterEach(() => {
  changes.forgetAnswered();
});

describe('MCP connections', () => {
  describe('the window lists the apps you allowed, and says so where there are none', () => {
    it('shows each app by its registered name, when it was connected and when it last captured', async () => {
      held.apps = [CLAUDE, QUIET];

      showWindow();

      const claude = (await screen.findByText('Claude')).closest('li')!;
      expect(within(claude).getByText(/Connected .* · last captured /)).toBeInTheDocument();
      const quiet = screen.getByText('Quiet app').closest('li')!;
      expect(within(quiet).getByText(/nothing captured yet/)).toBeInTheDocument();
    });

    it('says of an app allowed only to read your Panels that it reads them, and when it last read one', async () => {
      held.apps = [WIDGET, NEW_WIDGET];

      showWindow();

      const read = (await screen.findAllByText('Cockpit widget'))[0]!.closest('li')!;
      expect(within(read).getByText(/Connected .* · Reads your Panels · last read /)).toBeInTheDocument();
      const unread = screen.getAllByText('Cockpit widget')[1]!.closest('li')!;
      expect(within(unread).getByText(/Reads your Panels · nothing read yet/)).toBeInTheDocument();
      expect(screen.queryByText(/captured/)).toBeNull();
    });

    it('says no app is connected only once the answer has come back, and still shows the address', async () => {
      showWindow();

      expect(screen.queryByText('No connected apps')).toBeNull();
      expect(await screen.findByText('No connected apps')).toBeInTheDocument();
      expect(screen.getByText(`${window.location.origin}/mcp`)).toBeInTheDocument();
    });
  });

  describe('the window says what an allowed app can do with your Cockpit', () => {
    it('says connected apps can capture items and read your items', async () => {
      showWindow();

      expect(await screen.findByText(/to capture and read your items, or only to read your Panels/)).toBeInTheDocument();
    });
  });

  describe('the address to paste into claude.ai is this environment’s own', () => {
    it('is the origin the page is on followed by /mcp, and Copy puts exactly that on the clipboard', async () => {
      const user = userEvent.setup();
      showWindow();
      const written = vi.spyOn(navigator.clipboard, 'writeText');

      await user.click(await screen.findByRole('button', { name: 'Copy' }));

      expect(written).toHaveBeenCalledWith(`${window.location.origin}/mcp`);
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    });
  });

  describe('disconnecting asks first, and sends nothing until it is answered yes', () => {
    it('keeps the app, and sends nothing, when the question is cancelled', async () => {
      held.apps = [CLAUDE];
      const user = userEvent.setup();
      showWindow();

      await user.click(await screen.findByRole('button', { name: 'Actions for Claude' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
      expect(await screen.findByText(/The items it captured stay/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(held.deleted).toEqual([]);
      expect(screen.getByText('Claude')).toBeInTheDocument();
    });

    it('disconnects exactly that app and takes its row away', async () => {
      held.apps = [CLAUDE, QUIET];
      const user = userEvent.setup();
      showWindow();

      await user.click(await screen.findByRole('button', { name: 'Actions for Claude' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
      await user.click(await screen.findByRole('button', { name: 'Yes, disconnect Claude' }));

      await waitFor(() => expect(screen.queryByText('Claude')).toBeNull());
      expect(held.deleted).toEqual(['grant-claude']);
      expect(screen.getByText('Quiet app')).toBeInTheDocument();
    });
  });
});
