import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttemptRecord } from '../../../src/gateway/attempts.js';
import { SEND_TIMEOUT_MS, sendingTo, type Around } from '../../../src/gateway/send.js';

/**
 * Unit level: how long a record's send is awaited and that it is made once are
 * the sender's own decisions, so the network, the clock's wait and the user
 * lookup are handed in. What production does with a record it receives is the
 * integration tier's (tests/integration/http/ai-usage-from-other-environments.test.ts).
 */

const TOKEN = 'a-recording-token-that-must-never-be-logged';
const DESTINATION = { url: 'https://production.test/v1/usage-records', token: TOKEN };

const RECORD: AttemptRecord = {
  operation: 'clean-up-a-note',
  promptVersion: 'clean-up-a-note.v17',
  triggeredBy: 'captured-in-app',
  accountName: 'tenant-michael',
  itemId: 'item-1',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  paidBy: { kind: 'cockpit-anthropic-key', account: null, keyEnding: 'WXYZ' },
  outcome: 'ok',
  tokensIn: 1200,
  cacheRead: 3400,
  cacheWrite: 560,
  tokensOut: 78,
  at: '2026-10-08T10:00:00.000Z',
  durationMs: 812,
};

/** What the network does with a send: answers, answers refusing, never answers, or is not there. */
type Network = 'answers' | 'answers with an error' | 'refuses the token' | 'never answers' | 'is unreachable';

function around(network: Network, overrides: Partial<Around> = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const waited: number[] = [];
  const doing: Around = {
    send: (url, init) => {
      sent.push({ url, init });
      switch (network) {
        case 'answers':
          return Promise.resolve(new Response(null, { status: 201 }));
        case 'answers with an error':
          return Promise.resolve(new Response('boom', { status: 500 }));
        case 'refuses the token':
          return Promise.resolve(Response.json({ error: 'not allowed' }, { status: 401 }));
        case 'is unreachable':
          return Promise.reject(new TypeError('fetch failed'));
        case 'never answers':
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
      }
    },
    // The wait is the clock: it runs out at once when the network is the one that never answers.
    wait: (ms) => {
      waited.push(ms);
      return network === 'never answers' ? Promise.resolve() : new Promise(() => {});
    },
    userOf: async () => 'user-michael',
    branch: null,
    ...overrides,
  };
  return { doing, sent, waited };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AI usage', () => {
  describe('a send that fails never costs the call and is never repeated', () => {
    it.each([
      { situation: 'production answers with an error', network: 'answers with an error' as const },
      { situation: 'production refuses the token', network: 'refuses the token' as const },
      { situation: 'production does not answer within about two seconds', network: 'never answers' as const },
      { situation: 'production cannot be reached', network: 'is unreachable' as const },
    ])('sends once and logs one failure when $situation', async ({ network }) => {
      const complained = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { doing, sent } = around(network);

      await expect(sendingTo(DESTINATION, doing)(RECORD)).resolves.toBeUndefined();

      expect(sent).toHaveLength(1);
      expect(complained).toHaveBeenCalledTimes(1);
      const logged = String(complained.mock.calls[0]![0]);
      expect(logged).toContain('clean-up-a-note');
      expect(logged).not.toContain(TOKEN);
    });

    it('gives up after about two seconds, and cancels the send it gave up on', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { doing, sent, waited } = around('never answers');

      await sendingTo(DESTINATION, doing)(RECORD);

      expect(waited).toEqual([SEND_TIMEOUT_MS]);
      expect(SEND_TIMEOUT_MS).toBeGreaterThanOrEqual(1500);
      expect(SEND_TIMEOUT_MS).toBeLessThanOrEqual(2500);
      expect(sent[0]!.init.signal?.aborted).toBe(true);
    });

    it('still sends, with no user, when its own user cannot be looked up', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { doing, sent } = around('answers', {
        userOf: async () => {
          throw new Error('the register did not answer');
        },
      });

      await sendingTo(DESTINATION, doing)(RECORD);

      expect(sent).toHaveLength(1);
      expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({ userId: null });
    });
  });

  describe('a record is sent to production with its token, its user and the branch', () => {
    it('sends the record as it settled, under this environment’s token', async () => {
      const complained = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { doing, sent } = around('answers', { branch: 'claude/1458-send-usage' });

      await sendingTo(DESTINATION, doing)(RECORD);

      expect(complained).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(DESTINATION.url);
      expect(sent[0]!.init.method).toBe('POST');
      expect(new Headers(sent[0]!.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
        ...RECORD,
        userId: 'user-michael',
        branch: 'claude/1458-send-usage',
        pullRequest: null,
        runId: null,
      });
    });
  });
});
