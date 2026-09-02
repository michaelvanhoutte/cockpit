import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Dashboard, Panel, WorkspaceSnapshot } from '@cockpit/shared';
import { DashboardSettingsPage } from '../../../src/pages/DashboardSettingsPage';
import { CommandRefused } from '../../../src/api/client';
import { useCommand } from '../../../src/api/queries';

/**
 * F1: what is under test is the page's own behaviour - what it says before
 * anything is sent, what it asks for, and what it does with an answer it does
 * not like. Whether a name is refused, and whether the last dashboard may go,
 * are the server's rules and are proved against a real store in
 * apps/api/tests/integration/http/dashboards.test.ts. What is under test here
 * is the page saying the last-dashboard rule out loud before anything is
 * asked for, which is a claim about this screen and not about that rule.
 */
const held = vi.hoisted(() => ({ dashboards: [] as Dashboard[], panels: [] as Panel[] }));
const wentTo = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => (to: unknown) => {
    wentTo.calls.push(to);
  },
}));

vi.mock('../../../src/router', () => ({
  dashboardSettingsRoute: { useParams: () => ({ workspaceId: 'ws-work' }) },
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: vi.fn(),
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        workspace: {
          id: workspaceId,
          tenantId: 'tenant',
          name: 'Work',
          color: '#6f62b5',
          bar: '#dbd7ee',
          ground: '#e3e1f2',
          header: '#d2cdea',
        },
        items: [],
        dashboards: held.dashboards,
        panels: held.panels,
        layouts: [],
        associations: [],
        generatedAt: '2026-09-01T09:00:00.000Z',
      } as WorkspaceSnapshot),
  }),
}));

const mockUseCommand = vi.mocked(useCommand);

function aDashboard(name: string): Dashboard {
  return {
    id: `ws-work-${name.toLowerCase().replace(/\s+/g, '-')}`,
    tenantId: 'tenant',
    workspaceId: 'ws-work',
    name,
  };
}

/** The page, listing these dashboards, with a `useCommand` that answers. */
function showPage(names: string[], answer: { error?: Error; panelsOnEach?: number } = {}) {
  held.dashboards = names.map(aDashboard);
  held.panels = held.dashboards.flatMap((dashboard) =>
    Array.from({ length: answer.panelsOnEach ?? 0 }, (_, at) => ({
      id: `${dashboard.id}-panel-${at}`,
      tenantId: 'tenant',
      dashboardId: dashboard.id,
      name: `Panel ${at}`,
    })),
  );
  wentTo.calls = [];
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (!answer.error) options?.onSuccess?.();
  });
  mockUseCommand.mockReturnValue({
    mutate,
    reset: vi.fn(),
    isPending: false,
    error: answer.error ?? null,
    variables: answer.error
      ? { name: 'delete_dashboard', payload: { dashboardId: 'ws-work-research' } }
      : undefined,
  } as never);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <DashboardSettingsPage />
    </QueryClientProvider>,
  );
  return { mutate, user: userEvent.setup() };
}

/**
 * What a row offers is in the row's own menu, so reaching any of it is two
 * gestures: open the menu named for the dashboard, then choose the entry named
 * for the action ("Ask before deleting in a dialog, from the row's own menu",
 * issue 116).
 */
