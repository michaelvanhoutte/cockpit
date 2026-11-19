import { describe, expect, it } from 'vitest';
import type { ConnectionHistory } from '@cockpit/shared';
import { endedByHistory } from '../../src/checkConnections';

const line = (lastAt: string, brought: number) =>
  ({
    outcome: 'worked',
    lastAt,
    did: { broughtIn: { count: brought, items: [] }, closed: { count: 0, items: [] } },
  }) as unknown as ConnectionHistory['lines'][number];

describe('Inbox', () => {
  describe('a connection whose announcement was missed ends by the first line at or after the press', () => {
    it('reads the oldest of the lines since the press, not the newest', () => {
      const history = { lines: [line('2026-10-05T10:05:00.000Z', 3), line('2026-10-05T10:00:02.000Z', 1), line('2026-10-05T09:55:00.000Z', 9)], olderRemain: false };

      expect(endedByHistory(history, '2026-10-05T10:00:00.000Z')).toEqual({ failed: false, broughtIn: 1, closed: 0, at: '2026-10-05T10:00:02.000Z' });
    });

    it('says nothing where no line is at or after it', () => {
      expect(endedByHistory({ lines: [line('2026-10-05T09:55:00.000Z', 9)], olderRemain: false }, '2026-10-05T10:00:00.000Z')).toBeNull();
    });
  });
});
