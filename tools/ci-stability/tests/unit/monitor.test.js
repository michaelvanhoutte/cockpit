import { describe, expect, it } from 'vitest';

import { cutBatches, MonitorError, newestStored, newestStoredAttempt, sendAttempts, sendRuns, sendWindow } from '../../src/monitor.js';

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

    it.each([
      { situation: 'a page that is not JSON, such as a login page', json: async () => JSON.parse('<!doctype html>') },
      { situation: 'a newest run that is not a time', json: async () => ({ newestRun: 'yesterday' }) },
    ])('an answer that is not a newest run, $situation, is the Monitor\'s failure, not a crash', async ({ json }) => {
      const fetchImpl = async () => ({ ok: true, status: 200, json });
      await expect(newestStored({ url: 'https://monitor.test', fetchImpl })).rejects.toThrow(MonitorError);
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

  describe('the attempts have their own newest, on main or on any other branch, and their own batches', () => {
    it.each([
      { on: 'main', url: 'https://monitor.test/v1/ci-attempts?on=main' },
      { on: 'branches', url: 'https://monitor.test/v1/ci-attempts?on=branches' },
    ])('the newest attempt on $on is asked of $url', async ({ on, url }) => {
      const asked = [];
      const fetchImpl = async (address) => {
        asked.push(address);
        return { ok: true, status: 200, json: async () => ({ newestAttempt: '2026-10-22T08:00:00.000Z' }) };
      };

      expect(await newestStoredAttempt({ url: 'https://monitor.test/', on, fetchImpl })).toEqual(new Date('2026-10-22T08:00:00Z'));
      expect(asked).toEqual([url]);
    });

    it("a Monitor holding no attempt says null, and one that does not know the address is the Monitor's failure, not a crash", async () => {
      const none = async () => ({ ok: true, status: 200, json: async () => ({ newestAttempt: null }) });
      const missing = async () => ({ ok: false, status: 404, json: async () => ({}) });

      expect(await newestStoredAttempt({ url: 'https://monitor.test', fetchImpl: none })).toBeNull();
      await expect(newestStoredAttempt({ url: 'https://monitor.test', fetchImpl: missing })).rejects.toThrow('The Harness Monitor answered 404 when asked its newest attempt.');
    });

    it('more attempts than one batch holds go as several batches, and a refusal names the batch and how many were stored', async () => {
      const sent = [];
      const fetchImpl = async (url, init) => {
        const { attempts } = JSON.parse(init.body);
        sent.push({ url, ids: attempts.map((a) => `${a.runId}/${a.attempt}`) });
        return sent.length === 2
          ? { ok: false, status: 400, json: async () => ({ error: 'Attempt 0 (run 4, attempt 1): has no conclusion.' }) }
          : { ok: true, status: 200, json: async () => ({ stored: attempts.length }) };
      };
      const attempts = Array.from({ length: 7 }, (_, i) => ({ runId: i + 1, attempt: 1, jobs: [], failedJobs: [] }));

      await expect(sendAttempts({ url: 'https://monitor.test', key: 'k', attempts, fetchImpl, maxRuns: 3 })).rejects.toThrow(
        'The Harness Monitor refused batch 2 of 3 (400: Attempt 0 (run 4, attempt 1): has no conclusion.). 1 batch of 3 was stored (3 attempts)',
      );
      expect(sent).toEqual([
        { url: 'https://monitor.test/v1/ci-attempts', ids: ['1/1', '2/1', '3/1'] },
        { url: 'https://monitor.test/v1/ci-attempts', ids: ['4/1', '5/1', '6/1'] },
      ]);
    });

    it('an attempt too large for a batch on its own is refused before anything is sent, naming it', async () => {
      const big = { runId: 8, attempt: 2, failedJobs: [{ name: 'x'.repeat(400) }] };

      await expect(sendAttempts({ url: 'https://monitor.test', key: 'k', attempts: [big], fetchImpl: async () => ({ ok: true }), maxChars: 300 })).rejects.toThrow('Attempt 2 of run 8 is');
    });
  });
});
