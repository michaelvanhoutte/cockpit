import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import { applySetStatus, applySnoozeUntil, captureItem } from './items.js';

const T0 = '2026-08-12T10:00:00.000Z';
const T1 = '2026-08-12T10:00:01.000Z';
const T2 = '2026-08-12T10:00:02.000Z';

const envelope = {
  commandId: '018f0000-0000-7000-8000-000000000001',
  workspaceId: 'ws-work',
};

function anItem(overrides: Partial<Item> = {}): Item {
  return {
    ...captureItem(
      {
        ...envelope,
        issuedAt: T0,
        itemId: '018f0000-0000-7000-8000-000000000002',
        title: 'Make appointment with Novy',
      },
      'tenant-default',
    ),
    ...overrides,
  };
}

describe('captureItem', () => {
  it('creates an internal to_process item stamped with the command timestamp', () => {
    const item = anItem();
    expect(item.source).toBe('internal');
    expect(item.status).toBe('to_process');
    expect(item.createdAt).toBe(T0);
    expect(item.updatedAt).toBe(T0);
  });
});

describe('applySetStatus', () => {
  it('applies a newer command and stamps updatedAt', () => {
    const updated = applySetStatus(anItem(), {
      ...envelope,
      issuedAt: T1,
      itemId: 'x',
      status: 'done',
    });
    expect(updated?.status).toBe('done');
    expect(updated?.updatedAt).toBe(T1);
  });

  it('rejects a stale command (last-write-wins)', () => {
    const item = anItem({ updatedAt: T2 });
    const updated = applySetStatus(item, { ...envelope, issuedAt: T1, itemId: 'x', status: 'done' });
    expect(updated).toBeNull();
  });

  it('tombstones on dismissal instead of deleting', () => {
    const updated = applySetStatus(anItem(), {
      ...envelope,
      issuedAt: T1,
      itemId: 'x',
      status: 'dismissed',
    });
    expect(updated?.deletedAt).toBe(T1);
  });
});

describe('applySnoozeUntil', () => {
  it('sets both the status and the snooze date', () => {
    const updated = applySnoozeUntil(anItem(), {
      ...envelope,
      issuedAt: T1,
      itemId: 'x',
      until: '2026-09-01T08:00:00.000Z',
    });
    expect(updated?.status).toBe('snoozed');
    expect(updated?.snoozedUntil).toBe('2026-09-01T08:00:00.000Z');
  });

  it('clears the snooze date when the item is unsnoozed', () => {
    const snoozed = applySnoozeUntil(anItem(), {
      ...envelope,
      issuedAt: T1,
      itemId: 'x',
      until: '2026-09-01T08:00:00.000Z',
    });
    const woken = applySetStatus(snoozed!, { ...envelope, issuedAt: T2, itemId: 'x', status: 'task' });
    expect(woken?.snoozedUntil).toBeNull();
  });
});
