import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PanelList } from '../../../src/components/PanelList';
import { readDashboardFilter, writeDashboardFilter } from '../../../src/dashboardFilter';
import type { DashboardFilter } from '../../../src/dashboardFilter';
import type { PanelListing } from '../../../src/panelList';
import type { Reach, ReachWorkspace } from '../../../src/panelReach';

/**
 * F1: what the column draws from what it is handed, the keys it holds once G
 * has shown it, and what its controls ask for. Which Panels the board hands it
 * is tests/unit/components/PanelBoard.test.tsx, that the shell draws it and
 * remembers it is tests/unit/pages/Layout.test.tsx, and where a jump lands the
 * page is tests/e2e/dashboards.test.ts, which needs a layout engine.
 */
type Row = [string, number | null, boolean?][];

function aListing(rows: Row[], jumpTo = vi.fn(), dashboardId = 'today'): PanelListing {
  return {
    dashboardId,
    jumpTo,
    rows: rows.map((row) =>
      row.map(([title, count, hidden]) => ({ panelId: `id-${title}`, title, count, hidden: hidden ?? false })),
    ),
  };
}

type Titles = [string, number | null, boolean?][];

/** A Workspace as the list reads it: its Dashboards, each with its Panels. */
function aWorkspace(
  id: string,
  name: string,
  dashboards: [string, string, Titles][],
  over: Partial<ReachWorkspace> = {},
): ReachWorkspace {
  return {
    id,
    name,
    color: '#6f62b5',
    state: 'ready',
    dashboardCount: dashboards.length,
    dashboards: dashboards.map(([dashboardId, dashboardName, titles]) => ({
      id: dashboardId,
      name: dashboardName,
      entries: titles.map(([title, count, hidden]) => ({ panelId: `id-${title}`, title, count, hidden: hidden ?? false })),
    })),
    ...over,
  };
}

const WORK = () =>
  aWorkspace('work', 'Work', [
    ['today', 'Today', [['One', 1], ['Two', 2]]],
    ['research', 'Research', [['Papers', 4], ['Notes', null]]],
  ]);
const HOME = () => aWorkspace('home', 'Home', [['chores', 'Chores', [['Bins', 0]]]]);

function aReach(over: Partial<Reach> = {}): Reach {
  // One Workspace with one Dashboard unless a case wants more to reach.
  return {
    workspaceId: 'today-ws',
    dashboardId: 'today',
    workspaces: [aWorkspace('today-ws', 'Work', [['today', 'Today', [['One', 1]]]])],
    ask: vi.fn(),
    go: vi.fn(),
    ...over,
  };
}

/** Two Workspaces, the first with two Dashboards, standing on Today. */
const wide = (over: Partial<Reach> = {}) => aReach({ workspaceId: 'work', workspaces: [WORK(), HOME()], ...over });

/** The column with its shown-or-hidden held the way the shell holds it. */
function Held({ listing, startsHidden = true, onHide, reach = aReach(), rowWidth = 1200 }: { listing: PanelListing | null; startsHidden?: boolean; onHide?: (hidden: boolean) => void; reach?: Reach; rowWidth?: number }) {
  const [hidden, setHidden] = useState(startsHidden);
  return (
    <PanelList
      listing={listing}
      reach={reach}
      rowWidth={rowWidth}
      collapsed={hidden}
      onCollapse={(next) => {
        onHide?.(next);
        setHidden(next);
      }}
    />
  );
}

const shownList = () => screen.queryByRole('complementary', { name: 'Go to panel' });
const strip = () => screen.queryByRole('button', { name: 'Open Go to panel' });
const search = () => screen.getByRole('searchbox', { name: 'Search Panels' });
const entry = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
/** The entry the keys have highlighted, by its title. */
const highlighted = () =>
  within(shownList()!)
    .queryAllByRole('button')
    .filter((button) => button.hasAttribute('data-current'))
    .map((button) => button.textContent);

let scroller: HTMLElement;

beforeEach(() => {
  scroller = document.body.appendChild(document.createElement('div'));
  scroller.setAttribute('data-drag-scroll', 'dashboard');
  scroller.scrollTop = 120;
  localStorage.clear();
});
afterEach(() => scroller.remove());

const three = (jumpTo = vi.fn()) => aListing([[['One', 1], ['Two', 2]], [['Three', 3]]], jumpTo);

