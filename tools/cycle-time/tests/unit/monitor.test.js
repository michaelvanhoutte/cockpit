import { describe, expect, it } from 'vitest';

import { BATCH_CHARS, cutBatches, MonitorError, newestStored, sendPulls, sendTimelines, sendWindow } from '../../src/monitor.js';

const NOW = new Date('2026-10-23T12:00:00Z');

const pull = (number, over = {}) => ({ number, title: 'A change', rounds: [], ...over });

/** A Monitor that stores every batch but the ones named, and keeps what it was sent. */
function stubMonitor({ refuse = [] } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const rows = body.pulls ?? body.timelines;
    sent.push({ url, authorization: init.headers.authorization, numbers: rows.map((p) => p.number) });
    if (refuse.includes(sent.length)) {
      return { ok: false, status: 400, json: async () => ({ error: 'Pull request 0 (#9): has no list of rounds.' }) };
    }
    return { ok: true, status: 200, json: async () => ({ stored: rows.length }) };
  };
  return { fetchImpl, sent };
}

describe('Cycle time', () => {
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

    it('asks the Monitor for its newest merge at the cycle-time address, and reads the time it answers', async () => {
      const asked = [];
      const fetchImpl = async (url) => {
        asked.push(url);
        return { ok: true, status: 200, json: async () => ({ newestMerge: '2026-10-22T08:30:00.000Z' }) };
      };

      expect(await newestStored({ url: 'https://monitor.test/', fetchImpl })).toEqual(new Date('2026-10-22T08:30:00Z'));
      expect(asked).toEqual(['https://monitor.test/v1/cycle-time']);
    });

    it.each([
      { situation: 'a page that is not JSON, such as a login page', json: async () => JSON.parse('<!doctype html>') },
      { situation: 'a newest merge that is not a time', json: async () => ({ newestMerge: 'yesterday' }) },
    ])("an answer that is not a newest merge, $situation, is the Monitor's failure, not a crash", async ({ json }) => {
      const fetchImpl = async () => ({ ok: true, status: 200, json });
      await expect(newestStored({ url: 'https://monitor.test', fetchImpl })).rejects.toThrow(MonitorError);
    });
  });

  describe('a send larger than one batch goes as several, and a failure partway says how many went', () => {
    it('more pull requests than one batch holds go as several batches, every pull request once, with the write key', async () => {
      const { fetchImpl, sent } = stubMonitor();
      const pulls = Array.from({ length: 7 }, (_, i) => pull(i + 1));

      const result = await sendPulls({ url: 'https://monitor.test/', key: 'k', pulls, fetchImpl, maxPulls: 3 });

      expect(result).toEqual({ batches: 3, pulls: 7 });
      expect(sent).toEqual([
        { url: 'https://monitor.test/v1/cycle-time', authorization: 'Bearer k', numbers: [1, 2, 3] },
        { url: 'https://monitor.test/v1/cycle-time', authorization: 'Bearer k', numbers: [4, 5, 6] },
        { url: 'https://monitor.test/v1/cycle-time', authorization: 'Bearer k', numbers: [7] },
      ]);
    });

    it('pull requests too large together go in separate batches, and one too large alone is refused before anything is sent', () => {
      const big = (number) => pull(number, { title: 'x'.repeat(400) });

      expect(cutBatches([big(1), big(2), big(3)], { maxPulls: 50, maxChars: 1_000 }).map((b) => b.map((p) => p.number))).toEqual([[1, 2], [3]]);
      expect(() => cutBatches([pull(1), big(2)], { maxPulls: 50, maxChars: 300 })).toThrow('Pull request 2 is');
    });

    it('the second of three batches refused stops the send, saying one batch of three was stored and why', async () => {
      const { fetchImpl, sent } = stubMonitor({ refuse: [2] });
      const pulls = Array.from({ length: 7 }, (_, i) => pull(i + 1));

      const sending = sendPulls({ url: 'https://monitor.test', key: 'k', pulls, fetchImpl, maxPulls: 3 });

      await expect(sending).rejects.toThrow(MonitorError);
      await expect(sending).rejects.toThrow(
        'The Harness Monitor refused batch 2 of 3 (400: Pull request 0 (#9): has no list of rounds.). 1 batch of 3 was stored (3 pull requests)',
      );
      expect(sent).toHaveLength(2);
    });
  });

  describe("a batch is closed by its pull requests' timelines as well as their count, so the Monitor never nears its cap on one value", () => {
    /** A pull request whose timeline is about `chars` characters of lanes. */
    const withTimeline = (number, chars) => pull(number, { timeline: { lanes: [[{ name: 'x'.repeat(chars) }]], reviewSlices: [], runSlices: [] } });

    it.each([
      { situation: '50 small pull requests', pulls: Array.from({ length: 50 }, (_, i) => withTimeline(i + 1, 5_000)), batches: [50] },
      { situation: 'timelines adding up past the size a batch takes', pulls: Array.from({ length: 10 }, (_, i) => withTimeline(i + 1, 100_000)), batches: [3, 3, 3, 1] },
    ])('$situation go in batches of $batches, every pull request once', ({ pulls, batches }) => {
      const cut = cutBatches(pulls);

      expect(cut.map((batch) => batch.length)).toEqual(batches);
      expect(cut.flat().map((p) => p.number)).toEqual(pulls.map((p) => p.number));
    });

    it('one timeline too large for a batch alone fails the send before anything is sent, naming its pull request', async () => {
      const { fetchImpl, sent } = stubMonitor();

      const sending = sendPulls({ url: 'https://monitor.test', key: 'k', pulls: [withTimeline(1, 5_000), withTimeline(2, BATCH_CHARS)], fetchImpl });

      await expect(sending).rejects.toThrow(/^Pull request 2 is \d+ characters, more than one send takes/);
      expect(sent).toEqual([]);
    });

    it('timelines sent alone go to the timeline address, batched the same way', async () => {
      const { fetchImpl, sent } = stubMonitor();
      const timelines = Array.from({ length: 4 }, (_, i) => ({ number: i + 1, timeline: withTimeline(i + 1, 10).timeline }));

      const result = await sendTimelines({ url: 'https://monitor.test/', key: 'k', timelines, fetchImpl, maxPulls: 3 });

      expect(result).toEqual({ batches: 2, pulls: 4 });
      expect(sent).toEqual([
        { url: 'https://monitor.test/v1/cycle-time/timelines', authorization: 'Bearer k', numbers: [1, 2, 3] },
        { url: 'https://monitor.test/v1/cycle-time/timelines', authorization: 'Bearer k', numbers: [4] },
      ]);
    });
  });

  describe('a timeline the Monitor refuses keeps no other timeline from being stored, and the send fails naming it', () => {
    const timelines = Array.from({ length: 5 }, (_, i) => ({ number: i + 1, timeline: { lanes: [], reviewSlices: [], runSlices: [] } }));

    /** A Monitor that answers `status` to any send holding pull request 2, and stores every other. */
    function refusingTwo(status) {
      const sent = [];
      const fetchImpl = async (_url, init) => {
        const numbers = JSON.parse(init.body).timelines.map((t) => t.number);
        sent.push(numbers);
        if (!numbers.includes(2)) return { ok: true, status: 200, json: async () => ({ stored: numbers.length }) };
        return { ok: false, status, json: async () => ({ error: 'Timeline 0 (#2): has a timeline of 2 rounds, but the stored pull request has 1.' }) };
      };
      return { fetchImpl, sent };
    }

    it('a batch refused for what the Monitor holds is sent again one timeline at a time, and the batches after it are still sent', async () => {
      const { fetchImpl, sent } = refusingTwo(400);

      const sending = sendTimelines({ url: 'https://monitor.test', key: 'k', timelines, fetchImpl, maxPulls: 3 });

      await expect(sending).rejects.toThrow(
        'The Harness Monitor refused 1 timeline and stored the other 4. Running the window again refuses it again: a pull request the Monitor does not hold needs sending first, and one whose rounds differ from the stored ones keeps no timeline.\n  Timeline 0 (#2): has a timeline of 2 rounds, but the stored pull request has 1.',
      );
      expect(sent).toEqual([[1, 2, 3], [1], [2], [3], [4, 5]]);
    });

    it('a batch the Monitor fails on for any other reason stops the send, as a send of pull requests does', async () => {
      const { fetchImpl, sent } = refusingTwo(500);

      await expect(sendTimelines({ url: 'https://monitor.test', key: 'k', timelines, fetchImpl, maxPulls: 3 })).rejects.toThrow('The Harness Monitor refused batch 1 of 2 (500');
      expect(sent).toEqual([[1, 2, 3]]);
    });
  });
});
