import { beforeEach, describe, expect, it } from 'vitest';
import { area, model, rules } from '../fixtures/tests-model';
import { linked, pullRequest } from './github-support';
import { emptyTheDatabase, sendTestsModel, storedTests, theTests } from './support';

beforeEach(emptyTheDatabase);

const A = 'aaaaaaa';
const B = 'bbbbbbb';
const MAIN = 'ccccccc';

/** A pull request's tests at `commit`, its one area named after it so whose they are shows. */
const testsAt = (commit: string, name: string, over: Record<string, unknown> = {}) => model([area(name, rules(1, 'L1', 'apps/api/tests/unit/a.test.ts'))], { commit, ...over });
const areaNames = (answer: Record<string, unknown>) => (answer.tree as { key: string }[]).map((a) => a.key);

/** A pull request as linking reads it from GitHub: open, merged or closed unmerged, on a branch of its own unless told. */
const read = (number: number, state: 'OPEN' | 'MERGED' | 'CLOSED', over: { headRefName?: string; updatedAt?: string } = {}) =>
  pullRequest({ number, headRefName: `b/${number}`, state, mergedAt: state === 'MERGED' ? '2026-10-24T08:00:00Z' : null, updatedAt: '2026-10-24T08:00:00Z', ...over });

describe('Harness Monitor', () => {
  describe("a pull request's tests are filed under the number they are sent for, replacing its previous push's, and never under a number inside them", () => {
    it('tests sent for pull request 9001 are shown for 9001', async () => {
      await sendTestsModel(testsAt(A, 'First push'), {}, 'pr-9001');

      expect(await theTests(9001)).toMatchObject({ commit: A });
    });

    it("a second push's tests for 9001 leave only the second stored", async () => {
      await sendTestsModel(testsAt(A, 'First push'), {}, 'pr-9001');
      await sendTestsModel(testsAt(B, 'Second push'), {}, 'pr-9001');

      expect(await storedTests('pr-9001')).toEqual({ commits: [{ commit: B, areas: 1 }], current: B });
      expect(areaNames(await theTests(9001))).toEqual(['Second push']);
    });

    it('tests claiming pull request 9002, sent for 9001, are filed under 9001', async () => {
      await sendTestsModel(testsAt(A, 'Claims 9002', { pullRequest: 9002, commitUrl: 'https://github.com/o/r/pull/9002' }), {}, 'pr-9001');

      expect(areaNames(await theTests(9001))).toEqual(['Claims 9002']);
      expect(await theTests(9002)).toMatchObject({ commit: null, note: "No snapshot of pull request 9002's tests is held." });
    });

    it("tests sent for main and for 9001 are each their own, and main's are unchanged", async () => {
      await sendTestsModel(testsAt(MAIN, 'Main'));
      await sendTestsModel(testsAt(A, 'Pull request'), {}, 'pr-9001');

      expect(await theTests()).toMatchObject({ commit: MAIN });
      expect(areaNames(await theTests())).toEqual(['Main']);
      expect(areaNames(await theTests(9001))).toEqual(['Pull request']);
      expect(await storedTests()).toEqual({ commits: [{ commit: MAIN, areas: 1 }], current: MAIN });
    });
  });

  describe("linking deletes a pull request's tests once it merges or closes, and keeps an open one's", () => {
    it.each([
      { situation: '9001 merged and 9003 open', pulls: [read(9001, 'MERGED'), read(9003, 'OPEN')], gone: [9001], kept: [9003] },
      { situation: '9004 closed unmerged', pulls: [read(9004, 'CLOSED')], gone: [9004], kept: [] },
      {
        situation: '9006 closed and 9007 opened on the same branch',
        pulls: [read(9006, 'CLOSED', { headRefName: 'b/shared', updatedAt: '2026-10-24T08:00:00Z' }), read(9007, 'OPEN', { headRefName: 'b/shared', updatedAt: '2026-10-24T09:00:00Z' })],
        gone: [9006],
        kept: [9007],
      },
    ])("$situation: the merged or closed one's are gone, the open one's and main's kept", async ({ pulls, gone, kept }) => {
      await sendTestsModel(testsAt(MAIN, 'Main'));
      for (const p of pulls) await sendTestsModel(testsAt(A, `Pull request ${p.number}`), {}, `pr-${p.number}`);

      await linked(...pulls);

      for (const n of gone) expect(await storedTests(`pr-${n}`)).toEqual({ commits: [], current: null });
      for (const n of kept) expect(await storedTests(`pr-${n}`)).toEqual({ commits: [{ commit: A, areas: 1 }], current: A });
      expect((await storedTests()).current).toBe(MAIN);
    });

    it('tests that land after linking read their pull request as closed are gone at the next linking', async () => {
      await linked(read(9005, 'CLOSED'));
      await sendTestsModel(testsAt(A, 'Late'), {}, 'pr-9005');

      await linked();

      expect(await storedTests('pr-9005')).toEqual({ commits: [], current: null });
    });
  });
});
