import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import { applySetDismissed, applySetDone, captureItem } from '../../../src/domain/items.js';

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
        message: 'Make appointment with Novy',
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
