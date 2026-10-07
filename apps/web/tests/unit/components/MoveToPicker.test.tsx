import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Dashboard, Panel } from '@cockpit/shared';
import { CommandRefused } from '../../../src/api/client';
import MoveToPicker, { type MoveTarget } from '../../../src/components/MoveToPicker';

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
    neverPropose: false,
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

    it('does not pick while Enter is confirming an IME composition', () => {
      const { picked, dialog } = show();

      fireEvent.keyDown(search(dialog), { key: 'Enter', isComposing: true });

      expect(picked).toEqual([]);
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

/** The + beside a dashboard's heading, which makes a panel on it. */
const plusOn = (dialog: HTMLElement, dashboard: string) =>
  within(dialog).getByRole('button', { name: `Add a panel to ${dashboard}` });

const nameField = (dialog: HTMLElement) =>
  within(dialog).getByRole('textbox', { name: /^Name of the new panel/ });

describe('Panels', () => {
  describe('every dashboard heading offers a new panel, except a dashboard filtered in this browser', () => {
    const onAddPanel = () => Promise.resolve('p-new');

    it.each([
      {
        situation: 'a dashboard with panels on offer',
        props: {},
        plusOn: ['Today', 'Research'],
      },
      {
        situation: 'a dashboard filtered in this browser has none, and its panels are still offered',
        props: { filteredDashboardIds: new Set([RESEARCH.id]) },
        plusOn: ['Today'],
      },
    ])('$situation', ({ props, plusOn: expected }) => {
      const { dialog } = show({ onAddPanel, ...props });

      const plusses = within(dialog)
        .queryAllByRole('button', { name: /^Add a panel to / })
        .map((button) => button.getAttribute('aria-label')?.replace('Add a panel to ', ''));
      expect(plusses).toEqual(expected);
      expect(within(dialog).getByRole('button', { name: 'To read' })).toBeVisible();
    });

    it('keeps the heading of a dashboard whose panels are all left out, and says so', () => {
      const { dialog } = show({
        onAddPanel,
        adding: true,
        dashboards: [TODAY],
        panels: [PANELS[0]!],
        alreadyOn: ['p-falcon'],
      });

      expect(within(dialog).getByRole('heading', { name: /Today/ })).toBeVisible();
      expect(within(dialog).getByText('Nowhere else on this dashboard.')).toBeVisible();
      expect(plusOn(dialog, 'Today')).toBeVisible();
    });

    it('carries one on a dashboard with no panel of items, which says there are none', () => {
      const { dialog } = show({
        onAddPanel,
        dashboards: [TODAY, EMPTY],
        panels: [PANELS[0]!, { ...aPanel('p-words', EMPTY.id, 'Notes'), kind: 'text' as const }],
      });

      expect(within(dialog).getByText('No panels yet.')).toBeVisible();
      expect(plusOn(dialog, 'Later')).toBeVisible();
    });

    it('carries one only on the headings a search shows', async () => {
      const { user, dialog } = show({ onAddPanel });

      await user.type(search(dialog), 'papers');

      expect(plusOn(dialog, 'Research')).toBeVisible();
      expect(within(dialog).queryByRole('button', { name: 'Add a panel to Today' })).toBeNull();
    });

    it('draws none where the picker is not handed a way to make one', () => {
      const { dialog } = show();

      expect(within(dialog).queryByRole('button', { name: /^Add a panel to / })).toBeNull();
    });
  });

  describe('naming a panel under a heading hands its name to be made, then picks it', () => {
    it.each([
      { situation: 'moving an item', props: {}, button: 'Add & move' },
      { situation: 'showing an item on another panel as well', props: { adding: true }, button: 'Add & show' },
      { situation: 'moving several items', props: { moving: { several: 3 } }, button: 'Add & move' },
    ])('$situation reads $button, makes the panel under that dashboard with the name trimmed, and picks it', async ({
      props,
      button,
    }) => {
      const onAddPanel = vi.fn((_dashboardId: string, _name: string) => Promise.resolve('p-new'));
      const { user, picked, dialog } = show({ onAddPanel, ...props });

      await user.click(plusOn(dialog, 'Research'));
      await user.type(nameField(dialog), '  Waiting on  ');
      await user.click(within(dialog).getByRole('button', { name: button }));

      expect(onAddPanel).toHaveBeenCalledWith('d-research', 'Waiting on');
      await waitFor(() => expect(picked).toEqual([{ panel: 'p-new' }]));
    });

    it('cannot be added while the name is blank, and takes no more than 60 characters', async () => {
      const { user, dialog } = show({ onAddPanel: () => Promise.resolve('p-new') });
      await user.click(plusOn(dialog, 'Today'));

      expect(within(dialog).getByRole('button', { name: 'Add & move' })).toBeDisabled();
      await user.type(nameField(dialog), '   ');
      expect(within(dialog).getByRole('button', { name: 'Add & move' })).toBeDisabled();
      await user.type(nameField(dialog), 'x'.repeat(70));
      expect(nameField(dialog)).toHaveValue(`   ${'x'.repeat(57)}`);
    });

    it('is sent once however often it is pressed while the first is in flight', async () => {
      let finish: (id: string) => void = () => undefined;
      const onAddPanel = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      );
      const { user, picked, dialog } = show({ onAddPanel });
      await user.click(plusOn(dialog, 'Today'));
      await user.type(nameField(dialog), 'Waiting on');

      await user.click(within(dialog).getByRole('button', { name: 'Add & move' }));
      fireEvent.submit(nameField(dialog).closest('form')!);
      fireEvent.submit(nameField(dialog).closest('form')!);
      finish('p-new');

      await waitFor(() => expect(picked).toEqual([{ panel: 'p-new' }]));
      expect(onAddPanel).toHaveBeenCalledTimes(1);
    });
  });

  describe('backing out closes the field, never the picker, and makes nothing', () => {
    it('closes the field from the ×, puts the + back, and makes nothing', async () => {
      const onAddPanel = vi.fn(() => Promise.resolve('p-new'));
      const { user, dialog } = show({ onAddPanel });
      await user.click(plusOn(dialog, 'Today'));

      await user.click(within(dialog).getByRole('button', { name: 'Do not add a panel to Today' }));

      expect(within(dialog).queryByRole('textbox', { name: /^Name of the new panel/ })).toBeNull();
      expect(plusOn(dialog, 'Today')).toHaveTextContent('+');
      expect(onAddPanel).not.toHaveBeenCalled();
    });

    it('closes only the field on Escape in it, and the picker on the next Escape', async () => {
      const onCancel = vi.fn();
      const { user, dialog } = show({ onAddPanel: () => Promise.resolve('p-new'), onCancel });
      await user.click(plusOn(dialog, 'Today'));
      await user.type(nameField(dialog), 'Wait');

      await user.keyboard('{Escape}');

      expect(within(dialog).queryByRole('textbox', { name: /^Name of the new panel/ })).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();

      await user.keyboard('{Escape}');
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('moves the field to the dashboard whose + is pressed next, one at a time', async () => {
      const { user, dialog } = show({ onAddPanel: () => Promise.resolve('p-new') });
      await user.click(plusOn(dialog, 'Today'));

      await user.click(plusOn(dialog, 'Research'));

      expect(within(dialog).getAllByRole('textbox', { name: /^Name of the new panel/ })).toHaveLength(1);
      expect(nameField(dialog)).toHaveAccessibleName('Name of the new panel on Research');
    });

    it('opens with no field, however it was left', async () => {
      const { user, dialog, view } = show({ onAddPanel: () => Promise.resolve('p-new') });
      await user.click(plusOn(dialog, 'Today'));
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
          onAddPanel={() => Promise.resolve('p-new')}
        />
      );

      view.rerender(picker(false));
      view.rerender(picker(true));

      expect(screen.queryByRole('textbox', { name: /^Name of the new panel/ })).toBeNull();
    });
  });

  describe('Enter and the arrow keys in the search reach only places an item can go', () => {
    it('makes and picks nothing on Enter over a search matching nothing', async () => {
      const onAddPanel = vi.fn(() => Promise.resolve('p-new'));
      const { user, picked, dialog } = show({ onAddPanel });

      await user.type(search(dialog), 'zzz{Enter}');

      expect(onAddPanel).not.toHaveBeenCalled();
      expect(picked).toEqual([]);
    });

    it('steps over the + buttons going down the list', async () => {
      const { user, dialog } = show({ onAddPanel: () => Promise.resolve('p-new'), alreadyOn: [] });

      await user.type(search(dialog), '{ArrowDown}');
      expect(within(dialog).getByRole('button', { name: 'Falcon' })).toHaveFocus();
      await user.keyboard('{ArrowDown}{ArrowDown}');

      expect(within(dialog).getByRole('button', { name: 'To read' })).toHaveFocus();
    });
  });

  describe('a refusal stays with the name it was about', () => {
    it.each([
      {
        situation: 'a name refused by the server',
        rejects: new CommandRefused(409, 'A panel with that name is already on this dashboard.'),
        says: 'A panel with that name is already on this dashboard.',
      },
      {
        situation: 'a request that never reached the server',
        rejects: new TypeError('Failed to fetch'),
        says: 'That did not reach the server. Try again.',
      },
    ])('$situation shows under the field, keeps the name, and files nothing', async ({ rejects, says }) => {
      const { user, picked, dialog } = show({ onAddPanel: () => Promise.reject(rejects) });
      await user.click(plusOn(dialog, 'Today'));
      await user.type(nameField(dialog), 'Falcon');

      await user.click(within(dialog).getByRole('button', { name: 'Add & move' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(says);
      expect(nameField(dialog)).toHaveValue('Falcon');
      expect(picked).toEqual([]);
      expect(screen.getByRole('dialog')).toBeVisible();
    });

    it('goes as soon as the name is edited', async () => {
      const { user, dialog } = show({
        onAddPanel: () => Promise.reject(new CommandRefused(409, 'Taken.')),
      });
      await user.click(plusOn(dialog, 'Today'));
      await user.type(nameField(dialog), 'Falcon');
      await user.click(within(dialog).getByRole('button', { name: 'Add & move' }));
      await within(dialog).findByRole('alert');

      await user.type(nameField(dialog), '2');

      expect(within(dialog).queryByRole('alert')).toBeNull();
    });
  });

  describe('password managers leave the name field alone', () => {
    it('asks the browser and the 1Password, LastPass and Bitwarden extensions to ignore it', async () => {
      const { user, dialog } = show({ onAddPanel: () => Promise.resolve('p-new') });

      await user.click(plusOn(dialog, 'Today'));

      const field = nameField(dialog);
      expect(field).toHaveAttribute('autocomplete', 'off');
      expect(field).toHaveAttribute('data-1p-ignore');
      expect(field).toHaveAttribute('data-lpignore', 'true');
      expect(field).toHaveAttribute('data-bwignore');
    });
  });
});
