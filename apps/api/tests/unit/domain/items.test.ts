import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import { applySetStatus, applySnoozeUntil, captureItem } from '../../../src/domain/items.js';

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

describe('Capture', () => {
  describe('a thought captured in the app becomes an item to process', () => {
    it('has no source behind it and is stamped with the time it was made', () => {
      const item = anItem();
      expect(item.source).toBe('internal');
      expect(item.status).toBe('to_process');
      expect(item.createdAt).toBe(MADE);
      expect(item.updatedAt).toBe(MADE);
    });
  });
});

describe('Triage', () => {
  describe('setting a status moves the item and records when it moved', () => {
    it('applies the new status', () => {
      const updated = applySetStatus(anItem(), {
        ...request,
        issuedAt: LATER,
        itemId: 'x',
        status: 'done',
      });
      expect(updated?.status).toBe('done');
      expect(updated?.updatedAt).toBe(LATER);
    });
  });

  describe('a dismissed item leaves the lists but is never erased', () => {
    it('records when it was dismissed instead of dropping the item', () => {
      const updated = applySetStatus(anItem(), {
        ...request,
        issuedAt: LATER,
        itemId: 'x',
        status: 'dismissed',
      });
      expect(updated?.deletedAt).toBe(LATER);
    });

    it.each([
      { situation: 'put back where it was', status: 'to_process' as const },
      { situation: 'made a task instead', status: 'task' as const },
      { situation: 'finished rather than dismissed', status: 'done' as const },
    ])('comes back when it is $situation', ({ status }) => {
      const dismissed = applySetStatus(anItem(), {
        ...request,
        issuedAt: LATER,
        itemId: 'x',
        status: 'dismissed',
      })!;

      const back = applySetStatus(dismissed, {
        ...request,
        issuedAt: '2026-08-31T12:00:00.000Z',
        itemId: 'x',
        status,
      });

      // Nothing was erased, so what has to go is the record that it was
      // dismissed - without which a dismissal could never be undone.
      expect(back?.deletedAt).toBeNull();
      expect(back?.status).toBe(status);
    });
  });

  describe('snoozing an item sets when it comes back', () => {
    it('brings back an item that was dismissed while it was snoozed', () => {
      // The only way back for a snoozed item: putting only its status back
      // would lose the date it was waiting for, so undoing that dismissal
      // comes through here - and it has to lift the dismissal too, or the item
      // stays out of every list with a wake date nothing will ever act on.
      const dismissed = applySetStatus(anItem({ status: 'snoozed' }), {
        ...request,
        issuedAt: LATER,
        itemId: 'x',
        status: 'dismissed',
      })!;

      const back = applySnoozeUntil(dismissed, {
        ...request,
        issuedAt: '2026-08-31T12:00:00.000Z',
        itemId: 'x',
        until: '2026-09-08T08:00:00.000Z',
      });

      expect(back?.deletedAt).toBeNull();
      expect(back?.status).toBe('snoozed');
      expect(back?.snoozedUntil).toBe('2026-09-08T08:00:00.000Z');
    });

    it('stores the status and the wake date together', () => {
      const updated = applySnoozeUntil(anItem(), {
        ...request,
        issuedAt: LATER,
        itemId: 'x',
        until: '2026-09-01T08:00:00.000Z',
      });
      expect(updated?.status).toBe('snoozed');
      expect(updated?.snoozedUntil).toBe('2026-09-01T08:00:00.000Z');
    });
  });

  describe('an item woken before its date is no longer snoozed', () => {
    it('forgets the wake date once the status moves on', () => {
      const snoozed = applySnoozeUntil(anItem(), {
        ...request,
        issuedAt: LATER,
        itemId: 'x',
        until: '2026-09-01T08:00:00.000Z',
      });
      const woken = applySetStatus(snoozed!, { ...request, issuedAt: LATEST, itemId: 'x', status: 'task' });
      expect(woken?.snoozedUntil).toBeNull();
    });
  });
});

describe('Offline', () => {
  describe('a change made against an older version of an item is refused', () => {
    it('leaves the item alone rather than undoing the newer change', () => {
      const item = anItem({ updatedAt: LATEST });
      const updated = applySetStatus(item, { ...request, issuedAt: LATER, itemId: 'x', status: 'done' });
      expect(updated).toBeNull();
    });
  });
});
