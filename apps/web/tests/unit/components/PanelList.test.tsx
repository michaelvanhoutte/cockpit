import { describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelList } from '../../../src/components/PanelList';
import type { PanelListing } from '../../../src/panelList';

/**
 * F1: what the column draws from what it is handed, and what its controls ask
 * for. Which Panels the board hands it is tests/unit/components/PanelBoard.test.tsx,
 * and where a jump lands the page is tests/e2e/dashboards.test.ts, which needs a
 * layout engine.
 */
function aListing(rows: [string, number | null][][], jumpTo = vi.fn()): PanelListing {
  return {
    dashboardId: 'today',
    jumpTo,
    rows: rows.map((row) => row.map(([title, count]) => ({ panelId: `id-${title}`, title, count }))),
  };
}

const drawn = (listing: PanelListing | null, collapsed = false, onCollapse = vi.fn()) =>
  render(<PanelList listing={listing} collapsed={collapsed} onCollapse={onCollapse} />);

describe('Dashboards', () => {
  describe('either control switches the Panel list between open and the strip, and each names the key', () => {
    it('collapses from » and opens from the strip, both saying P', async () => {
      const user = userEvent.setup();
      const onCollapse = vi.fn();
      const open = drawn(aListing([[['One', 1]]]), false, onCollapse);

      const collapse = screen.getByRole('button', { name: 'Collapse the Panel list' });
      expect(collapse).toHaveAttribute('title', 'Collapse the Panel list (P)');
      await user.click(collapse);
      expect(onCollapse).toHaveBeenLastCalledWith(true);
      open.unmount();

      drawn(aListing([[['One', 1]], [['Two', 0]]]), true, onCollapse);
      const strip = screen.getByRole('button', { name: 'Open the Panel list' });
      expect(strip).toHaveAttribute('title', 'Open the Panel list (P)');
      expect(strip).toHaveTextContent('Panels');
      expect(strip).toHaveTextContent('2');
      await user.click(strip);
      expect(onCollapse).toHaveBeenLastCalledWith(false);
    });
  });

  describe('the Panel list names each Panel the board draws, with the count the board shows', () => {
    it('lists the entries row by row, with a hairline between rows only, and a Panel of text without a count', () => {
      drawn(aListing([[['One', 3]], [['Two', 0], ['Notes', null]], [['Three', 12]]]));

      const rows = screen.getAllByRole('list');
      expect(rows.map((row) => within(row).getAllByRole('button').map((b) => b.textContent))).toEqual([
        ['One3'],
        ['Two0', 'Notes'],
        ['Three12'],
      ]);
      expect(rows.map((row) => row.className.includes('border-b'))).toEqual([true, true, false]);
      expect(screen.getByRole('heading', { name: 'Panels' }).parentElement).toHaveTextContent('Panels4');
    });

    it('says there are none on a Dashboard with no Panels', () => {
      drawn(aListing([]));

      expect(screen.getByText('No Panels on this Dashboard.')).toBeInTheDocument();
    });

    it('says nothing, rather than that there are none, before the board has been read', () => {
      drawn(null);

      expect(screen.queryByText('No Panels on this Dashboard.')).toBeNull();
      expect(screen.getByRole('heading', { name: 'Panels' }).parentElement).toHaveTextContent(/^Panels»$/);
    });

    it('cuts a long name short and scrolls the column on its own', () => {
      drawn(aListing([[['A name so long that it would never fit in a column of this width', 1]]]));

      const name = screen.getByText('A name so long that it would never fit in a column of this width');
      expect(name.className).toContain('truncate');
      expect(screen.getByRole('complementary', { name: 'Panels' }).className).toContain('overflow-y-auto');
    });
  });

  describe('a click on a Panel in the list brings that Panel to the top', () => {
    it('asks for the Panel it names', async () => {
      const user = userEvent.setup();
      const jumpTo = vi.fn();
      drawn(aListing([[['One', 1], ['Two', 2]]], jumpTo));

      await user.click(screen.getByRole('button', { name: /^Two/ }));

      expect(jumpTo).toHaveBeenCalledExactlyOnceWith('id-Two');
    });
  });

  describe('an entry in the Panel list cannot be picked up, so dragging on the board is the one way to rearrange', () => {
    it('draws no entry draggable and none with a grab cursor', () => {
      drawn(aListing([[['One', 1]], [['Two', 2], ['Three', 3]]]));

      for (const entry of screen.getAllByRole('listitem')) {
        expect(entry.getAttribute('draggable')).not.toBe('true');
        expect(within(entry).getByRole('button').className).not.toContain('cursor-grab');
      }
    });

    it('sends nothing to the board for anything dropped on an entry or between rows', () => {
      const jumpTo = vi.fn();
      const { container } = drawn(aListing([[['One', 1]], [['Two', 2]]], jumpTo));
      const dataTransfer = { types: ['application/x-cockpit-panel'], getData: () => 'id-One' };

      for (const target of [screen.getByRole('button', { name: /^Two/ }).closest('li')!, ...container.querySelectorAll('ul')]) {
        const over = createEvent.dragOver(target, { dataTransfer });
        fireEvent(target, over);
        fireEvent.drop(target, { dataTransfer });
        expect(over.defaultPrevented).toBe(false);
      }
      expect(jumpTo).not.toHaveBeenCalled();
    });
  });
});
