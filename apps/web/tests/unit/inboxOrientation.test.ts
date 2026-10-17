import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLIDE_MS, orient, scrollToHold, whatMoves, type Seen } from '../../src/inboxOrientation';

/**
 * F1, "Keep your place when the Inbox regroups" (issue 1168). What each row does
 * is decided from where the rows were and where they are now, so the rules are
 * held on that decision and, with rows laid out by hand (jsdom lays out
 * nothing), on the list that applies it. That the slide is smooth and lands
 * where it should is a hand walk under `pnpm dev`, with the model proposing.
 */

const seen = (...rows: [string, number][]): Seen => ({
  order: rows.map(([id]) => id),
  tops: new Map(rows),
});

describe('Triage', () => {
  describe('when the rows order changes, every row still there slides to its new place and a row new to the list does not', () => {
    it.each([
      {
        situation: 'a row moves from after the groups into a new group',
        then: seen(['a', 0], ['b', 50], ['c', 100], ['d', 150]),
        now: seen(['d', 0], ['a', 50], ['b', 100], ['c', 150]),
        slides: ['d', 'a', 'b', 'c'],
      },
      {
        situation: 'a group dissolves',
        then: seen(['a', 0], ['b', 50], ['c', 100]),
        now: seen(['c', 0], ['a', 50], ['b', 100]),
        slides: ['c', 'a', 'b'],
      },
      {
        situation: 'a row arrives with nothing reordered',
        then: seen(['a', 0], ['b', 50]),
        now: seen(['new', 0], ['a', 50], ['b', 100]),
        slides: [],
      },
      {
        situation: 'a row leaves with nothing reordered',
        then: seen(['a', 0], ['b', 50], ['c', 100]),
        now: seen(['a', 0], ['c', 50]),
        slides: [],
      },
      {
        situation: 'a row arrives while others are reordered, which it does not slide with',
        then: seen(['a', 0], ['b', 50]),
        now: seen(['b', 0], ['new', 50], ['a', 100]),
        slides: ['b', 'a'],
      },
    ])('$situation', ({ then, now, slides }) => {
      expect(whatMoves(then, now, []).slides.map((slide) => slide.id)).toEqual(slides);
    });

    it('slides each row from where it was', () => {
      const { slides } = whatMoves(seen(['a', 0], ['b', 50]), seen(['b', 0], ['a', 50]), []);
      expect(slides).toEqual([
        { id: 'b', dy: 50 },
        { id: 'a', dy: -50 },
      ]);
    });
  });

  describe('the row the keyboard is on keeps its place on screen through any change to the list', () => {
    it.each([
      {
        situation: 'a regroup moves it down by two rows',
        then: seen(['a', 0], ['b', 50], ['c', 100]),
        now: seen(['b', 0], ['c', 50], ['a', 100]),
        focused: 'a',
        scrolls: 100,
      },
      {
        situation: 'a row arrives above it',
        then: seen(['a', 0], ['b', 50]),
        now: seen(['new', 0], ['a', 50], ['b', 100]),
        focused: 'a',
        scrolls: 50,
      },
      { situation: 'no row has the keyboard', then: seen(['a', 0]), now: seen(['x', 0], ['a', 50]), focused: null, scrolls: 0 },
      { situation: 'the row it was on has left', then: seen(['a', 0]), now: seen(['x', 0]), focused: 'a', scrolls: 0 },
    ])('$situation', ({ then, now, focused, scrolls }) => {
      expect(scrollToHold(then, now, focused)).toBe(scrolls);
    });
  });

  describe('after a reorder the focused, selected and pointed-at rows flash where they land, and nothing flashes otherwise', () => {
    it.each([
      {
        situation: 'a reorder with a focused row, two selected and one under the pointer',
        then: seen(['a', 0], ['b', 50], ['c', 100], ['d', 150], ['e', 200]),
        now: seen(['e', 0], ['d', 50], ['c', 100], ['b', 150], ['a', 200]),
        touched: ['a', 'b', 'c', 'd'],
        flashes: ['a', 'b', 'c', 'd'],
      },
      {
        situation: 'a row arrives with nothing reordered',
        then: seen(['a', 0], ['b', 50]),
        now: seen(['new', 0], ['a', 50], ['b', 100]),
        touched: ['a', 'b'],
        flashes: [],
      },
      {
        situation: 'a row touched that has left',
        then: seen(['a', 0], ['b', 50], ['c', 100]),
        now: seen(['c', 0], ['a', 50]),
        touched: ['a', 'b'],
        flashes: ['a'],
      },
    ])('$situation', ({ then, now, touched, flashes }) => {
      expect(whatMoves(then, now, touched).flashes).toEqual(flashes);
    });
  });
});

