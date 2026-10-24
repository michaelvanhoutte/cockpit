import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { MonitorError, sendSnapshot, snapshotParts } from '../../src/monitor.js';

const lines = (line) => [{ line, text: `line ${line}` }];
const ref = (file, line) => ({ file, line, context: lines(line) });

/** A model of `count` areas, each with one rule of one case, and the first area's gap. */
function model(count) {
  const node = (i) => ({
    key: `Area ${i}`,
    label: `Area ${i}`,
    counts: { L1: 1 },
    rules: [{ ...ref(`area-${i}.test.ts`, 3), concept: `Area ${i}`, statement: 'a rule', level: 'L1', cases: [{ ...ref(`area-${i}.test.ts`, 4), text: 'a case' }], todoCases: [] }],
    filesNothingRuns: i === 1 ? [ref('lonely.ts', 1)] : [],
    branchesNothingTakes: null,
    path: [],
    children: [],
  });
  return { commit: 'abc1234', coverageAvailable: false, tree: Array.from({ length: count }, (_, i) => node(i + 1)) };
}

/** A Monitor that takes every part but the request numbered `refuse`, and keeps what it was sent. */
function stubMonitor({ refuse = null } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, method: init.method, authorization: init.headers.authorization, body: init.body ? JSON.parse(gunzipSync(init.body)) : null });
    if (sent.length === refuse) return { ok: false, status: 400, json: async () => ({ error: 'not a list' }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fetchImpl, sent };
}

describe('Test explorer', () => {
  describe("main's tests go to the Monitor as a tree without source lines and each area's source lines", () => {
    it('the tree carries no source lines, and each area carries its own by file and line', () => {
      const parts = snapshotParts(model(2));

      expect(JSON.stringify(parts.tree)).not.toContain('context');
      expect(parts.tree.tree[0].rules[0]).toMatchObject({ file: 'area-1.test.ts', line: 3, statement: 'a rule' });
      expect(parts.areas).toEqual([
        { key: 'Area 1', lines: { 'area-1.test.ts:3': lines(3), 'area-1.test.ts:4': lines(4), 'lonely.ts:1': lines(1) } },
        { key: 'Area 2', lines: { 'area-2.test.ts:3': lines(3), 'area-2.test.ts:4': lines(4) } },
      ]);
    });
  });

  describe("main's tests are sent tree first, then each area, then shown, and a refused part stops the send naming it", () => {
    it('every part taken, the switch is the last request, with the write key on each', async () => {
      const { fetchImpl, sent } = stubMonitor();

      await sendSnapshot({ url: 'https://monitor.test/', key: 'k', model: model(3), fetchImpl });

      expect(sent.map((s) => [s.method, s.url])).toEqual([
        ['PUT', 'https://monitor.test/v1/tests/main/abc1234/tree'],
        ['PUT', 'https://monitor.test/v1/tests/main/abc1234/areas/Area%201'],
        ['PUT', 'https://monitor.test/v1/tests/main/abc1234/areas/Area%202'],
        ['PUT', 'https://monitor.test/v1/tests/main/abc1234/areas/Area%203'],
        ['POST', 'https://monitor.test/v1/tests/main/abc1234/current'],
      ]);
      expect(sent.every((s) => s.authorization === 'Bearer k')).toBe(true);
      expect(sent[2].body).toEqual({ 'area-2.test.ts:3': lines(3), 'area-2.test.ts:4': lines(4) });
    });

    it('area 12 refused, nothing is shown and the failure names area 12', async () => {
      const { fetchImpl, sent } = stubMonitor({ refuse: 13 });

      const sending = sendSnapshot({ url: 'https://monitor.test', key: 'k', model: model(37), fetchImpl });

      await expect(sending).rejects.toThrow(MonitorError);
      await expect(sending).rejects.toThrow(/^The Harness Monitor refused area 12 of 37 \("Area 12"\) \(400: not a list\)/);
      expect(sent.at(-1).url).toBe('https://monitor.test/v1/tests/main/abc1234/areas/Area%2012');
      expect(sent.some((s) => s.url.endsWith('/current'))).toBe(false);
    });
  });

  describe("a pull request's tests go to that pull request's, never where the model points", () => {
    it("sent as pull request 9001's, every part goes to its tests and not main's, whatever the model says", async () => {
      const { fetchImpl, sent } = stubMonitor();

      await sendSnapshot({ url: 'https://monitor.test', key: 'k', model: { ...model(1), pullRequest: 9002 }, pullRequest: 9001, fetchImpl });

      expect(sent.map((s) => s.url)).toEqual([
        'https://monitor.test/v1/tests/pr-9001/abc1234/tree',
        'https://monitor.test/v1/tests/pr-9001/abc1234/areas/Area%201',
        'https://monitor.test/v1/tests/pr-9001/abc1234/current',
      ]);
    });

    it.each([
      { situation: 'a commit that is not one', over: { commit: '../main/abc1234' }, error: /^The model's commit "\.\.\/main\/abc1234" is not one; nothing was sent\.$/ },
      { situation: 'an area an address would read as a step up', over: { tree: [{ ...model(1).tree[0], key: '..' }] }, error: /^The model names an area "\.\.", which no address can carry; nothing was sent\.$/ },
    ])('a model with $situation is refused before anything is sent', async ({ over, error }) => {
      const { fetchImpl, sent } = stubMonitor();

      await expect(sendSnapshot({ url: 'https://monitor.test', key: 'k', model: { ...model(1), ...over }, pullRequest: 9001, fetchImpl })).rejects.toThrow(error);
      expect(sent).toEqual([]);
    });
  });
});
