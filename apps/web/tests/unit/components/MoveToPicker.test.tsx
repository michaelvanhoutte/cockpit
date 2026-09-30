import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Dashboard, Panel } from '@cockpit/shared';
import { MoveToPicker, type MoveTarget } from '../../../src/components/MoveToPicker';

/**
 * F1: what the picker offers is decided from its props alone, so none of this
 * needs the list it opens from. That the right props are handed over for a real
 * row is ItemList.test.tsx's; that the dialog keeps its size and its headings
 * stay pinned is layout, walked in tests/e2e/filing.test.ts.
 */

const TODAY: Dashboard = { id: 'd-today', tenantId: 't', workspaceId: 'ws', name: 'Today' };
const RESEARCH: Dashboard = { id: 'd-research', tenantId: 't', workspaceId: 'ws', name: 'Research' };
const EMPTY: Dashboard = { id: 'd-empty', tenantId: 't', workspaceId: 'ws', name: 'Later' };

function aPanel(id: string, dashboardId: string, name: string): Panel {
  return {
    id,
    tenantId: 't',
    dashboardId,
    name,
    kind: 'items' as const,
    format: 'plain' as const,
    body: '',
    readOnly: false,
    filter: null,
    sort: null,
  };
}

const PANELS = [
  aPanel('p-falcon', TODAY.id, 'Falcon'),
  aPanel('p-anna', TODAY.id, 'Anna'),
  aPanel('p-reading', RESEARCH.id, 'To read'),
  aPanel('p-papers', RESEARCH.id, 'Papers'),
];

function show(props: Partial<Parameters<typeof MoveToPicker>[0]> = {}) {
  const picked: MoveTarget[] = [];
  const user = userEvent.setup();
  const view = render(
    <MoveToPicker
      moving={{ title: 'Reply to Bart' }}
      dashboards={[TODAY, RESEARCH]}
      panels={PANELS}
      workspaceId="ws"
      openDashboardId={TODAY.id}
      recent={[]}
      open
      onPick={(target) => picked.push(target)}
      onCancel={vi.fn()}
      {...props}
    />,
  );
  const dialog = screen.getByRole('dialog');
  return { user, picked, dialog, view };
}

/** What the picker offers, top to bottom, headings and all. */
function offered(dialog: HTMLElement): string[] {
  return within(dialog)
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((label) => label !== 'Cancel');
}

const search = (dialog: HTMLElement) => within(dialog).getByRole('searchbox');

