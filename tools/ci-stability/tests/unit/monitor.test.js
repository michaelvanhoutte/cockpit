import { describe, expect, it } from 'vitest';

import { cutBatches, MonitorError, sendRuns, sendWindow } from '../../src/monitor.js';

const NOW = new Date('2026-10-23T12:00:00Z');

const run = (id, over = {}) => ({ id, workflow: 'CI', jobs: [], ...over });

/** A Monitor that stores every batch but the ones named, and keeps what it was sent. */
function stubMonitor({ refuse = [] } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const { runs } = JSON.parse(init.body);
    sent.push({ url, authorization: init.headers.authorization, ids: runs.map((r) => r.id) });
    if (refuse.includes(sent.length)) {
      return { ok: false, status: 400, json: async () => ({ error: 'Run 0 (9): has no conclusion.' }) };
    }
    return { ok: true, status: 200, json: async () => ({ stored: runs.length }) };
  };
  return { fetchImpl, sent };
}

describe('CI stability', () => {
  describe('the next send starts from the newest run the Monitor holds, less two days', () => {
    it.each([
      {
        situation: 'the Monitor holds nothing, so the tool reads its own default window',
        input: { newest: null, days: 30 },
        expected: { since: new Date('2026-09-23T12:00:00Z'), until: null },
      },
      {
        situation: 'the newest stored run started on 22 Oct, so the read starts on 20 Oct',
        input: { newest: new Date('2026-10-22T08:30:00Z'), days: 30 },
        expected: { since: new Date('2026-10-20T08:30:00Z'), until: null },
      },
      {
        situation: 'a window given by hand, the backfill, is read whatever is stored',
        input: {
          newest: new Date('2026-10-22T08:30:00Z'),
          days: 30,
          from: new Date('2026-07-25T00:00:00Z'),
          to: new Date('2026-08-25T00:00:00Z'),
        },
        expected: { since: new Date('2026-07-25T00:00:00Z'), until: new Date('2026-08-25T00:00:00Z') },
      },
    ])('$situation', ({ input, expected }) => {
      expect(sendWindow({ now: NOW, ...input })).toEqual(expected);
    });
  });

  describe('a send larger than one batch goes as several, and a failure partway says how many went', () => {
    it('more runs than one batch holds go as several batches, every run once, with the write key', async () => {
      const { fetchImpl, sent } = stubMonitor();
      const runs = Array.from({ length: 7 }, (_, i) => run(i + 1));

      const result = await sendRuns({ url: 'https://monitor.test/', key: 'k', runs, fetchImpl, maxRuns: 3 });

      expect(result).toEqual({ batches: 3, runs: 7 });
      expect(sent).toEqual([
        { url: 'https://monitor.test/v1/stability', authorization: 'Bearer k', ids: [1, 2, 3] },
        { url: 'https://monitor.test/v1/stability', authorization: 'Bearer k', ids: [4, 5, 6] },
        { url: 'https://monitor.test/v1/stability', authorization: 'Bearer k', ids: [7] },
      ]);
    });

    it('runs too large together go in separate batches, and one too large alone is refused before anything is sent', () => {
      const big = (id) => run(id, { workflow: 'x'.repeat(400) });

      expect(cutBatches([big(1), big(2), big(3)], { maxRuns: 50, maxChars: 1_000 }).map((b) => b.map((r) => r.id))).toEqual([[1, 2], [3]]);
      expect(() => cutBatches([run(1), big(2)], { maxRuns: 50, maxChars: 300 })).toThrow('Run 2 is');
    });

    it('the second of three batches refused stops the send, saying one batch of three was stored and why', async () => {
      const { fetchImpl, sent } = stubMonitor({ refuse: [2] });
      const runs = Array.from({ length: 7 }, (_, i) => run(i + 1));

      const sending = sendRuns({ url: 'https://monitor.test', key: 'k', runs, fetchImpl, maxRuns: 3 });

      await expect(sending).rejects.toThrow(MonitorError);
      await expect(sending).rejects.toThrow(
        'The Harness Monitor refused batch 2 of 3 (400: Run 0 (9): has no conclusion.). 1 batch of 3 was stored (3 runs)',
      );
      expect(sent).toHaveLength(2);
    });
  });
});