async function choose(user: ReturnType<typeof userEvent.setup>, row: string, entry: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${row}` }));
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

describe('Dashboards', () => {
  describe('the dashboards you can change are the workspace’s, and the Inbox is not one of them', () => {
    it('lists each dashboard by name, and nothing else', async () => {
      showPage(['Dashboard 1', 'Research']);

      expect(await screen.findByText('Research')).toBeVisible();
      expect(screen.getByText('Dashboard 1')).toBeVisible();
      // The Inbox is beside this page, not in this list: it is not a dashboard, so
      // there is nothing here to rename or delete.
      expect(screen.queryByText('Inbox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Actions for Inbox' })).toBeNull();
    });
  });

  describe('you are told what deleting a dashboard takes with it before it happens', () => {
    it.each([
      { situation: 'nothing on it', panelsOnEach: 0, says: 'Delete Research? There is nothing on it.' },
      { situation: 'one panel', panelsOnEach: 1, says: 'Delete Research? Its one panel goes with it.' },
      { situation: 'several panels', panelsOnEach: 3, says: 'Delete Research? Its 3 panels go with it.' },
    ])('names it and says it has $situation', async ({ panelsOnEach, says }) => {
      // Panels are what a dashboard holds ("Panels on a dashboard, with
      // per-screen-size layouts", issue 33), and the count is the whole of the
      // answer - counted for this dashboard, not for the workspace, which is
      // what the other dashboard in the list is here to catch.
      const { user } = showPage(['Dashboard 1', 'Research'], { panelsOnEach });

      await choose(user, 'Research', 'Delete');

      expect(screen.getByText(says)).toBeVisible();
    });

    it.each([
      { situation: 'cancelled', answer: 'Cancel' },
      { situation: 'dismissed with Escape', answer: null },
    ])('sends nothing when the question is $situation', async ({ answer }) => {
      const { user, mutate } = showPage(['Dashboard 1', 'Research']);

      await choose(user, 'Research', 'Delete');
      if (answer) await user.click(screen.getByRole('button', { name: answer }));
      else await user.keyboard('{Escape}');

      expect(mutate).not.toHaveBeenCalled();
      // The row is still the row: asking never changed it, so there is nothing
      // to put back.
      expect(screen.getByText('Research')).toBeVisible();
      expect(screen.queryByText(/^Delete Research\?/)).toBeNull();
    });

    it('asks to delete it, and leaves the workspace to decide where you land', async () => {
      const { user, mutate } = showPage(['Dashboard 1', 'Research']);

      await choose(user, 'Research', 'Delete');
      await user.click(screen.getByRole('button', { name: 'Yes, delete Research' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('delete_dashboard');
      expect(asked.payload.dashboardId).toBe('ws-work-research');
      // Not to a dashboard of its own choosing: the workspace's own address
      // decides, which is what makes deleting the one you are on land you
      // somewhere that works without this page knowing which.
      expect(wentTo.calls).toEqual([{ to: '/w/$workspaceId', params: { workspaceId: 'ws-work' } }]);
    });
  });

  describe('closing the question leaves you on the row you asked from', () => {
    it.each([
      { situation: 'cancelled', answer: 'Cancel' },
      { situation: 'dismissed with Escape', answer: null },
    ])('$situation', async ({ answer }) => {
      // The question is opened from an entry in a menu rather than by a
      // control of its own, so nothing puts the focus back unless this page
      // does - and in a list of rows, the top of the page is a lost place.
      const { user } = showPage(['Dashboard 1', 'Research']);

      await choose(user, 'Research', 'Delete');
      if (answer) await user.click(screen.getByRole('button', { name: answer }));
      else await user.keyboard('{Escape}');

      expect(screen.getByRole('button', { name: 'Actions for Research' })).toHaveFocus();
    });
  });

  describe('a workspace’s last dashboard cannot be deleted, and says so before it is asked for', () => {
    it('offers the entry, unavailable, with the reason on it', async () => {
      // Offered and then refused is how this read before: the rule is the
      // server's, so the only way to find out was to answer the question.
      const { user, mutate } = showPage(['Dashboard 1']);

      await user.click(await screen.findByRole('button', { name: 'Actions for Dashboard 1' }));
      const entry = await screen.findByRole('menuitem', {
        name: 'Delete: A workspace keeps at least one dashboard',
      });

      await user.click(entry);

      expect(screen.queryByText(/Delete Dashboard 1\?/)).toBeNull();
      expect(mutate).not.toHaveBeenCalled();
    });

    it('can be reached by the keyboard, which is who most needs to hear the reason', async () => {
      // Marked unavailable rather than disabled: a disabled entry is taken out
      // of the menu's roving focus, so arrow keys skip it and the reason is
      // never read out - leaving the people who cannot see it greyed out with
      // no entry at all, which is worse than the offered-then-refused this
      // replaced.
      const { user, mutate } = showPage(['Dashboard 1']);

      await user.click(await screen.findByRole('button', { name: 'Actions for Dashboard 1' }));
      await user.keyboard('{ArrowDown}{ArrowDown}');

      const entry = screen.getByRole('menuitem', {
        name: 'Delete: A workspace keeps at least one dashboard',
      });
      expect(entry).toHaveFocus();

      await user.keyboard('{Enter}');

      expect(mutate).not.toHaveBeenCalled();
      // Still open: choosing it did nothing, and a menu that closed would read
      // as having done something.
      expect(entry).toBeVisible();
    });
  });

  describe('renaming a dashboard asks for the name you typed, starting from the one it has', () => {
    it('offers the current name and asks for the new one without the blanks around it', async () => {
      const { user, mutate } = showPage(['Research']);

      await choose(user, 'Research', 'Rename');
      const box = screen.getByLabelText('New name for Research');
      expect(box).toHaveValue('Research');
      await user.clear(box);
      await user.type(box, '  Recherche  ');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('rename_dashboard');
      expect(asked.payload.name).toBe('Recherche');
      expect(asked.payload.dashboardId).toBe('ws-work-research');
    });
  });

  describe('a change that could not happen puts the screen back', () => {
    it.each([
      {
        situation: 'the dashboard is no longer there to delete',
        error: new CommandRefused(404, 'that dashboard is not in this workspace'),
        says: 'that dashboard is not in this workspace',
      },
      {
        situation: 'the request never reached the server',
        error: new Error('Failed to fetch'),
        says: 'That did not reach the server. Try again.',
      },
    ])('$situation', async ({ error, says }) => {
      const { user } = showPage(['Dashboard 1', 'Research'], { error });

      await choose(user, 'Research', 'Delete');
      await user.click(screen.getByRole('button', { name: 'Yes, delete Research' }));

      expect(screen.getByRole('alert')).toHaveTextContent(says);
      // Said where it was asked for, in a question that is still open: a
      // dialog that closed and left the message behind on the page would make
      // a refusal look like a delete that had worked.
      expect(screen.getByText('Delete Research? There is nothing on it.')).toBeVisible();
      expect(screen.getByText('Research')).toBeVisible();
    });
  });
});
