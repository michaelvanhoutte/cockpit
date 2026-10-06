import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelList } from '../../../src/components/PanelList';
import type { PanelListing } from '../../../src/panelList';

/**
 * F1: what the column draws from what it is handed, and what its controls ask
 * for. Which Panels the board hands it is tests/unit/components/PanelBoard.test.tsx,
 * and where a jump lands the page is tests/e2e/dashboards.test.ts, which needs a
 * layout engine.
 */
function aListing(
  rows: [string, number | null][][],
  jumpTo = vi.fn(),
  { arrangeable = true, arrange = vi.fn() }: { arrangeable?: boolean; arrange?: PanelListing['arrange'] } = {},
): PanelListing {
  return {
    dashboardId: 'today',
    jumpTo,
    arrangeable,
    arrange,
    rows: rows.map((row) => row.map(([title, count]) => ({ panelId: `id-${title}`, title, count }))),
    arrangement: rows.map((row) => ({
      height: null,
      cells: row.map(([title]) => ({ panelId: `id-${title}`, span: Math.floor(12 / row.length) })),
    })),
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
      const { container } = drawn(
        aListing([[['One', 3]], [['Two', 0], ['Notes', null]], [['Three', 12]]], vi.fn(), { arrangeable: false }),
      );

      const rows = screen.getAllByRole('list');
      expect(rows.map((row) => within(row).getAllByRole('button').map((b) => b.textContent))).toEqual([
        ['One3'],
        ['Two0', 'Notes'],
        ['Three12'],
      ]);
      const gaps = [...container.querySelectorAll('[data-panel-list-gap]')];
      expect(gaps.map((gap) => gap.querySelector('.border-t') !== null)).toEqual([true, true]);
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

  /** A drag as a browser hands it over: the types are readable throughout, the data only on a drop. */
  function aDrag() {
    const data = new Map<string, string>();
    return {
      types: [] as string[],
      effectAllowed: '',
      dropEffect: '',
      setData(type: string, value: string) {
        data.set(type, value);
        this.types = [...data.keys()];
      },
      getData: (type: string) => data.get(type) ?? '',
    };
  }
  const entry = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) }).closest('li')!;
  const gap = (container: HTMLElement, at: number) =>
    container.querySelector<HTMLElement>(`[data-panel-list-gap="${at}"]`)!;
  const newRow = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-panel-list-new-row]');
  /** The pointer at `where` of the entry's height, 0 its top and 1 its bottom. */
  const over = (target: HTMLElement, dataTransfer: ReturnType<typeof aDrag>, where = 0.5) => {
    target.getBoundingClientRect = () => ({ top: 100, height: 20 }) as DOMRect;
    const event = createEvent.dragOver(target, { dataTransfer });
    Object.defineProperty(event, 'clientY', { value: 100 + 20 * where });
    fireEvent(target, event);
    return event;
  };
  /** Lets go at the same place `over` put the pointer. */
  const letGo = (target: HTMLElement, dataTransfer: ReturnType<typeof aDrag>, where = 0.5) => {
    const event = createEvent.drop(target, { dataTransfer });
    Object.defineProperty(event, 'clientY', { value: 100 + 20 * where });
    fireEvent(target, event);
  };
  const afterPickUp = () => act(() => new Promise<void>((done) => setTimeout(done, 0)));
  const panelsIn = (rows: PanelListing['arrangement']) => rows.map((row) => row.cells.map((cell) => cell.panelId));
  async function holding(title: string, listing: PanelListing) {
    const view = drawn(listing);
    const dataTransfer = aDrag();
    fireEvent.dragStart(entry(title), { dataTransfer });
    await afterPickUp();
    return { ...view, dataTransfer };
  }
  const three = [[['One', 1]], [['Two', 2], ['Three', 3]], [['Four', 4]]] as [string, number][][];

  describe('a Panel dropped in the list goes where the board’s own drag would put it', () => {
    const dropped = async (title: string, onto: (view: Awaited<ReturnType<typeof holding>>) => HTMLElement, where = 0.5) => {
      const arrange = vi.fn();
      cleanup();
      const view = await holding(title, aListing(three, vi.fn(), { arrange }));
      const target = onto(view);
      over(target, view.dataTransfer, where);
      letGo(target, view.dataTransfer, where);
      return arrange;
    };

    it.each([
      ['top', 0.2, [['id-One'], ['id-Four', 'id-Two', 'id-Three']]],
      ['bottom', 0.8, [['id-One'], ['id-Two', 'id-Four', 'id-Three']]],
    ] as const)('puts it before or after an entry in another row: the %s half', async (_half, where, expected) => {
      const arrange = await dropped('Four', () => entry('Two'), where);

      expect(panelsIn(arrange.mock.calls[0]![0])).toEqual(expected);
    });

    it('reorders it along its own row when dropped on an entry in it', async () => {
      const arrange = await dropped('Three', () => entry('Two'), 0.2);

      expect(panelsIn(arrange.mock.calls[0]![0])).toEqual([['id-One'], ['id-Three', 'id-Two'], ['id-Four']]);
    });

    it('sends nothing for a row already four across', async () => {
      const arrange = vi.fn();
      const full = aListing([[['One', 1]], [['A', 0], ['B', 0], ['C', 0], ['D', 0]]], vi.fn(), { arrange });
      const view = await holding('One', full);

      over(entry('B'), view.dataTransfer);
      fireEvent.drop(entry('B'), { dataTransfer: view.dataTransfer });

      expect(arrange).not.toHaveBeenCalled();
    });

    it('gives it a row of its own in the gap between two rows', async () => {
      const arrange = await dropped('Four', ({ container }) => gap(container, 1));

      expect(panelsIn(arrange.mock.calls[0]![0])).toEqual([['id-One'], ['id-Four'], ['id-Two', 'id-Three']]);
    });

    it('gives it a row of its own at the end when dropped in New row', async () => {
      const arrange = await dropped('One', ({ container }) => newRow(container)!);

      expect(panelsIn(arrange.mock.calls[0]![0])).toEqual([['id-Two', 'id-Three'], ['id-Four'], ['id-One']]);
    });

    it('sends nothing for a Panel alone in the last row, dropped in New row or where it is', async () => {
      const inNewRow = await dropped('Four', ({ container }) => newRow(container)!);
      const inItsOwnGap = await dropped('Four', ({ container }) => gap(container, 2));

      expect(inNewRow).not.toHaveBeenCalled();
      expect(inItsOwnGap).not.toHaveBeenCalled();
    });
  });

  describe('while an entry is held, the list shows where it will land, and nothing else moves', () => {
    it('fades the held entry and shows New row below everything, leaving every gap and entry as it was', async () => {
      const { container } = drawn(aListing(three));
      const shape = () =>
        [...container.querySelectorAll('li, [data-panel-list-gap]')].map(
          (one) => `${one.tagName} ${one.className} ${one.getAttribute('data-panel-list-gap')}`,
        );
      const before = shape();
      expect(newRow(container)).toBeNull();

      fireEvent.dragStart(entry('Four'), { dataTransfer: aDrag() });
      // Not within the dragstart itself: only a browser can tell whether the drag survives that.
      expect(newRow(container)).toBeNull();
      await afterPickUp();

      expect(entry('Four').style.opacity).toBe('0.4');
      expect(newRow(container)).toHaveTextContent('New row');
      expect(shape()).toEqual(before);
      expect(newRow(container)!.nextElementSibling).toBeNull();    });

    it('marks the half of an entry, or the gap, it is over, and only that place', async () => {
      const { container, dataTransfer } = await holding('Four', aListing(three));

      over(entry('Two'), dataTransfer, 0.2);
      expect(entry('Two').style.boxShadow).toContain('inset 0 2px 0');

      over(entry('Two'), dataTransfer, 0.8);
      expect(entry('Two').style.boxShadow).toContain('inset 0 -2px 0');

      over(gap(container, 1), dataTransfer);
      expect(entry('Two').style.boxShadow).toBe('');
      expect(gap(container, 1).querySelector('.bg-accent')).not.toBeNull();

      over(newRow(container)!, dataTransfer);
      expect(gap(container, 1).querySelector('.bg-accent')).toBeNull();
      expect(newRow(container)!.className).toContain('border-accent');
    });

    it('sends nothing and clears the marks when the drag ends outside the list, as Escape does', async () => {
      const arrange = vi.fn();
      const { container, dataTransfer } = await holding('Four', aListing(three, vi.fn(), { arrange }));
      over(entry('Two'), dataTransfer, 0.2);

      fireEvent.dragEnd(entry('Four'), { dataTransfer });

      expect(arrange).not.toHaveBeenCalled();
      expect(entry('Two').style.boxShadow).toBe('');
      expect(entry('Four').style.opacity).toBe('');
      expect(newRow(container)).toBeNull();
    });
  });

  describe('a hold the browser never ends is let go when the board changes under it', () => {
    it('clears the held entry and New row when the arrangement changes mid-drag, as a drag whose source was redrawn does', async () => {
      const { container, rerender } = await holding('Four', aListing(three));
      expect(newRow(container)).not.toBeNull();

      rerender(<PanelList listing={aListing([[['Four', 4]], [['One', 1]]])} collapsed={false} onCollapse={vi.fn()} />);

      expect(newRow(container)).toBeNull();
      expect(entry('Four').style.opacity).toBe('');
    });
  });
  describe('only a Panel from the list is taken, and only where the board can be rearranged', () => {
    it('cannot pick an entry up on a Dashboard that is not arrangeable', () => {
      const { container } = drawn(aListing(three, vi.fn(), { arrangeable: false }));

      expect(screen.getAllByRole('listitem').map((one) => one.getAttribute('draggable'))).toEqual(Array(4).fill('false'));
      expect(gap(container, 0)).toBeNull();
    });

    it('marks no place and sends nothing for an Item dragged over the list', () => {
      const arrange = vi.fn();
      const { container } = drawn(aListing(three, vi.fn(), { arrange }));
      const item = aDrag();
      item.setData('application/x-cockpit-item', 'an-item');

      const event = over(entry('Two'), item, 0.2);
      fireEvent.drop(entry('Two'), { dataTransfer: item });

      expect(event.defaultPrevented).toBe(false);
      expect(entry('Two').style.boxShadow).toBe('');
      expect(container.querySelector('.bg-accent')).toBeNull();
      expect(arrange).not.toHaveBeenCalled();
    });
  });
});