/** A list laid out by hand: rows 50px tall in the given order, in a scrolled box. */
function list(order: string[]) {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const box = document.createElement('div');
  const ul = document.createElement('ul');
  box.append(ul);
  scroller.append(box);
  document.body.append(scroller);
  const place = (ids: string[]) => {
    ul.replaceChildren(
      ...ids.map((id) => {
        const row = document.createElement('li');
        row.dataset.itemRow = '';
        row.dataset.itemId = id;
        row.tabIndex = -1;
        row.getBoundingClientRect = () => ({ top: ids.indexOf(id) * 50 - scroller.scrollTop }) as DOMRect;
        return row;
      }),
    );
  };
  place(order);
  const row = (id: string) => ul.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;
  return { scroller, box, place, row };
}

describe('Triage', () => {
  let animations: { id: string; keyframes: Keyframe[] }[];
  beforeEach(() => {
    vi.useFakeTimers();
    animations = [];
    Element.prototype.animate = function (this: HTMLElement, keyframes: Keyframe[]) {
      animations.push({ id: this.dataset.itemId!, keyframes });
      return {} as Animation;
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    delete (Element.prototype as { animate?: unknown }).animate;
  });

  const slid = () => animations.filter((a) => 'transform' in a.keyframes[0]!).map((a) => a.id);
  const flashed = () => animations.filter((a) => 'boxShadow' in a.keyframes[0]!).map((a) => a.id);

  describe('the row the keyboard is on keeps its place on screen through any change to the list', () => {
    it.each([
      { situation: 'a regroup moves it down by two rows', after: ['b', 'c', 'a'], focus: 'a', scrollTop: 100 },
      { situation: 'a row arrives above it', after: ['new', 'a', 'b', 'c'], focus: 'a', scrollTop: 50 },
      { situation: 'no row has the keyboard', after: ['b', 'c', 'a'], focus: null, scrollTop: 0 },
    ])('$situation', ({ after, focus, scrollTop }) => {
      const { scroller, box, place, row } = list(['a', 'b', 'c']);
      const oriented = orient(box);
      if (focus) row(focus).focus();
      oriented.read();
      place(after);
      if (focus) row(focus).focus();
      oriented.settle([]);
      expect(scroller.scrollTop).toBe(scrollTop);
      oriented.detach();
    });
  });

  describe('rows slide when reordered and the rows you were dealing with flash', () => {
    it('slides every row that moved from where it was, and flashes the selected and the pointed-at one', () => {
      const { box, place, row } = list(['a', 'b', 'c', 'd']);
      const oriented = orient(box);
      row('c').dispatchEvent(new Event('pointermove', { bubbles: true }));
      oriented.read();
      place(['d', 'a', 'b', 'c']);
      oriented.settle(['b']);
      expect(slid()).toEqual(['d', 'a', 'b', 'c']);
      expect(flashed().sort()).toEqual(['b', 'c']);
      oriented.detach();
    });

    it('slides and flashes nothing when a row only arrives', () => {
      const { box, place, row } = list(['a', 'b']);
      const oriented = orient(box);
      row('a').dispatchEvent(new Event('pointermove', { bubbles: true }));
      oriented.read();
      place(['new', 'a', 'b']);
      oriented.settle(['b']);
      expect(animations).toEqual([]);
      oriented.detach();
    });
  });

  describe('a click, double-click or press on a row during the slide does nothing, and one after it acts as usual', () => {
    it.each(['pointerdown', 'mousedown', 'click', 'dblclick'])('%s', (kind) => {
      const { box, place, row } = list(['a', 'b']);
      const oriented = orient(box);
      const acted = vi.fn();
      box.addEventListener(kind, acted);
      oriented.read();
      place(['b', 'a']);
      oriented.settle([]);

      row('a').dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true }));
      expect(acted).not.toHaveBeenCalled();

      vi.advanceTimersByTime(SLIDE_MS);
      row('a').dispatchEvent(new MouseEvent(kind, { bubbles: true, cancelable: true }));
      expect(acted).toHaveBeenCalledTimes(1);
      oriented.detach();
    });

    it('lets a press through when nothing slid', () => {
      const { box, place, row } = list(['a']);
      const oriented = orient(box);
      const acted = vi.fn();
      box.addEventListener('click', acted);
      oriented.read();
      place(['new', 'a']);
      oriented.settle([]);
      row('a').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(acted).toHaveBeenCalledTimes(1);
      oriented.detach();
    });
  });
});
