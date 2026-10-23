import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLike, fakeCockpit, giveTheWorkerTheReadToken, RECORDED_CALLS, runTheImport, runTheRebuild, theCallTotals, theCopies, theRoute } from './cockpit-support';
import { jobLine } from './github-support';
import { emptyTheDatabase, send, storedRequestIds, totals, usage } from './support';

let putBack: () => void;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-23T12:00:00Z') });
  await emptyTheDatabase();
  putBack = giveTheWorkerTheReadToken();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  putBack();
});

describe('Harness Monitor', () => {
  describe("one of Cockpit's Claude calls leaves the Monitor 12 months after it was made, and nothing else does", () => {
    it('the nightly rebuild drops a copy 12 months and a day old from the copies and the totals, and keeps the rest', async () => {
      fakeCockpit(
        theRoute([
          callLike({ id: 1, at: '2025-10-22T12:00:00.000Z', feature: 'a-year-and-a-day' }),
          callLike({ id: 2, at: '2025-10-24T12:00:00.000Z', feature: 'a-day-short-of-a-year' }),
        ]),
      );
      await runTheImport();
      await send([usage('two-years-old', { time: '2024-10-01T10:00:00Z' })]);

      await runTheRebuild();

      expect(await theCopies()).toEqual([2]);
      expect((await theCallTotals()).map((t) => t.feature)).toEqual(['a-day-short-of-a-year']);
      expect(await storedRequestIds()).toEqual(['two-years-old']);
      expect((await totals()).map((t) => t.day)).toEqual(['2024-10-01']);
      expect(await jobLine('rebuild')).toContain('Rebuilt the totals for 1 day; dropped 1 Claude call older than 12 months.');
    });
  });

  describe("the rebuild gives the same totals of Cockpit's Claude calls the imports wrote", () => {
    it('totals after several imports, then a rebuild, are identical', async () => {
      for (const [from, to] of [
        [0, 2],
        [2, 4],
        [4, RECORDED_CALLS.length],
      ] as const) {
        fakeCockpit(theRoute(RECORDED_CALLS.slice(from, to)));
        await runTheImport();
        vi.restoreAllMocks();
      }
      fakeCockpit(theRoute([callLike({ id: 2000, at: '2026-10-21T09:00:00.000Z' }), callLike({ id: 2001, at: '2026-10-21T10:00:00.000Z', costUsd: null })]));
      await runTheImport();
      const imported = await theCallTotals();

      await runTheRebuild();

      expect(imported.reduce((sum, t) => sum + t.calls, 0)).toBe(RECORDED_CALLS.length + 2);
      expect(await theCallTotals()).toEqual(imported);
    });
  });
});
