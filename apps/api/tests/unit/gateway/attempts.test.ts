import { describe, expect, it, vi } from 'vitest';
import { callThrough, type CallAbout, type RetryPolicy } from '../../../src/gateway/attempts.js';

/**
 * Unit level: that a record which cannot be kept never costs the call is a
 * decision of the gateway's alone, so the recorder, the clock and the wait are
 * all handed in. Which records a real call leaves is the integration tier's
 * (tests/integration/http/ai-usage.test.ts).
 */

const ABOUT: CallAbout = {
  operation: 'clean-up-a-note',
  promptVersion: 'clean-up-a-note.v11',
  triggeredBy: 'captured-in-app',
  accountName: 'tenant-default',
  itemId: 'item-1',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  paidBy: { kind: 'cockpit-anthropic-key', account: null, keyEnding: 'abcd' },
};

const ONCE_MORE: RetryPolicy = {
  retries: 1,
  outcomeOf: () => ({ outcome: 'error', status: 529 }),
  retryAfter: () => 0,
};

const around = {
  clock: () => 0,
  now: () => new Date('2026-10-08T12:00:00.000Z'),
  wait: async () => {},
  record: async () => {
    throw new Error('the record could not be written');
  },
};

describe('AI usage', () => {
  describe('a record that cannot be kept never costs a note its clean-up', () => {
    it.each([
      {
        situation: 'the call succeeds',
        attempts: [async () => ({ value: 'the answer', tokens: null })],
      },
      {
        situation: 'the call fails once and then succeeds',
        attempts: [
          async () => {
            throw new Error('overloaded');
          },
          async () => ({ value: 'the answer', tokens: null }),
        ],
      },
    ])('still answers, and says the record was lost, when $situation', async ({ attempts }) => {
      const complained = vi.spyOn(console, 'error').mockImplementation(() => {});
      let tried = 0;

      const answer = await callThrough(ABOUT, () => attempts[tried++]!(), ONCE_MORE, around);

      expect(answer).toBe('the answer');
      expect(complained).toHaveBeenCalledTimes(attempts.length);
      expect(String(complained.mock.calls[0]![0])).toContain('was not recorded: the record could not be written');
      complained.mockRestore();
    });

    it('still fails with the call’s own failure, not the record’s', async () => {
      const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        callThrough(
          ABOUT,
          async () => {
            throw new Error('overloaded');
          },
          ONCE_MORE,
          around,
        ),
      ).rejects.toThrow('overloaded');
      complained.mockRestore();
    });
  });
});
