import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Workspace, WorkspaceSnapshot } from '@cockpit/shared';
import { CommandRefused } from '../../../src/api/client';
import { useCommand, useSendCommand } from '../../../src/api/queries';
import { WorkspaceTabs } from '../../../src/components/WorkspaceTabs';

/**
 * F1: what is under test is the strip's own behaviour - what its menu offers,
 * what a form sends, and what it does with an answer it does not like. Whether
 * a name is actually refused is the server's rule, proved against a real store
 * in apps/api/tests/integration/http/workspaces.test.ts; that the gestures
 * reach a real menu is tests/e2e/workspace-management.test.ts.
 */
const held = vi.hoisted(() => ({ workspaces: [] as Workspace[], items: 0, here: 'ws-work' }));

const wentTo = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@tanstack/react-router', () => ({
  // `href` so it is a link to the accessibility tree, which is what a tab is.
  // Everything else is passed through rather than dropped: the tab is a `Link`
  // rendered `asChild` by the menu, so what makes it a trigger arrives as props
  // from Radix and a mock keeping only `children` would drop them.
  Link: ({
    children,
    to: _to,
    params: _params,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: unknown;
    params?: unknown;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => (to: unknown) => {
    wentTo.calls.push(to);
  },
  useParams: () => ({ workspaceId: held.here }),
}));

vi.mock('../../../src/api/queries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/api/queries')>();
  return {
    ...real,
    useCommand: vi.fn(),
    useSendCommand: vi.fn(),
    workspacesQuery: {
      queryKey: ['workspaces'],
      queryFn: () => Promise.resolve({ workspaces: held.workspaces }),
    },
    snapshotQuery: (workspaceId: string) => ({
      queryKey: ['snapshot', workspaceId],
      queryFn: (): Promise<WorkspaceSnapshot> =>
        Promise.resolve({
          items: Array.from({ length: held.items }, (_, i) => ({ id: `item-${i}` })),
        } as WorkspaceSnapshot),
    }),
  };
});

const mockUseCommand = vi.mocked(useCommand);
const mockUseSendCommand = vi.mocked(useSendCommand);