describe('Dashboards', () => {
  describe('the column is Go to panel, with a strip when hidden, and both controls name G', () => {
    it('hides from » and shows from the strip, both saying G', async () => {
      const user = userEvent.setup();
      const onHide = vi.fn();
      render(<Held listing={three()} startsHidden={false} onHide={onHide} />);

      const hide = screen.getByRole('button', { name: 'Hide Go to panel' });
      expect(hide).toHaveAttribute('title', 'Hide Go to panel (G)');
      expect(screen.getByRole('heading', { name: 'Go to panel' })).toBeInTheDocument();
      await user.click(hide);
      expect(onHide).toHaveBeenLastCalledWith(true);

      expect(strip()).toHaveAttribute('title', 'Go to panel: G on this Dashboard, Shift+G on its Workspace');
      expect(strip()).toHaveTextContent('Go to panel');
      expect(strip()).toHaveTextContent('G');
      expect(strip()).toHaveTextContent('⇧G');
      await user.click(strip()!);
      expect(onHide).toHaveBeenLastCalledWith(false);
      expect(shownList()).not.toBeNull();
    });

    it('names its keys in a legend at its foot', () => {
      render(<Held listing={three()} startsHidden={false} />);

      expect(shownList()).toHaveTextContent('Enter');
      expect(shownList()).toHaveTextContent('Esc');
      expect(shownList()).toHaveTextContent('⇧G');
      expect(shownList()).not.toHaveTextContent('Space');
      expect(shownList()).not.toHaveTextContent('1 2 3');
    });

    it('wears the attribute that earns a mouse click the shortcut tip', () => {
      const { unmount } = render(<Held listing={three()} startsHidden={false} />);
      expect(screen.getByRole('button', { name: 'Hide Go to panel' })).toHaveAttribute('data-shortcut-tip', 'panels');
      unmount();
      render(<Held listing={three()} />);
      expect(strip()).toHaveAttribute('data-shortcut-tip', 'panels');
    });
  });

  describe('G and Shift+G show Go to panel on a scope with the cursor in the box, and the same key hides it', () => {
    const chosen = () =>
      within(screen.getByRole('group', { name: 'Search in' }))
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-pressed') === 'true')
        .map((button) => button.textContent);

    it.each([
      { situation: 'G', keys: 'g', reach: wide(), scope: 'Dashboard' },
      { situation: 'Shift+G on a Workspace with two Dashboards', keys: '{Shift>}G{/Shift}', reach: wide(), scope: 'Workspace' },
      { situation: 'Shift+G on a Workspace with one Dashboard', keys: '{Shift>}G{/Shift}', reach: aReach(), scope: 'Dashboard' },
    ])('shows it on the scope $scope for $situation, the cursor in the box, nothing highlighted', async ({ keys, reach, scope }) => {
      const user = userEvent.setup();
      render(<Held listing={three()} reach={reach} />);

      await user.keyboard(keys);

      expect(shownList()).not.toBeNull();
      expect(chosen()).toEqual([scope]);
      expect(search()).toHaveFocus();
      expect(highlighted()).toEqual([]);
    });

    it('keeps Workspace unavailable where its Workspace has one Dashboard', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);

      await user.keyboard('{Shift>}G{/Shift}');

      expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('hides on the key of the scope it is open on, from the page, and ignores P', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} reach={wide()} />);

      await user.keyboard('p');
      expect(shownList()).toBeNull();

      await user.keyboard('g');
      await user.click(document.body);
      await user.keyboard('g');
      expect(shownList()).toBeNull();

      await user.keyboard('{Shift>}G{/Shift}');
      await user.click(document.body);
      await user.keyboard('{Shift>}G{/Shift}');
      expect(shownList()).toBeNull();
    });

    it('switches scope on the other key from the page, keeping what was typed', async () => {
      const user = userEvent.setup();
      const reach = wide();
      render(<Held listing={three()} reach={reach} />);
      await user.keyboard('g');
      await user.keyboard('adm');
      await user.click(document.body);

      await user.keyboard('{Shift>}G{/Shift}');

      expect(chosen()).toEqual(['Workspace']);
      expect(search()).toHaveValue('adm');
      expect(search()).toHaveFocus();
      expect(reach.ask).toHaveBeenLastCalledWith(2);

      await user.click(document.body);
      await user.keyboard('g');
      expect(chosen()).toEqual(['Dashboard']);
      expect(search()).toHaveValue('adm');
    });

    it('takes G and Shift+G as letters in the box, and the column stays on its scope', async () => {
      const user = userEvent.setup();
      render(<Held listing={aListing([[['Budget', 1], ['Other', 2]]])} reach={wide()} />);
      await user.keyboard('g');

      await user.keyboard('gG');

      expect(search()).toHaveValue('gG');
      expect(shownList()).not.toBeNull();
      expect(chosen()).toEqual(['Dashboard']);
    });

    it.each([
      { situation: 'typing in a field elsewhere', keys: 'g', field: true },
      { situation: 'a window open over the page', keys: 'g', field: false, dialog: true },
      { situation: 'Ctrl held', keys: '{Control>}g{/Control}', field: false },
      { situation: 'Alt held', keys: '{Alt>}g{/Alt}', field: false },
      { situation: '⌘ held', keys: '{Meta>}g{/Meta}', field: false },
    ])('does nothing for $situation', async ({ keys, field, dialog }) => {
      const user = userEvent.setup();
      render(
        <>
          <input aria-label="A box" />
          <Held listing={three()} />
        </>,
      );
      const covering = dialog ? document.body.appendChild(document.createElement('div')) : null;
      covering?.setAttribute('role', 'dialog');
      if (field) await user.click(screen.getByRole('textbox', { name: 'A box' }));

      await user.keyboard(keys);
      covering?.remove();

      expect(shownList()).toBeNull();
    });

    it('puts the cursor in the box on a click on the column outside its controls, so 1, 2 and 3 are letters and no scope', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} reach={wide()} startsHidden={false} />);
      await user.click(shownList()!.querySelector('[tabindex="-1"]') as HTMLElement);

      expect(search()).toHaveFocus();
      await user.keyboard('123');

      expect(chosen()).toEqual(['Dashboard']);
      expect(search()).toHaveValue('123');
    });
  });

  describe('typing narrows the list at once, ↓ starts the highlight, and Enter takes the highlight or the top match', () => {
    it('highlights the first entry on the first ↓, then ↓ and ↑ move it and ask the board to jump', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} />);

      await user.keyboard('g');
      expect(highlighted()).toEqual([]);
      expect(jumpTo).not.toHaveBeenCalled();

      await user.keyboard('{ArrowDown}');
      expect(highlighted()).toEqual(['One1']);
      expect(jumpTo).toHaveBeenLastCalledWith('id-One');

      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(highlighted()).toEqual(['Three3']);
      expect(jumpTo).toHaveBeenLastCalledWith('id-Three');

      await user.keyboard('{ArrowUp}');
      expect(highlighted()).toEqual(['Two2']);
      expect(jumpTo).toHaveBeenLastCalledWith('id-Two');
    });

    it.each([
      { situation: '↑ with nothing highlighted', keys: '{ArrowUp}', stays: [] },
      { situation: '↑ on the first', keys: '{ArrowDown}{ArrowUp}', stays: ['One1'] },
      { situation: '↓ on the last', keys: '{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}', stays: ['Three3'] },
    ])('$situation stays where it is', async ({ keys, stays }) => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);

      await user.keyboard('g');
      await user.keyboard(keys);

      expect(highlighted()).toEqual(stays);
    });

    it('goes to the top match on Enter with nothing highlighted, and ends the mode, hiding the column', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} />);

      await user.keyboard('g');
      await user.keyboard('tw{Enter}');

      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Two');
      expect(shownList()).toBeNull();
    });

    it('goes to the highlighted Panel on Enter, not the top match', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={aListing([[['Admin', 1], ['Adm two', 2], ['Other', 3]]], jumpTo)} />);

      await user.keyboard('g');
      await user.keyboard('adm{ArrowDown}{ArrowDown}');
      jumpTo.mockClear();
      await user.keyboard('{Enter}');

      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Adm two');
    });

    it('does nothing on Enter where nothing matches, and the column stays', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} />);

      await user.keyboard('g');
      await user.keyboard('zzz{Enter}');

      expect(jumpTo).not.toHaveBeenCalled();
      expect(shownList()).not.toBeNull();
    });

    it('takes a Space in the box as a space in the search', async () => {
      const user = userEvent.setup();
      render(<Held listing={aListing([[['Big one', 1], ['Bigger', 2]]])} />);

      await user.keyboard('g');
      await user.keyboard('big o');

      expect(search()).toHaveValue('big o');
      expect(screen.getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Big one1']);
    });

    it.each([
      { situation: 'a click', hidden: false },
      { situation: 'a click on a column G showed', hidden: true },
    ])('goes to the Panel $situation names, hides the column and leaves the screen there', async ({ hidden }) => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} startsHidden={hidden} />);

      if (hidden) await user.keyboard('g');
      await user.click(entry('Three'));

      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Three');
      expect(shownList()).toBeNull();
    });

    it('hides the column that the strip opened on Enter', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} />);

      await user.click(strip()!);
      await user.click(search());
      await user.keyboard('thr{Enter}');

      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Three');
      expect(shownList()).toBeNull();
    });

    it('scrolls a highlighted entry below the list’s fold into view', async () => {
      const user = userEvent.setup();
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      try {
        render(<Held listing={three()} />);

        await user.keyboard('g{ArrowDown}{ArrowDown}');

        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
        expect(scrollIntoView.mock.contexts.at(-1)).toBe(entry('Two'));
      } finally {
        // @ts-expect-error jsdom has none; this put it back as it was.
        delete Element.prototype.scrollIntoView;
      }
    });
  });

  describe('the search narrows the list by Panel name', () => {
    it('narrows as you type in any capitalisation, with nothing highlighted until ↓', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);
      await user.keyboard('g');

      await user.keyboard('TH');

      expect(screen.getAllByRole('button').map((button) => button.textContent)).toContain('Three3');
      expect(screen.queryByRole('button', { name: /^One/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Two/ })).toBeNull();
      expect(highlighted()).toEqual([]);
      await user.keyboard('{ArrowDown}');
      expect(highlighted()).toEqual(['Three3']);
    });

    it('says so when nothing matches', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);

      await user.keyboard('g');
      await user.keyboard('zzz');

      expect(screen.getByText('No Panel matches.')).toBeInTheDocument();
    });

    it('starts every G with an empty search, whatever was left in the box', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);
      await user.keyboard('g');
      await user.keyboard('tw');
      await user.click(document.body);
      expect(search()).toHaveValue('tw');

      await user.keyboard('g');
      await user.keyboard('g');

      expect(search()).toHaveValue('');
      expect(screen.getByRole('button', { name: /^One/ })).toBeInTheDocument();
    });

    it('keeps the text and the scope when the box is clicked into again', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} reach={wide()} />);
      await user.keyboard('{Shift>}G{/Shift}');
      await user.keyboard('pap');
      await user.click(document.body);

      await user.click(search());

      expect(search()).toHaveValue('pap');
      expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('Esc puts the Dashboard back where the mode began and hides the column, whatever opened it', () => {
    /** A board whose jump moves the scroller, as the real one does. */
    const jumping = () => three(vi.fn(() => void (scroller.scrollTop = 900)));

    it('restores the scroll from before G and hides the column on Esc from the box, after moving about', async () => {
      const user = userEvent.setup();
      render(<Held listing={jumping()} />);

      await user.keyboard('g{ArrowDown}{ArrowDown}');
      expect(scroller.scrollTop).toBe(900);
      await user.keyboard('{Escape}');

      expect(scroller.scrollTop).toBe(120);
      expect(shownList()).toBeNull();
    });

    it('restores the scroll and hides a column opened with «, clicked into, on Esc', async () => {
      const user = userEvent.setup();
      render(<Held listing={jumping()} startsHidden={false} />);

      await user.click(shownList()!.querySelector('[tabindex="-1"]') as HTMLElement);
      await user.keyboard('{ArrowDown}');
      expect(scroller.scrollTop).toBe(900);
      await user.keyboard('{Escape}');

      expect(scroller.scrollTop).toBe(120);
      expect(shownList()).toBeNull();
    });

    it('hides the column on Esc, and clears the search for the next time', async () => {
      const user = userEvent.setup();
      render(<Held listing={jumping()} startsHidden={false} />);
      await user.click(search());
      await user.keyboard('tw');

      await user.keyboard('{Escape}');
      expect(shownList()).toBeNull();

      await user.click(strip()!);
      expect(search()).toHaveValue('');
    });
  });


  describe('a Panel the Dashboard filter hides is listed, and going to it clears the filter', () => {
    const filter: DashboardFilter = { ...readDashboardFilter(undefined, 'today'), text: 'vat' };
    const withAHiddenOne = (jumpTo = vi.fn()) =>
      aListing([[['Drawn', 2], ['Hidden', 0, true]]], jumpTo);

    it('draws the hidden entry faint, marked filtered, and counted with the rest', () => {
      render(<Held listing={withAHiddenOne()} startsHidden={false} />);

      expect(entry('Hidden')).toHaveTextContent('filtered');
      expect(entry('Hidden')).not.toHaveTextContent('0');
      expect(entry('Hidden').className).toContain('text-ink-faint');
      expect(entry('Drawn')).not.toHaveTextContent('filtered');
    });

    it('clears the filter on Enter, and jumps once the board draws the Panel', async () => {
      const user = userEvent.setup();
      writeDashboardFilter(localStorage, 'today', filter);
      const jumpTo = vi.fn();
      const { rerender } = render(<Held listing={withAHiddenOne(jumpTo)} />);
      await user.keyboard('g{ArrowDown}{ArrowDown}');
      expect(jumpTo).not.toHaveBeenCalledWith('id-Hidden');
      jumpTo.mockClear();

      await user.keyboard('{Enter}');

      expect(readDashboardFilter(localStorage, 'today').text).toBe('');
      expect(jumpTo).not.toHaveBeenCalled();
      rerender(<Held listing={aListing([[['Drawn', 2], ['Hidden', 5]]], jumpTo)} startsHidden={false} />);
      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Hidden');
    });

    it('drops a pending jump when the mode begins again', async () => {
      const user = userEvent.setup();
      writeDashboardFilter(localStorage, 'today', filter);
      const jumpTo = vi.fn();
      const { rerender } = render(<Held listing={withAHiddenOne(jumpTo)} />);
      await user.keyboard('g{ArrowDown}{ArrowDown}{Enter}');
      jumpTo.mockClear();

      await user.keyboard('g');
      rerender(<Held listing={aListing([[['Drawn', 2], ['Hidden', 5]]], jumpTo)} startsHidden={false} />);

      expect(jumpTo).not.toHaveBeenCalled();
    });

    it('keeps the filter on Enter on a Panel that is drawn', async () => {
      const user = userEvent.setup();
      writeDashboardFilter(localStorage, 'today', filter);
      const jumpTo = vi.fn();
      render(<Held listing={withAHiddenOne(jumpTo)} />);

      await user.keyboard('g{Enter}');

      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Drawn');
      expect(readDashboardFilter(localStorage, 'today').text).toBe('vat');
    });
  });

  describe('the column draws what the board hands it, a row at a time', () => {
    it('lists the entries row by row, with a hairline between rows only, and a Panel of text without a count', () => {
      render(<Held listing={aListing([[['One', 3]], [['Two', 0], ['Notes', null]], [['Three', 12]]])} startsHidden={false} />);

      const rows = screen.getAllByRole('list');
      expect(rows.map((row) => within(row).getAllByRole('button').map((b) => b.textContent))).toEqual([
        ['One3'],
        ['Two0', 'Notes'],
        ['Three12'],
      ]);
      expect(rows.map((row) => row.className.includes('border-b'))).toEqual([true, true, false]);
    });

    it('says there are none on a Dashboard with no Panels, and nothing before the board has been read', () => {
      const { unmount } = render(<Held listing={aListing([])} startsHidden={false} />);
      expect(screen.getByText('No Panels on this Dashboard.')).toBeInTheDocument();
      unmount();

      render(<Held listing={null} startsHidden={false} />);
      expect(screen.queryByText('No Panels on this Dashboard.')).toBeNull();
      expect(screen.queryByText('No Panel matches.')).toBeNull();
    });

    it('cuts a long name short', () => {
      render(<Held listing={aListing([[['A name so long that it would never fit in a column of this width', 1]]])} startsHidden={false} />);

      expect(screen.getByText('A name so long that it would never fit in a column of this width').className).toContain('truncate');
    });
  });

  describe('an entry in the column cannot be picked up, so dragging on the board is the one way to rearrange', () => {
    it('draws no entry draggable and none with a grab cursor', () => {
      render(<Held listing={three()} startsHidden={false} />);

      for (const item of screen.getAllByRole('listitem')) {
        expect(item.getAttribute('draggable')).not.toBe('true');
        expect(within(item).getByRole('button').className).not.toContain('cursor-grab');
      }
    });
  });

  describe('Go to panel searches the Workspace or every Workspace, and the screen follows the highlight', () => {
    const todays = (jumpTo = vi.fn()) => aListing([[['One', 1], ['Two', 2]]], jumpTo);
    const researchs = (jumpTo = vi.fn(), hiddenPapers = false) =>
      aListing([[['Papers', 4, hiddenPapers], ['Notes', null]]], jumpTo, 'research');
    const pressed = () =>
      within(screen.getByRole('group', { name: 'Search in' }))
        .getAllByRole('button')
        .filter((button) => button.getAttribute('aria-pressed') === 'true')
        .map((button) => button.textContent);
    const headings = (level: number) =>
      screen.queryAllByRole('heading', { level }).map((heading) => heading.textContent);
    const calls = (go: Reach['go']) => vi.mocked(go).mock.calls.map(([to, how]) => [to.dashboardId, how]);
    /** G, then a click on All: the one scope with no key of its own. */
    const openAll = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.keyboard('g');
      await user.click(screen.getByRole('button', { name: 'All' }));
    };

    describe('the scope is chosen by its key or the switch, and one that adds nothing is unavailable', () => {
      it('shows the chosen scope on the switch, asks the reach to read it, and starts every G on Dashboard', async () => {
        const user = userEvent.setup();
        const reach = wide();
        render(<Held listing={todays()} reach={reach} />);

        await user.keyboard('g');
        expect(pressed()).toEqual(['Dashboard']);
        await user.click(document.body);
        await user.keyboard('{Shift>}G{/Shift}');
        expect(pressed()).toEqual(['Workspace']);
        expect(headings(4)).toEqual(['Today', 'Research']);
        expect(reach.ask).toHaveBeenLastCalledWith(2);
        await user.click(screen.getByRole('button', { name: 'All' }));
        expect(pressed()).toEqual(['All']);
        expect(reach.ask).toHaveBeenLastCalledWith(3);
        await user.click(document.body);
        await user.keyboard('g');
        expect(pressed()).toEqual(['Dashboard']);
        expect(reach.ask).toHaveBeenLastCalledWith(1);

        await user.click(screen.getByRole('button', { name: 'All' }));
        await user.keyboard('{Enter}');
        await user.keyboard('g');
        expect(pressed()).toEqual(['Dashboard']);
        expect(reach.ask).toHaveBeenLastCalledWith(1);
      });

      it('stops asking for other Workspaces once the column is hidden from its own button', async () => {
        const user = userEvent.setup();
        const reach = wide();
        render(<Held listing={todays()} reach={reach} />);
        await openAll(user);
        expect(reach.ask).toHaveBeenLastCalledWith(3);

        await user.click(screen.getByRole('button', { name: 'Hide Go to panel' }));
        expect(reach.ask).toHaveBeenLastCalledWith(1);
      });

      it('chooses the scope from a click and the box keeps the keys', async () => {
        const user = userEvent.setup();
        render(<Held listing={todays()} reach={wide()} />);
        await user.keyboard('g');

        await user.click(screen.getByRole('button', { name: 'All' }));
        expect(pressed()).toEqual(['All']);
        expect(search()).toHaveFocus();
        await user.keyboard('{ArrowDown}');

        expect(highlighted()).toEqual(['One1']);
      });

      it.each([
        { situation: 'a Workspace with one Dashboard', open: '{Shift>}G{/Shift}', unavailable: 'Workspace', reason: 'Only one Dashboard in this Workspace' },
        { situation: 'an account with one Workspace', open: 'g', unavailable: 'All', reason: 'Only one Workspace' },
      ])('leaves $situation visible, unavailable and saying why, and a click does nothing', async ({ open, unavailable, reason }) => {
        const user = userEvent.setup();
        render(<Held listing={todays()} />);
        await user.keyboard(open);

        const segment = screen.getByRole('button', { name: unavailable });
        expect(segment).toHaveAttribute('aria-disabled', 'true');
        expect(segment).toHaveAttribute('title', reason);
        await user.click(segment);

        expect(pressed()).toEqual(['Dashboard']);
      });

      it('names each key in its tooltip', () => {
        render(<Held listing={todays()} reach={wide()} startsHidden={false} />);

        expect(screen.getByRole('button', { name: 'Dashboard' })).toHaveAttribute('title', 'Search this Dashboard (G)');
        expect(screen.getByRole('button', { name: 'Workspace' })).toHaveAttribute('title', 'Search every Dashboard of Work (Shift+G)');
        expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('title', 'Search every Workspace');
      });
    });

    describe('wider scopes group by Dashboard, and by Workspace above it, in tab order', () => {
      it('draws a pinned heading per Dashboard over its indented Panels, in Workspace', async () => {
        const user = userEvent.setup();
        render(<Held listing={todays()} reach={wide()} />);
        await user.keyboard('{Shift>}G{/Shift}');

        expect(headings(4)).toEqual(['Today', 'Research']);
        expect(headings(3)).toEqual([]);
        const research = screen.getByRole('heading', { name: 'Research' });
        expect(research.className).toContain('sticky');
        expect(research.closest('li')).toBeNull();
        expect(
          within(research.nextElementSibling as HTMLElement)
            .getAllByRole('button')
            .map((b) => b.textContent),
        ).toEqual(['Papers4', 'Notes']);
      });

      it('draws a pinned heading per Workspace with its colour, above its Dashboards, in All', async () => {
        const user = userEvent.setup();
        render(<Held listing={todays()} reach={wide()} />);
        await openAll(user);

        expect(headings(3)).toEqual(['Work', 'Home']);
        expect(headings(4)).toEqual(['Today', 'Research', 'Chores']);
        const work = screen.getByRole('heading', { name: 'Work' });
        expect(work.className).toContain('sticky');
        expect(work.className).toContain('uppercase');
        expect(work.firstElementChild).toHaveStyle({ backgroundColor: '#6f62b5' });
        expect(entry('Bins')).toHaveTextContent('0');
        expect(entry('Notes')).toHaveTextContent(/^Notes$/);
      });
    });

    describe('the search matches a name at every level of the scope', () => {
      it.each([
        { situation: 'a Dashboard’s name in Workspace', open: '{Shift>}G{/Shift}', typed: 'research', shown: ['Papers4', 'Notes'] },
        { situation: 'a Workspace’s name in All', open: 'all', typed: 'home', shown: ['Bins0'] },
        { situation: 'a Panel’s own name in All', open: 'all', typed: 'papers', shown: ['Papers4'] },
      ])('keeps every Panel under $situation', async ({ open, typed, shown }) => {
        const user = userEvent.setup();
        render(<Held listing={todays()} reach={wide()} />);
        if (open === 'all') await openAll(user);
        else await user.keyboard(open);

        await user.keyboard(typed);

        expect(
          within(shownList()!)
            .getAllByRole('listitem')
            .map((row) => row.textContent),
        ).toEqual(shown);
      });

      it('matches only Panels whose own name matches, in Dashboard', async () => {
        const user = userEvent.setup();
        render(<Held listing={todays()} reach={wide()} />);

        await user.keyboard('g');
        await user.keyboard('today');

        expect(screen.getByText('No Panel matches.')).toBeInTheDocument();
      });
    });

    describe('the screen follows the highlight, and Esc puts it back', () => {
      it('shows the other Dashboard on a move onto its Panel, adding one history entry, and jumps once its board draws', async () => {
        const user = userEvent.setup();
        const reach = wide();
        const jumpTo = vi.fn();
        const { rerender } = render(<Held listing={todays()} reach={reach} />);

        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}');

        expect(highlighted()).toEqual(['Papers4']);
        expect(calls(reach.go)).toEqual([['research', 'push']]);
        expect(jumpTo).not.toHaveBeenCalled();
        rerender(<Held listing={researchs(jumpTo)} reach={reach} />);
        expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Papers');
      });

      it('replaces that entry on every move after, across Workspaces too', async () => {
        const user = userEvent.setup();
        const reach = wide();
        render(<Held listing={todays()} reach={reach} />);

        await openAll(user);
        await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');

        expect(highlighted()).toEqual(['Bins0']);
        // Papers to Notes stays on Research, which moves nothing.
        expect(calls(reach.go)).toEqual([
          ['research', 'push'],
          ['chores', 'replace'],
        ]);
        expect(vi.mocked(reach.go).mock.calls.at(-1)![0]).toMatchObject({ workspaceId: 'home' });
      });

      it('jumps at once on a move within the Dashboard now shown', async () => {
        const user = userEvent.setup();
        const reach = wide({
          dashboardId: 'research',
          workspaces: [
            aWorkspace('work', 'Work', [
              ['research', 'Research', [['Papers', 4], ['Notes', null]]],
              ['today', 'Today', [['One', 1]]],
            ]),
            HOME(),
          ],
        });
        const jumpTo = vi.fn();
        render(<Held listing={researchs(jumpTo)} reach={reach} />);

        await user.keyboard('{Shift>}G{/Shift}');
        await user.keyboard('{ArrowDown}{ArrowDown}');

        expect(jumpTo).toHaveBeenLastCalledWith('id-Notes');
        expect(reach.go).not.toHaveBeenCalled();
      });

      it('puts the starting Dashboard and its scroll back on Esc after crossing, and adds nothing', async () => {
        const user = userEvent.setup();
        const reach = wide();
        const { rerender } = render(<Held listing={todays()} reach={reach} />);
        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}');
        rerender(<Held listing={researchs()} reach={reach} />);
        scroller.scrollTop = 900;

        await user.keyboard('{Escape}');

        expect(calls(reach.go)).toEqual([['research', 'push'], ['today', 'back']]);
        expect(shownList()).toBeNull();
        expect(scroller.scrollTop).toBe(900);
        rerender(<Held listing={todays()} reach={reach} />);
        expect(scroller.scrollTop).toBe(120);
      });

      it('stays on the Panel on Enter after crossing, with the one entry added and the mode ended', async () => {
        const user = userEvent.setup();
        const reach = wide();
        const jumpTo = vi.fn();
        const { rerender } = render(<Held listing={todays()} reach={reach} />);
        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}');

        await user.keyboard('{Enter}');
        rerender(<Held listing={researchs(jumpTo)} reach={reach} />);

        expect(calls(reach.go)).toEqual([['research', 'push']]);
        expect(shownList()).toBeNull();
        expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Papers');
      });

      it('goes back over the added entry on Enter at a Panel of the Dashboard G was pressed on', async () => {
        const user = userEvent.setup();
        const reach = wide();
        render(<Held listing={todays()} reach={reach} />);

        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');

        expect(calls(reach.go)).toEqual([['research', 'push'], ['today', 'replace'], ['today', 'back']]);
      });

      it('adds an entry again on the next G', async () => {
        const user = userEvent.setup();
        const reach = wide();
        render(<Held listing={todays()} reach={reach} />);

        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');

        expect(calls(reach.go).map(([, how]) => how)).toEqual(['push', 'push']);
      });
    });

    describe('a Panel hidden by its own Dashboard’s filter is marked, and going clears that filter only', () => {
      const hiding = () =>
        wide({
          workspaces: [
            aWorkspace('work', 'Work', [
              ['today', 'Today', [['One', 1], ['Two', 2]]],
              ['research', 'Research', [['Papers', 0, true], ['Notes', null]]],
            ]),
            HOME(),
          ],
        });

      it('lists the other Dashboard’s hidden Panel as filtered', async () => {
        const user = userEvent.setup();
        render(<Held listing={todays()} reach={hiding()} />);

        await user.keyboard('{Shift>}G{/Shift}');

        expect(entry('Papers')).toHaveTextContent('filtered');
        expect(entry('Notes')).not.toHaveTextContent('filtered');
      });

      it('clears the filter of that Dashboard on Enter, keeps the one G was pressed on, and jumps once drawn', async () => {
        const user = userEvent.setup();
        const reach = hiding();
        const jumpTo = vi.fn();
        writeDashboardFilter(localStorage, 'today', { ...readDashboardFilter(undefined, 'today'), text: 'one' });
        writeDashboardFilter(localStorage, 'research', { ...readDashboardFilter(undefined, 'research'), text: 'zzz' });
        const { rerender } = render(<Held listing={todays()} reach={reach} />);

        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');

        expect(readDashboardFilter(localStorage, 'research').text).toBe('');
        expect(readDashboardFilter(localStorage, 'today').text).toBe('one');
        expect(calls(reach.go)).toEqual([['research', 'push']]);
        rerender(<Held listing={researchs(jumpTo)} reach={reach} />);
        expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Papers');
      });

      it('shows the Dashboard of a hidden Panel on a move onto it, but does not clear its filter or jump', async () => {
        const user = userEvent.setup();
        const reach = hiding();
        const jumpTo = vi.fn();
        writeDashboardFilter(localStorage, 'research', { ...readDashboardFilter(undefined, 'research'), text: 'zzz' });
        const { rerender } = render(<Held listing={todays()} reach={reach} />);

        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}');
        rerender(<Held listing={researchs(jumpTo, true)} reach={reach} />);

        expect(calls(reach.go)).toEqual([['research', 'push']]);
        expect(readDashboardFilter(localStorage, 'research').text).toBe('zzz');
        expect(jumpTo).not.toHaveBeenCalled();
      });
    });

    describe('a list changed underneath keeps a valid highlight', () => {
      it('moves the highlight to the entry now in the place of one deleted, and to the new last when the last go', async () => {
        const user = userEvent.setup();
        const { rerender } = render(<Held listing={todays()} reach={wide()} />);
        await user.keyboard('{Shift>}G{/Shift}{ArrowDown}{ArrowDown}{ArrowDown}');
        expect(highlighted()).toEqual(['Papers4']);

        const withoutPapers = wide({
          workspaces: [
            aWorkspace('work', 'Work', [
              ['today', 'Today', [['One', 1], ['Two', 2]]],
              ['research', 'Research', [['Notes', null]]],
            ]),
            HOME(),
          ],
        });
        rerender(<Held listing={todays()} reach={withoutPapers} />);
        expect(highlighted()).toEqual(['Notes']);

        const onlyToday = wide({
          workspaces: [aWorkspace('work', 'Work', [['today', 'Today', [['One', 1], ['Two', 2]]]]), HOME()],
        });
        rerender(<Held listing={todays()} reach={onlyToday} />);
        expect(highlighted()).toEqual(['Two2']);
      });
    });

    describe('a Workspace not yet read, or that failed to load, keeps its heading', () => {
      it.each([
        { situation: 'still loading', state: 'loading' as const, line: 'Loading…' },
        { situation: 'that failed to load', state: 'failed' as const, line: 'Could not be read.' },
      ])('says so under the heading of a Workspace $situation, and lists the rest', async ({ state, line }) => {
        const user = userEvent.setup();
        const reach = wide({ workspaces: [WORK(), aWorkspace('home', 'Home', [], { state, dashboards: [] })] });
        render(<Held listing={todays()} reach={reach} />);

        await openAll(user);

        expect(headings(3)).toEqual(['Work', 'Home']);
        expect(screen.getByText(line)).toBeInTheDocument();
        expect(entry('Papers')).toBeInTheDocument();
      });
    });
  });
  describe('the column is resized by dragging its left edge, and a double-click puts it back', () => {
    const edge = () => screen.getByRole('separator', { name: /resize Go to panel/ });
    const drawnWidth = () => shownList()!.style.width;

    /** jsdom lays nothing out, so the column reports the width it was last drawn at. */
    function measured() {
      return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return { width: parseFloat(this.style.width) || 0 } as DOMRect;
      });
    }

    function drag(from: number, to: number) {
      fireEvent.pointerDown(edge(), { pointerId: 1, button: 0, clientX: from });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: to });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: to });
    }

    afterEach(() => vi.restoreAllMocks());

    it('draws at 224px until dragged', () => {
      render(<Held listing={three()} startsHidden={false} />);
      expect(drawnWidth()).toBe('224px');
    });

    it.each([
      { situation: 'dragging the edge left widens it as the pointer goes', to: 700, width: '324px' },
      { situation: 'dragging it right narrows it, but never under 224px', to: 900, width: '224px' },
      { situation: 'dragging far left stops at a third of the row', to: -500, width: '400px' },
    ])('$situation', ({ to, width }) => {
      measured();
      render(<Held listing={three()} startsHidden={false} rowWidth={1200} />);
      drag(800, to);
      expect(drawnWidth()).toBe(width);
    });

    it('keeps 224px in a row so narrow that a third of it is less', () => {
      measured();
      render(<Held listing={three()} startsHidden={false} rowWidth={600} />);
      drag(800, 100);
      expect(drawnWidth()).toBe('224px');
    });

    it('follows the pointer while the drag is still held', () => {
      measured();
      render(<Held listing={three()} startsHidden={false} />);
      fireEvent.pointerDown(edge(), { pointerId: 1, button: 0, clientX: 800 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 750 });
      expect(drawnWidth()).toBe('274px');
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 750 });
    });

    it('puts the width back on Escape in the middle of a drag, remembering nothing', () => {
      measured();
      render(<Held listing={three()} startsHidden={false} />);
      fireEvent.pointerDown(edge(), { pointerId: 1, button: 0, clientX: 800 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 700 });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 700 });
      expect(drawnWidth()).toBe('224px');
      expect(localStorage.getItem('cockpit.panel-list-width')).toBeNull();
    });

    it('goes back to 224px on a double-click on the edge', () => {
      measured();
      render(<Held listing={three()} startsHidden={false} />);
      drag(800, 650);
      expect(drawnWidth()).toBe('374px');
      fireEvent.doubleClick(edge());
      expect(drawnWidth()).toBe('224px');
      expect(localStorage.getItem('cockpit.panel-list-width')).toBeNull();
    });

    it('is drawn at the same width after a reload, and the hidden strip has no edge and keeps its own width', async () => {
      measured();
      const first = render(<Held listing={three()} startsHidden={false} />);
      drag(800, 650);
      first.unmount();

      render(<Held listing={three()} startsHidden={false} />);
      expect(drawnWidth()).toBe('374px');

      await userEvent.click(screen.getByRole('button', { name: 'Hide Go to panel' }));
      expect(screen.queryByRole('separator')).toBeNull();
      expect(strip()!.className).toContain('w-8');
      expect(strip()!.style.width).toBe('');
    });

    it('draws a stored width wider than the row allows at what the row allows, and keeps the stored one', () => {
      localStorage.setItem('cockpit.panel-list-width', '700');
      const narrow = render(<Held listing={three()} startsHidden={false} rowWidth={900} />);
      expect(drawnWidth()).toBe('300px');
      narrow.unmount();

      render(<Held listing={three()} startsHidden={false} rowWidth={3000} />);
      expect(drawnWidth()).toBe('700px');
    });

    it('still changes for this visit where the browser refuses the write', () => {
      measured();
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('refused');
      });
      render(<Held listing={three()} startsHidden={false} />);
      drag(800, 700);
      expect(drawnWidth()).toBe('324px');
    });
  });
});
