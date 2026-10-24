import { describe, expect, it } from 'vitest';

import { cutBatches, MonitorError, newestStored, sendPulls, sendWindow } from '../../src/monitor.js';

const NOW = new Date('2026-10-23T12:00:00Z');

const pull = (number, over = {}) => ({ number, title: 'A change', jobs: [], misses: [], ...over });
const BARS = { windowDays: 14, minPulls: 20, items: [{ id: 'misses', name: 'Misses', threshold: 1, minOver: null }] };

/** A Monitor that stores every batch but the ones named, and keeps what it was sent. */
function stubMonitor({ refuse = [] } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const { pulls, bars } = JSON.parse(init.body);
    sent.push({ url, authorization: init.headers.authorization, numbers: pulls.map((p) => p.number), bars });
    if (refuse.includes(sent.length)) {
      return { ok: false, status: 400, json: async () => ({ error: 'Pull request 0 (#9): job test package api file a.test.ts has no selectedBy.' }) };
    }
    return { ok: true, status: 200, json: async () => ({ stored: pulls.length }) };
  };
  return { fetchImpl, sent };
}

describe('Selection', () => {
  describe('the nightly send starts from the newest merge the Monitor holds, less two days', () => {
    it.each([
      {
        situation: 'the Monitor holds nothing, so the tool reads its own default window',
        input: { newest: null, days: 14 },
        expected: { since: new Date('2026-10-09T12:00:00Z'), until: null },
      },
      {
        situation: 'the newest stored merge was on 22 Oct, so the read starts on 20 Oct',
        input: { newest: new Date('2026-10-22T08:30:00Z'), days: 14 },
        expected: { since: new Date('2026-10-20T08:30:00Z'), until: null },
      },
      {
        situation: 'a window given by hand, the backfill, is read whatever is stored',
        input: {
          newest: new Date('2026-10-22T08:30:00Z'),
          days: 14,
          from: new Date('2026-07-25T00:00:00Z'),
          to: new Date('2026-08-25T00:00:00Z'),
        },
        expected: { since: new Date('2026-07-25T00:00:00Z'), until: new Date('2026-08-25T00:00:00Z') },
      },
    ])('$situation', ({ input, expected }) => {
      expect(sendWindow({ now: NOW, ...input })).toEqual(expected);
    });

    it('asks the Monitor for its newest merge at the selection address, and reads the time it answers', async () => {
      const asked = [];
      const fetchImpl = async (url) => {
        asked.push(url);
        return { ok: true, status: 200, json: async () => ({ newestMerge: '2026-10-22T08:30:00.000Z' }) };
      };

      expect(await newestStored({ url: 'https://monitor.test/', fetchImpl })).toEqual(new Date('2026-10-22T08:30:00Z'));
      expect(asked).toEqual(['https://monitor.test/v1/selection']);
    });

    it.each([
      { situation: 'a page that is not JSON, such as a login page', json: async () => JSON.parse('<!doctype html>') },
      { situation: 'a newest merge that is not a time', json: async () => ({ newestMerge: 'yesterday' }) },
    ])("an answer that is not a newest merge, $situation, is the Monitor's failure, not a crash", async ({ json }) => {
      const fetchImpl = async () => ({ ok: true, status: 200, json });
      await expect(newestStored({ url: 'https://monitor.test', fetchImpl })).rejects.toThrow(MonitorError);
    });
  });

  describe('a send larger than one batch goes as several, each with the bars, and a failure partway says how many went', () => {
    it('more pull requests than one batch holds go as several batches, every pull request once, with the write key and the bars', async () => {
      const { fetchImpl, sent } = stubMonitor();
      const pulls = Array.from({ length: 7 }, (_, i) => pull(i + 1));

      const result = await sendPulls({ url: 'https://monitor.test/', key: 'k', pulls, bars: BARS, fetchImpl, maxPulls: 3 });

      expect(result).toEqual({ batches: 3, pulls: 7 });
      expect(sent).toEqual([
        { url: 'https://monitor.test/v1/selection', authorization: 'Bearer k', numbers: [1, 2, 3], bars: BARS },
        { url: 'https://monitor.test/v1/selection', authorization: 'Bearer k', numbers: [4, 5, 6], bars: BARS },
        { url: 'https://monitor.test/v1/selection', authorization: 'Bearer k', numbers: [7], bars: BARS },
      ]);
    });

    it('a batch full of characters closes before a pull request that would overrun it', () => {
      const big = (number) => pull(number, { title: 'x'.repeat(1_000) });

      const batches = cutBatches([big(1), big(2), big(3)], { maxChars: 2_500 });

      expect(batches.map((batch) => batch.map((p) => p.number))).toEqual([[1, 2], [3]]);
    });

    it('the bars every batch carries count against its characters, so no request body passes the cap', async () => {
      const bars = { ...BARS, items: [{ ...BARS.items[0], name: 'y'.repeat(600) }] };
      const bodies = [];
      const fetchImpl = async (_url, init) => {
        bodies.push(init.body.length);
        return { ok: true, status: 200, json: async () => ({}) };
      };
      const pulls = Array.from({ length: 5 }, (_, i) => pull(i + 1, { title: 'x'.repeat(900) }));

      await sendPulls({ url: 'https://monitor.test', key: 'k', pulls, bars, fetchImpl, maxChars: 3_000 });

      expect(bodies.length).toBeGreaterThan(1);
      expect(Math.max(...bodies)).toBeLessThanOrEqual(3_000);
    });

    it('a pull request too large for a batch on its own is refused, saying which', () => {
      expect(() => cutBatches([pull(7, { title: 'x'.repeat(3_000) })], { maxChars: 2_500 })).toThrow('Pull request 7 is');
    });

    it('a batch the Monitor refuses stops the send, naming the reason and how many batches were stored before it', async () => {
      const { fetchImpl, sent } = stubMonitor({ refuse: [2] });
      const pulls = Array.from({ length: 7 }, (_, i) => pull(i + 1));

      const failure = await sendPulls({ url: 'https://monitor.test', key: 'k', pulls, bars: BARS, fetchImpl, maxPulls: 3 }).catch((error) => error);

      expect(failure).toBeInstanceOf(MonitorError);
      expect(failure.message).toContain('refused batch 2 of 3 (400: Pull request 0 (#9): job test package api file a.test.ts has no selectedBy.)');
      expect(failure.message).toContain('1 batch of 3 was stored (3 pull requests)');
      expect(sent).toHaveLength(2);
    });

    it('a Monitor that cannot be reached stops the send as the Monitor\'s failure', async () => {
      const fetchImpl = async () => {
        throw new Error('connect ECONNREFUSED');
      };

      await expect(sendPulls({ url: 'https://monitor.test', key: 'k', pulls: [pull(1)], bars: BARS, fetchImpl })).rejects.toThrow('Could not reach the Harness Monitor with batch 1 of 1');
    });
  });
});
