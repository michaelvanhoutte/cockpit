import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { PanelList } from '../../../src/components/PanelList';
import { readDashboardFilter, writeDashboardFilter } from '../../../src/dashboardFilter';
import type { DashboardFilter } from '../../../src/dashboardFilter';
import type { PanelListing } from '../../../src/panelList';

/**
 * F1: what the column draws from what it is handed, the keys it holds once G
 * has shown it, and what its controls ask for. Which Panels the board hands it
 * is tests/unit/components/PanelBoard.test.tsx, that the shell draws it and
 * remembers it is tests/unit/pages/Layout.test.tsx, and where a jump lands the
 * page is tests/e2e/dashboards.test.ts, which needs a layout engine.
 */
type Row = [string, number | null, boolean?][];

function aListing(rows: Row[], jumpTo = vi.fn()): PanelListing {
  return {
    dashboardId: 'today',
    jumpTo,
    rows: rows.map((row) =>
      row.map(([title, count, hidden]) => ({ panelId: `id-${title}`, title, count, hidden: hidden ?? false })),
    ),
  };
}

/** The column with its shown-or-hidden held the way the shell holds it. */
function Held({ listing, startsHidden = true, onHide }: { listing: PanelListing | null; startsHidden?: boolean; onHide?: (hidden: boolean) => void }) {
  const [hidden, setHidden] = useState(startsHidden);
  return (
    <PanelList
      listing={listing}
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

      expect(strip()).toHaveAttribute('title', 'Go to panel (G)');
      expect(strip()).toHaveTextContent('Go to panel');
      expect(strip()).toHaveTextContent('G');
      await user.click(strip()!);
      expect(onHide).toHaveBeenLastCalledWith(false);
      expect(shownList()).not.toBeNull();
    });

    it('names its keys in a legend at its foot', () => {
      render(<Held listing={three()} startsHidden={false} />);

      expect(shownList()).toHaveTextContent('Enter');
      expect(shownList()).toHaveTextContent('Space');
      expect(shownList()).toHaveTextContent('Esc');
    });

    it('wears the attribute that earns a mouse click the shortcut tip', () => {
      const { unmount } = render(<Held listing={three()} startsHidden={false} />);
      expect(screen.getByRole('button', { name: 'Hide Go to panel' })).toHaveAttribute('data-shortcut-tip', 'panels');
      unmount();
      render(<Held listing={three()} />);
      expect(strip()).toHaveAttribute('data-shortcut-tip', 'panels');
    });
  });

  describe('G shows and hides Go to panel from anywhere on the page, and P does nothing', () => {
    it('shows the strip’s column on G, hides it on G, and ignores P and a G typed into a field', async () => {
      const user = userEvent.setup();
      render(
        <>
          <input aria-label="A box" />
          <Held listing={three()} />
        </>,
      );
      expect(shownList()).toBeNull();

      await user.keyboard('p');
      expect(shownList()).toBeNull();

      await user.keyboard('g');
      expect(shownList()).not.toBeNull();

      await user.keyboard('g');
      expect(shownList()).toBeNull();

      await user.type(screen.getByRole('textbox', { name: 'A box' }), 'g');
      expect(shownList()).toBeNull();
    });

    it('does nothing under a window, or with a modifier held', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);

      const dialog = document.body.appendChild(document.createElement('div'));
      dialog.setAttribute('role', 'dialog');
      await user.keyboard('g');
      dialog.remove();
      await user.keyboard('{Control>}g{/Control}');

      expect(shownList()).toBeNull();
    });
  });

  describe('shown by G, the list takes the keys and the highlight moves the board to that Panel', () => {
    it('highlights the first entry, and ↓ and ↑ move the highlight and ask the board to jump', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} />);

      await user.keyboard('g');
      expect(highlighted()).toEqual(['One1']);

      await user.keyboard('{ArrowDown}');
      expect(highlighted()).toEqual(['Two2']);
      expect(jumpTo).toHaveBeenLastCalledWith('id-Two');

      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(highlighted()).toEqual(['Three3']);
      expect(jumpTo).toHaveBeenLastCalledWith('id-Three');

      await user.keyboard('{ArrowUp}');
      expect(highlighted()).toEqual(['Two2']);
      expect(jumpTo).toHaveBeenLastCalledWith('id-Two');
    });

    it.each([
      { situation: '↑ on the first', keys: '{ArrowUp}', stays: 'One1' },
      { situation: '↓ on the last', keys: '{ArrowDown}{ArrowDown}{ArrowDown}', stays: 'Three3' },
    ])('$situation stays where it is', async ({ keys, stays }) => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);

      await user.keyboard('g');
      await user.keyboard(keys);

      expect(highlighted()).toEqual([stays]);
    });

    it('goes to the highlighted Panel on Enter and ends the mode, leaving the column shown', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} />);

      await user.keyboard('g{ArrowDown}');
      jumpTo.mockClear();
      await user.keyboard('{Enter}');

      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Two');
      expect(highlighted()).toEqual([]);
      expect(shownList()).not.toBeNull();
    });

    it('goes to the Panel a click names, and ends the mode', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} startsHidden={false} />);

      await user.click(entry('Three'));

      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Three');
      expect(highlighted()).toEqual([]);
    });

    it('scrolls a highlighted entry below the list’s fold into view', async () => {
      const user = userEvent.setup();
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      try {
        render(<Held listing={three()} />);

        await user.keyboard('g{ArrowDown}');

        expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
        expect(scrollIntoView.mock.contexts.at(-1)).toBe(entry('Two'));
      } finally {
        // @ts-expect-error jsdom has none; this put it back as it was.
        delete Element.prototype.scrollIntoView;
      }
    });
  });

  describe('the search narrows the list by Panel name', () => {
    it('takes the cursor on Space, narrows as you type in any capitalisation, and highlights the first match', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);
      await user.keyboard('g{ArrowDown}');

      await user.keyboard(' ');
      expect(search()).toHaveFocus();
      await user.keyboard('TH');

      expect(screen.getAllByRole('button').map((button) => button.textContent)).toContain('Three3');
      expect(screen.queryByRole('button', { name: /^One/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Two/ })).toBeNull();
      expect(highlighted()).toEqual(['Three3']);
    });

    it('takes a g typed in the box as a letter, and the column stays', async () => {
      const user = userEvent.setup();
      render(<Held listing={aListing([[['Budget', 1], ['Other', 2]]])} />);
      await user.keyboard('g ');

      await user.keyboard('g');

      expect(search()).toHaveValue('g');
      expect(shownList()).not.toBeNull();
      expect(highlighted()).toEqual(['Budget1']);
    });

    it('says so when nothing matches', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);

      await user.keyboard('g ');
      await user.keyboard('zzz');

      expect(screen.getByText('No Panel matches.')).toBeInTheDocument();
    });

    it('clears on Esc in the box and hands the keys back to the list, and every G starts empty', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      render(<Held listing={three(jumpTo)} />);
      await user.keyboard('g ');
      await user.keyboard('tw');
      expect(screen.queryByRole('button', { name: /^One/ })).toBeNull();

      await user.keyboard('{Escape}');

      expect(search()).toHaveValue('');
      expect(shownList()).not.toBeNull();
      expect(screen.getByRole('button', { name: /^One/ })).toBeInTheDocument();
      expect(shownList()!.contains(document.activeElement)).toBe(true);
      expect(search()).not.toHaveFocus();

      await user.keyboard(' tw{Enter}');
      expect(jumpTo).toHaveBeenLastCalledWith('id-Two');
      expect(search()).toHaveValue('');

    });

    it('starts every G with an empty search, whatever was left in the box', async () => {
      const user = userEvent.setup();
      render(<Held listing={three()} />);
      await user.keyboard('g ');
      await user.keyboard('tw');
      await user.click(document.body);
      expect(search()).toHaveValue('tw');

      await user.keyboard('g');
      await user.keyboard('g');

      expect(search()).toHaveValue('');
      expect(screen.getByRole('button', { name: /^One/ })).toBeInTheDocument();
    });
  });

  describe('Esc and G put the Dashboard back where G was pressed', () => {
    /** A board whose jump moves the scroller, as the real one does. */
    const jumping = () => three(vi.fn(() => void (scroller.scrollTop = 900)));

    it('restores the scroll from before G and hides the column on Esc, after moving about', async () => {
      const user = userEvent.setup();
      render(<Held listing={jumping()} />);

      await user.keyboard('g{ArrowDown}{ArrowDown}');
      expect(scroller.scrollTop).toBe(900);
      await user.keyboard('{Escape}');

      expect(scroller.scrollTop).toBe(120);
      expect(shownList()).toBeNull();
    });

    it('keeps a column that was already shown, shown, on Esc from the list, and puts the scroll back', async () => {
      const user = userEvent.setup();
      render(<Held listing={jumping()} startsHidden={false} />);

      await user.click(shownList()!.querySelector('[tabindex="-1"]') as HTMLElement);
      await user.keyboard('{ArrowDown}');
      expect(scroller.scrollTop).toBe(900);
      await user.keyboard('{Escape}');

      expect(scroller.scrollTop).toBe(120);
      expect(shownList()).not.toBeNull();
    });

    it('restores the scroll and hides the column on G from the list', async () => {
      const user = userEvent.setup();
      render(<Held listing={jumping()} />);

      await user.keyboard('g{ArrowDown}');
      expect(scroller.scrollTop).toBe(900);
      await user.keyboard('g');

      expect(scroller.scrollTop).toBe(120);
      expect(shownList()).toBeNull();
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
      await user.keyboard('g{ArrowDown}');
      expect(jumpTo).not.toHaveBeenCalled();

      await user.keyboard('{Enter}');

      expect(readDashboardFilter(localStorage, 'today').text).toBe('');
      expect(jumpTo).not.toHaveBeenCalled();
      rerender(<Held listing={aListing([[['Drawn', 2], ['Hidden', 5]]], jumpTo)} startsHidden={false} />);
      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Hidden');
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
});
