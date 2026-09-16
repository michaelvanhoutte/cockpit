import { describe, expect, it } from 'vitest';
import { movedTo } from '../../src/reorder';

/**
 * F1: putting a workspace in a different place is arithmetic over a list.
 *
 * It is here rather than in the page's own file because the drag cannot be
 * driven below a browser at all: where a pointer is over the list is measured
 * from the rows' rectangles, and jsdom has no layout engine, so every row it
 * reports is zero pixels tall in the same place. What the drag does with an
 * answer is proved here; that a person can actually drag a row is proved in
 * tests/e2e/workspace-management.test.ts, where there is a browser to do it in.
 */

const WORKSPACES = ['ws-work', 'ws-atlas', 'ws-personal'];

describe('Workspace management', () => {
  describe('a workspace put in a place is in that place, and the rest keep the order they were in', () => {
    it.each([
      {
        situation: 'the first one, put last',
        moving: 'ws-work',
        to: 2,
        becomes: ['ws-atlas', 'ws-personal', 'ws-work'],
      },
      {
        situation: 'the last one, put first',
        moving: 'ws-personal',
        to: 0,
        becomes: ['ws-personal', 'ws-work', 'ws-atlas'],
      },
      {
        situation: 'the middle one, put first',
        moving: 'ws-atlas',
        to: 0,
        becomes: ['ws-atlas', 'ws-work', 'ws-personal'],
      },
      {
        situation: 'one put back where it already is',
        moving: 'ws-atlas',
        to: 1,
        becomes: WORKSPACES,
      },
      {
        situation: 'one dragged past the bottom of the list',
        moving: 'ws-work',
        to: 7,
        becomes: ['ws-atlas', 'ws-personal', 'ws-work'],
      },
      {
        situation: 'one dragged above the top of the list',
        moving: 'ws-personal',
        to: -3,
        becomes: ['ws-personal', 'ws-work', 'ws-atlas'],
      },
      {
        situation: 'one that is not in the list at all',
        moving: 'ws-elsewhere',
        to: 0,
        becomes: WORKSPACES,
      },
    ])('$situation', ({ moving, to, becomes }) => {
      expect(movedTo(WORKSPACES, moving, to)).toEqual(becomes);
    });

    it('leaves the list it was given alone', () => {
      // The order that comes back is what gets sent, and the one it was
      // computed from is still on screen until the answer arrives.
      const before = [...WORKSPACES];

      movedTo(WORKSPACES, 'ws-work', 2);

      expect(WORKSPACES).toEqual(before);
    });
  });
});