const THEME = { color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' };

/** What the strip asks the server for, in the shape both senders take it. */
type AskedFor = { name: string; payload: Record<string, string> };

function aWorkspace(name: string, color = THEME.color): Workspace {
  return {
    id: `ws-${name.toLowerCase()}`,
    tenantId: 'tenant',
    name,
    ...THEME,
    color,
  } as Workspace;
}

/**
 * The strip holding these workspaces.
 *
 * The mutation behaves like the real one rather than returning a fixed value:
 * `reset` really clears the error, because "the refusal is not still there next
 * time" is a claim about what the screen shows afterwards.
 */
function showTabs(
  names: string[],
  answer: { error?: Error; here?: string; items?: number; sendFails?: Error } = {},
) {
  held.workspaces = names.map((name) => aWorkspace(name));
  held.items = answer.items ?? 0;
  held.here = answer.here ?? held.workspaces[0]!.id;
  wentTo.calls = [];
  const asked: { error: Error | null; variables: unknown } = { error: null, variables: null };
  const mutate = vi.fn((args: AskedFor, options?: { onSuccess?: () => void; onError?: () => void }) => {
    asked.variables = args;
    if (answer.error) {
      asked.error = answer.error;
      options?.onError?.();
      return;
    }
    options?.onSuccess?.();
  });
  const reset = vi.fn(() => {
    asked.error = null;
  });
  mockUseCommand.mockImplementation(
    () =>
      ({
        mutate,
        reset,
        isPending: false,
        get error() {
          return asked.error;
        },
        get variables() {
          return asked.variables;
        },
      }) as never,
  );
  const sent = vi.fn((_args: AskedFor) =>
    answer.sendFails ? Promise.reject(answer.sendFails) : Promise.resolve(),
  );
  mockUseSendCommand.mockImplementation(() => sent as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkspaceTabs bar={THEME.bar} bringIntoView={() => {}}>
        <button type="button">Add a workspace</button>
      </WorkspaceTabs>
    </QueryClientProvider>,
  );
  return { mutate, sent, user: userEvent.setup() };
}

/** Opens a tab's own menu the way a pointer does. */
async function menuOf(name: string) {
  fireEvent.contextMenu(await screen.findByRole('link', { name }));
  return screen.findByRole('menu');
}

describe('Workspace management', () => {
  describe('what can be done to a workspace is on the tab it is', () => {
    // The list this replaces was two presses away in the header's menu, and
    // then a row to find. What each entry does is the rules below.
    it('offers editing, moving and deleting on the tab itself', async () => {
      // A tab with a workspace either side of it, so every entry can be
      // chosen; what an entry at the end of the strip says is the rule below.
      showTabs(['Work', 'Personal', 'Acme']);

      await menuOf('Personal');

      expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
        'Edit…',
        'Move left',
        'Move right',
        'Delete',
      ]);
    });

    it.each([
      { situation: 'the first workspace', name: 'Work', cannot: 'Move left: It is already the first' },
      { situation: 'the last workspace', name: 'Acme', cannot: 'Move right: It is already the last' },
    ])('says why a tab at the end of the strip cannot move further, on $situation', async (row) => {
      // Said rather than hidden: the menu is the only way a keyboard has to
      // move a tab, and an entry that vanishes reads as broken.
      showTabs(['Work', 'Personal', 'Acme']);

      await menuOf(row.name);

      expect(screen.getByRole('menuitem', { name: row.cannot })).toBeVisible();
    });

    it('opens the menu of the tab you are already on when it is pressed', async () => {
      // The press has no other job - you are looking at what it would switch
      // to - and it is the way in that needs no right button and no long
      // press, which is what a phone has.
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-work' });

      await user.click(await screen.findByRole('link', { name: 'Work' }));

      expect(await screen.findByRole('menuitem', { name: 'Edit…' })).toBeVisible();
    });

    it('leaves a press on any other tab as the switch it is', async () => {
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-work' });

      await user.click(await screen.findByRole('link', { name: 'Personal' }));

      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('changing a workspace sends only what actually changed', () => {
    // An untouched box must send nothing, or it would carry the value the form
    // opened with over an edit made somewhere else in the meantime - and a
    // colour nobody touched would repaint the workspace on every rename.
    it.each([
      { situation: 'a new name and the colour left alone', rename: 'Client', paint: false },
      { situation: 'a colour and the name left alone', rename: null, paint: true },
      { situation: 'both halves', rename: 'Client', paint: true },
      { situation: 'neither half', rename: null, paint: false },
    ])('sends what moved and no more, given $situation', async (row) => {
      const { sent, user } = showTabs(['Work', 'Personal']);
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Edit…' }));

      if (row.rename) {
        await user.clear(screen.getByRole('textbox', { name: 'Name of Personal' }));
        await user.type(screen.getByRole('textbox', { name: 'Name of Personal' }), row.rename);
      }
      if (row.paint) await user.click(screen.getByRole('button', { name: /^Teal for Personal$/ }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      const names = sent.mock.calls.map(([args]) => args.name);
      expect(names).toEqual(
        [row.rename ? 'rename_workspace' : null, row.paint ? 'set_workspace_theme' : null].filter(
          Boolean,
        ),
      );
    });

    it('keeps the form open with what was typed when the server refuses it', async () => {
      const { user } = showTabs(['Work', 'Personal'], {
        sendFails: new CommandRefused(409, 'a workspace called Work already exists'),
      });
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Edit…' }));
      await user.clear(screen.getByRole('textbox', { name: 'Name of Personal' }));
      await user.type(screen.getByRole('textbox', { name: 'Name of Personal' }), 'Work');

      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'a workspace called Work already exists',
      );
      expect(screen.getByRole('textbox', { name: 'Name of Personal' })).toHaveValue('Work');
    });
  });

  describe('a workspace you move is shown where you moved it before the server agrees', () => {
    it('paints the new order at once', async () => {
      // Not politeness: the order a move is computed from is the order in
      // hand, so a second move made before the first came back would undo it.
      const { mutate, user } = showTabs(['Work', 'Personal', 'Acme']);
      await menuOf('Work');

      await user.click(screen.getByRole('menuitem', { name: 'Move right' }));

      await waitFor(() =>
        expect(
          screen
            .getAllByRole('link')
            .map((tab) => tab.textContent)
            .filter((name) => name !== ''),
        ).toEqual(['Personal', 'Work', 'Acme']),
      );
      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        name: 'reorder_workspaces',
        payload: { workspaceIds: ['ws-personal', 'ws-work', 'ws-acme'] },
      });
    });

    it('puts the tabs back when the move is refused', async () => {
      const { user } = showTabs(['Work', 'Personal', 'Acme'], {
        error: new CommandRefused(409, 'the list of workspaces has changed'),
      });
      await menuOf('Work');

      await user.click(screen.getByRole('menuitem', { name: 'Move right' }));

      await waitFor(() =>
        expect(
          screen
            .getAllByRole('link')
            .map((tab) => tab.textContent)
            .filter((name) => name !== ''),
        ).toEqual(['Work', 'Personal', 'Acme']),
      );
    });
  });

  describe('deleting a workspace asks first, and says what stops being visible', () => {
    it.each([
      { situation: 'a workspace holding nothing', items: 0, asks: 'Delete Personal? There is nothing in it.' },
      { situation: 'a workspace holding one item', items: 1, asks: 'Delete Personal and hide its 1 item?' },
      { situation: 'a workspace holding several', items: 4, asks: 'Delete Personal and hide its 4 items?' },
    ])('says what goes with it, for $situation', async (row) => {
      const { user } = showTabs(['Work', 'Personal'], { items: row.items });
      await menuOf('Personal');

      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

      expect(await screen.findByRole('alertdialog', { name: row.asks })).toBeVisible();
    });

    it('leaves the focus in the strip once the tab it was asked from has gone', async () => {
      // The question closes by ceasing to exist rather than by being
      // dismissed, so nothing else puts the focus anywhere and it falls to the
      // top of a page you cannot see. It goes to the tab you are on, which is
      // the nearest thing to where you were.
      //
      // **This is the easy half.** The list here is fixed, so the workspace
      // deleted is one this walk was not looking at and the tab to land on is
      // there already. Deleting the one you *are* on moves the app to another
      // workspace first, and the focus has to wait for that - which passed
      // here while the app put the focus on a tab about to be taken away, and
      // is held in tests/e2e/workspace-management.test.ts instead.
      const { user } = showTabs(['Work', 'Personal'], { here: 'ws-work', items: 0 });
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
      await user.click(await screen.findByRole('button', { name: 'Yes, delete Personal' }));

      await waitFor(() => expect(screen.getByRole('link', { name: 'Work' })).toHaveFocus());
    });

    it('sends the delete only once the question has been answered', async () => {
      const { mutate, user } = showTabs(['Work', 'Personal'], { items: 2 });
      await menuOf('Personal');
      await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
      await screen.findByRole('alertdialog');
      expect(mutate).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Yes, delete Personal' }));

      expect(mutate.mock.calls[0]?.[0]).toMatchObject({
        name: 'delete_workspace',
        payload: { workspaceId: 'ws-personal' },
      });
    });
  });
});