describe('Panels', () => {
  describe('the picker offers every place the item could usefully go, and nothing else', () => {
    it.each([
      {
        situation: 'moving an item on one panel leaves that panel out',
        props: { alreadyOn: ['p-falcon'] },
        offers: ['Inboxoff every panel', 'Anna', 'To read', 'Papers'],
      },
      {
        situation: 'moving an item on two panels offers both',
        props: { alreadyOn: ['p-falcon', 'p-anna'] },
        offers: ['Inboxoff every panel', 'Falcon', 'Anna', 'To read', 'Papers'],
      },
      {
        situation: 'moving an item in the Inbox leaves the Inbox out',
        props: { alreadyOn: [] },
        offers: ['Falcon', 'Anna', 'To read', 'Papers'],
      },
      {
        situation: 'adding an item on two panels leaves both out',
        props: { adding: true, alreadyOn: ['p-falcon', 'p-anna'] },
        offers: ['To read', 'Papers'],
      },
      {
        situation: 'a selection of several items offers every panel and the Inbox',
        props: { moving: { several: 3 } },
        offers: ['Inboxoff every panel', 'Falcon', 'Anna', 'To read', 'Papers'],
      },
    ])('$situation', ({ props, offers }) => {
      const { dialog } = show(props);

      expect(offered(dialog)).toEqual(offers);
    });

    it('leaves a panel the item is on out of Recently used as well', () => {
      const { dialog } = show({ alreadyOn: ['p-anna'], recent: ['p-anna', 'p-papers'] });

      expect(offered(dialog)).toEqual([
        'Inboxoff every panel',
        'Paperson Research',
        'Falcon',
        'To read',
        'Papers',
      ]);
    });

    it('drops the heading of a dashboard whose only panel is left out', () => {
      const { dialog } = show({
        adding: true,
        dashboards: [TODAY],
        panels: [PANELS[0]!],
        alreadyOn: ['p-falcon'],
      });

      expect(within(dialog).queryByRole('heading', { name: /Today/ })).toBeNull();
      expect(within(dialog).getByText('Nowhere else to put it.')).toBeVisible();
    });

    it('still says a dashboard has no panels when it has none at all', () => {
      const { dialog } = show({ dashboards: [TODAY, EMPTY], panels: [PANELS[0]!] });

      expect(within(dialog).getByRole('heading', { name: 'Later' })).toBeVisible();
      expect(within(dialog).getByText('No panels yet.')).toBeVisible();
    });
  });

  describe('search narrows the list to what matches, by panel or dashboard name', () => {
    it.each([
      {
        situation: 'part of a panel’s name, in any case, keeps only that panel under its dashboard',
        typed: 'PAP',
        headings: ['Research'],
        offers: ['Papers'],
      },
      {
        situation: 'a dashboard’s name keeps all of its panels',
        typed: 'today',
        headings: ['Today'],
        offers: ['Falcon', 'Anna'],
      },
      {
        situation: 'a dashboard with nothing matching loses its heading',
        typed: 'anna',
        headings: ['Today'],
        offers: ['Anna'],
      },
    ])('$situation', async ({ typed, headings, offers }) => {
      const { user, dialog } = show({ alreadyOn: [] });

      await user.type(search(dialog), typed);

      expect(
        within(dialog)
          .getAllByRole('heading', { level: 3 })
          .map((h) => h.textContent?.replace('this dashboard', '')),
      ).toEqual(headings);
      expect(offered(dialog)).toEqual(offers);
    });

    it('hides Recently used while searching, and brings it back when cleared', async () => {
      const { user, dialog } = show({ recent: ['p-papers'] });
      expect(within(dialog).getByRole('heading', { name: 'Recently used' })).toBeVisible();

      await user.type(search(dialog), 'pap');
      expect(within(dialog).queryByRole('heading', { name: 'Recently used' })).toBeNull();

      await user.clear(search(dialog));
      expect(within(dialog).getByRole('heading', { name: 'Recently used' })).toBeVisible();
      expect(offered(dialog)).toHaveLength(6);
    });

    it('says so when nothing is called that', async () => {
      const { user, dialog } = show();

      await user.type(search(dialog), 'zzz');

      expect(within(dialog).getByText('Nothing called “zzz”.')).toBeVisible();
    });

    it('finds the Inbox by name, but never when adding, which has none', async () => {
      const first = show();
      await first.user.type(search(first.dialog), 'inb');
      expect(offered(first.dialog)).toEqual(['Inboxoff every panel']);
      first.view.unmount();

      const second = show({ adding: true });
      await second.user.type(search(second.dialog), 'inb');
      expect(within(second.dialog).getByText('Nothing called “inb”.')).toBeVisible();
    });

    it('starts empty each time it is opened', async () => {
      const { user, dialog, view } = show();
      const picker = (open: boolean) => (
        <MoveToPicker
          moving={{ title: 'Reply to Bart' }}
          dashboards={[TODAY, RESEARCH]}
          panels={PANELS}
          workspaceId="ws"
          openDashboardId={TODAY.id}
          recent={[]}
          open={open}
          onPick={vi.fn()}
          onCancel={vi.fn()}
        />
      );
      await user.type(search(dialog), 'pap');

      view.rerender(picker(false));
      view.rerender(picker(true));

      expect(search(screen.getByRole('dialog'))).toHaveValue('');
    });
  });

  describe('the keyboard can pick without the mouse', () => {
    it('has the search focused on open', () => {
      const { dialog } = show();

      expect(search(dialog)).toHaveFocus();
    });

    it.each([
      { situation: 'with no search', typed: '', picks: { inboxOf: 'ws' } },
      { situation: 'with a search', typed: 'pap', picks: { panel: 'p-papers' } },
    ])('Enter picks the first target $situation', async ({ typed, picks }) => {
      const { user, picked, dialog } = show({ alreadyOn: ['p-falcon', 'p-anna'] });
      if (typed) await user.type(search(dialog), typed);

      await user.type(search(dialog), '{Enter}');

      expect(picked).toEqual([picks]);
    });

    it('moves through the targets with ↓ and ↑, and back to the search from the first', async () => {
      const { user, dialog } = show({ alreadyOn: [] });

      await user.type(search(dialog), '{ArrowDown}');
      expect(within(dialog).getByRole('button', { name: 'Falcon' })).toHaveFocus();

      await user.keyboard('{ArrowDown}');
      expect(within(dialog).getByRole('button', { name: 'Anna' })).toHaveFocus();

      await user.keyboard('{ArrowUp}{ArrowUp}');
      expect(search(dialog)).toHaveFocus();
    });
  });

  describe('a dashboard is a heading, and the one you are on says so', () => {
    it('marks only the open dashboard as this dashboard', () => {
      const { dialog } = show();

      const headings = within(dialog).getAllByRole('heading', { level: 3 });
      expect(headings.find((h) => h.textContent?.startsWith('Today'))).toHaveTextContent('this dashboard');
      expect(headings.find((h) => h.textContent?.startsWith('Research'))).not.toHaveTextContent(
        'this dashboard',
      );
    });
  });
});
