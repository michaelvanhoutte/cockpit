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
  });

  describe('snoozing an item sets when it comes back', () => {
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
