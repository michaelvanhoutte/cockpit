import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import {
  applySetDismissed,
  applySetDone,
  captureItem,
  decideWorkspace,
} from '../../../src/domain/items.js';

const MADE = '2026-08-12T10:00:00.000Z';
const LATER = '2026-08-12T10:00:01.000Z';
const LATEST = '2026-08-12T10:00:02.000Z';

const request = {
  commandId: '018f0000-0000-7000-8000-000000000001',
  workspaceId: 'ws-work',
};

function anItem(overrides: Partial<Item> = {}): Item {
  return {
    ...captureItem(
      {
        ...request,
        issuedAt: MADE,
        itemId: '018f0000-0000-7000-8000-000000000002',
        title: 'Make appointment with Novy',
      },
      'tenant-default',
    ),
    ...overrides,
  };
}

const done = (item: Item, at: string, isDone: boolean) =>
  applySetDone(item, { ...request, issuedAt: at, itemId: 'x', done: isDone });

const dismissed = (item: Item, at: string, isDismissed: boolean) =>
  applySetDismissed(item, { ...request, issuedAt: at, itemId: 'x', dismissed: isDismissed });

describe('Capture', () => {
  describe('a thought captured in the app arrives yours to deal with', () => {
    it('has no source behind it and is stamped with the time it was made', () => {
      const item = anItem();
      expect(item.source).toBe('internal');
      expect(item.completedAt).toBeNull();
      expect(item.createdAt).toBe(MADE);
      expect(item.updatedAt).toBe(MADE);
    });
  });
});

describe('Capture', () => {
  /**
   * L1: which workspace an item gets, and whether it gets one at all, is a
   * decision over the command and the item. That the Inbox then shows it in
   * every workspace, and stops, is a query and is proved against a real store
   * in apps/api/tests/integration/http/item-changes.test.ts.
   */
  describe('capture says where an item belongs, or that nobody has said yet', () => {
    it.each([
      {
        situation: 'a front door with no opinion, which is every one but the capture window',
        asked: {},
        decided: true,
      },
      { situation: 'the Inbox’s own row, inside a workspace', asked: { workspaceDecided: true }, decided: true },
      { situation: 'the capture window, which is not', asked: { workspaceDecided: false }, decided: false },
    ])('$situation', ({ asked, decided }) => {
      const item = captureItem(
        {
          ...request,
          ...asked,
          issuedAt: MADE,
          itemId: '018f0000-0000-7000-8000-000000000002',
          title: 'Make appointment with Novy',
        },
        'tenant-default',
      );
      expect(item.workspaceDecided).toBe(decided);
      // Either way it records the workspace it was captured from, which is
      // what a later router reads and what the foreign key needs.
      expect(item.workspaceId).toBe('ws-work');
    });
  });

  describe('an item gets its workspace the first time somebody says where it belongs, and keeps it', () => {
    const undecided = () => anItem({ workspaceDecided: false });

    it('takes the workspace it is put into, and stops belonging to none', () => {
      const settled = decideWorkspace(undecided(), 'ws-home', LATER);
      expect(settled).toEqual(expect.objectContaining({ workspaceId: 'ws-home', workspaceDecided: true }));
      expect(settled?.updatedAt).toBe(LATER);
    });

    it.each([
      { situation: 'put into the workspace it was captured from', into: 'ws-work' },
      { situation: 'put into another workspace', into: 'ws-home' },
    ])('$situation is still an answer', ({ into }) => {
      expect(decideWorkspace(undecided(), into, LATER)?.workspaceId).toBe(into);
    });

    /**
     * **The first answer wins, not the last one.** Everything else about an
     * item is last-write-wins on the command's clock; this is the one thing a
     * later command may not have an opinion about, because the question it
     * answers has already been answered.
     */
    it.each([
      { situation: 'moved again, later', at: LATEST },
      { situation: 'a command that was slow to arrive', at: MADE },
    ])('leaves an item that already belongs somewhere alone, $situation', ({ at }) => {
      expect(decideWorkspace(anItem(), 'ws-home', at)).toBeNull();
    });
  });
});

describe('Triage', () => {
  describe('an item is either yours to deal with or finished with', () => {
    it.each([
      { situation: 'finished with', act: (i: Item) => done(i, LATER, true), finished: LATER },
      {
        situation: 'finished with and then picked up again',
        act: (i: Item) => done(done(i, LATER, true)!, LATEST, false),
        finished: null,
      },
      {
        situation: 'dismissed after being finished with',
        act: (i: Item) => dismissed(done(i, LATER, true)!, LATEST, true),
        finished: LATER,
      },
    ])('says when it was $situation', ({ act, finished }) => {
      expect(act(anItem())?.completedAt).toBe(finished);
    });

    it('says when it was last changed, whichever way it went', () => {
      expect(done(anItem(), LATER, true)?.updatedAt).toBe(LATER);
      expect(done(anItem(), LATER, false)?.updatedAt).toBe(LATER);
    });
  });

  describe('a dismissed item leaves the lists but is never erased', () => {
    it('records when it was dismissed instead of dropping the item', () => {
      expect(dismissed(anItem(), LATER, true)?.deletedAt).toBe(LATER);
    });

    it('comes back when the dismissal is taken back, still yours to deal with', () => {
      const gone = dismissed(anItem(), LATER, true)!;
      const back = dismissed(gone, LATEST, false);

      // Nothing was erased, so what has to go is the record that it was
      // dismissed - without which a dismissal could never be undone.
      expect(back?.deletedAt).toBeNull();
      expect(back?.completedAt).toBeNull();
    });

    it('leaves an item that was finished with finished with when it comes back', () => {
      const finishedThenGone = dismissed(done(anItem(), LATER, true)!, LATEST, true)!;
      expect(dismissed(finishedThenGone, '2026-08-31T12:00:00.000Z', false)?.completedAt).toBe(LATER);
    });
  });
});

describe('Offline', () => {
  describe('a change made against an older version of an item is refused', () => {
    it.each([
      { situation: 'finishing with it', act: (i: Item) => done(i, LATER, true) },
      { situation: 'dismissing it', act: (i: Item) => dismissed(i, LATER, true) },
    ])('leaves the item alone rather than undoing the newer change when $situation', ({ act }) => {
      expect(act(anItem({ updatedAt: LATEST }))).toBeNull();
    });
  });
});
