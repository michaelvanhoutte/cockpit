import { describe, expect, it } from 'vitest';
import { itemStatus, type Item } from '@cockpit/shared';
import { applyConversationTurn, turnDueDate } from '../../../src/domain/conversations.js';
import { captureItem } from '../../../src/domain/items.js';

/**
 * L1: what a message in a followed conversation does to the Item following it
 * ("A Gmail starred conversation is one Item whose status follows who wrote
 * last", issue 1705) - a pure decision over the Item and the turn. That the
 * store applies it with the conversation's row in one logged change is
 * conversations-on-the-host.test.ts's, at L2.
 */

const MADE = '2026-10-05T08:00:00.000Z';
/** When the turn is recorded: a Wednesday, 14:00 in Brussels. */
const RECORDED = '2026-10-07T12:00:00.000Z';
const BRUSSELS = ['Europe/Brussels'];

function anItem(overrides: Partial<Item> = {}): Item {
  return {
    ...captureItem(
      {
        commandId: '018f0000-0000-7000-8000-000000000001',
        workspaceId: 'ws-home',
        issuedAt: MADE,
        itemId: '018f0000-0000-7000-8000-000000000002',
        message: 'Plan a dinner with Steven Noels',
      },
      'tenant-default',
    ),
    ...overrides,
  };
}

const WAITING = { waitingSince: '2026-10-05T09:00:00.000Z', updatedAt: '2026-10-05T09:00:00.000Z' };

describe('Triage', () => {
  describe('who wrote last in a followed conversation decides the Item’s status and replaces its due date', () => {
    it.each([
      {
        situation: 'their message on an Item waiting for a reply',
        item: anItem(WAITING),
        by: 'them' as const,
        connectionDays: 5,
        status: 'to_do',
        due: '2026-10-12',
        waitingSince: null,
      },
      {
        situation: 'their message, the connection giving no days',
        item: anItem(WAITING),
        by: 'them' as const,
        connectionDays: null,
        status: 'to_do',
        due: '2026-10-10',
        waitingSince: null,
      },
      {
        situation: 'their message on an Item in progress',
        item: anItem({ startedAt: '2026-10-05T09:00:00.000Z', updatedAt: '2026-10-05T09:00:00.000Z' }),
        by: 'them' as const,
        connectionDays: null,
        status: 'to_do',
        due: '2026-10-10',
        waitingSince: null,
      },
      {
        situation: 'your message on an Item to do',
        item: anItem(),
        by: 'you' as const,
        connectionDays: 5,
        status: 'waiting',
        due: '2026-10-10',
        waitingSince: RECORDED,
      },
      {
        situation: 'your message on an Item already waiting, which keeps waiting from when it started',
        item: anItem({ ...WAITING, dueDate: '2026-10-08' }),
        by: 'you' as const,
        connectionDays: null,
        status: 'waiting',
        due: '2026-10-10',
        waitingSince: WAITING.waitingSince,
      },
      {
        situation: 'a message on an Item whose due date you set',
        item: anItem({ dueDate: '2026-12-24', dueDateSetAt: '2026-10-05T09:00:00.000Z', dueDateChosenAt: '2026-10-05T09:00:00.000Z', updatedAt: '2026-10-05T09:00:00.000Z' }),
        by: 'them' as const,
        connectionDays: 2,
        status: 'to_do',
        due: '2026-10-09',
        waitingSince: null,
      },
    ])('$situation: $status, due $due', ({ item, by, connectionDays, status, due, waitingSince }) => {
      const dueDate = turnDueDate(by, RECORDED, BRUSSELS, { connectionDays, followUpDays: 3 });

      const after = applyConversationTurn(item, { by, recordedAt: RECORDED }, dueDate)!;

      expect({ status: itemStatus(after), due: after.dueDate, waitingSince: after.waitingSince }).toEqual({
        status,
        due,
        waitingSince,
      });
      expect(after.dueDateSetAt).toBe(RECORDED);
    });

    it.each([
      { situation: 'done', item: anItem({ completedAt: '2026-10-06T09:00:00.000Z', updatedAt: '2026-10-06T09:00:00.000Z' }) },
      { situation: 'dismissed', item: anItem({ deletedAt: '2026-10-06T09:00:00.000Z', updatedAt: '2026-10-06T09:00:00.000Z' }) },
    ])('changes nothing on an Item $situation', ({ item }) => {
      for (const by of ['you', 'them'] as const) {
        expect(applyConversationTurn(item, { by, recordedAt: RECORDED }, '2026-10-10')).toBeNull();
      }
    });

    it('still applies on an Item a device running fast last changed "after" it, and keeps that Item’s last change', () => {
      const ahead = '2026-10-07T13:00:00.000Z';
      const item = anItem({ startedAt: ahead, updatedAt: ahead });

      const after = applyConversationTurn(item, { by: 'them', recordedAt: RECORDED }, '2026-10-10')!;

      expect({ status: itemStatus(after), due: after.dueDate, updatedAt: after.updatedAt }).toEqual({
        status: 'to_do',
        due: '2026-10-10',
        updatedAt: ahead,
      });
    });

    it('counts the days from the day on the account’s own calendar, not the UTC one', () => {
      // 23:30 in Brussels on the 7th is already the 8th there.
      expect(turnDueDate('you', '2026-10-07T22:30:00.000Z', BRUSSELS, { connectionDays: null, followUpDays: 3 })).toBe('2026-10-11');
      expect(turnDueDate('you', '2026-10-07T22:30:00.000Z', [], { connectionDays: null, followUpDays: 3 })).toBe('2026-10-10');
    });
  });
});
