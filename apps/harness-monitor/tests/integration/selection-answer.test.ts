import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionAnswer } from '../../src/selection-store';
import { emptyTheDatabase, fullPackage, ranEverything, selectionFile, selectionJob, selectionPackage, selectionPull, sendSelection } from './support';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
  return emptyTheDatabase();
});
afterEach(() => vi.useRealTimers());

const theAnswer = async (query = ''): Promise<SelectionAnswer> => {
  const response = await SELF.fetch(`https://monitor.test/selection?format=json${query.replace('?', '&')}`);
  expect(response.status).toBe(200);
  return response.json();
};

const MERGED = '2026-10-10T10:00:00Z';
const times = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));
const barOf = (answer: SelectionAnswer, id: string) => answer.bars.items.find((bar) => bar.id === id)!;

/** Thirty pull requests, the first nine of which ran E2E in full by a rule, five on one path and four on another. */
const thirtyWithNineFull = () =>
  times(30, (index) =>
    selectionPull(index + 1, {
      mergedAt: MERGED,
      jobs: [selectionJob('test'), index < 9 ? ranEverything('e2e', 'owned by no concept', index < 5 ? 'apps/api/src/a.ts' : 'apps/api/src/b.ts') : selectionJob('e2e')],
    }),
  );

describe('Harness Monitor', () => {
  describe('test selection answers, for a period and job, each bar with its count, threshold and verdict, the rules that forced a full run and the misses', () => {
    it('nine of thirty pull requests running E2E in full is over the 25% bar, led by the rule that forced them', async () => {
      await sendSelection(thirtyWithNineFull());

      const answer = await theAnswer();

      expect(barOf(answer, 'e2e-forced-full')).toMatchObject({
        job: 'e2e',
        count: 9,
        of: 30,
        value: 0.3,
        threshold: 0.25,
        verdict: 'crossed',
        unread: null,
        cause: { rule: 'owned by no concept', count: 9 },
      });
      expect(barOf(answer, 'test-forced-full')).toMatchObject({ count: 0, of: 30, verdict: 'within' });
      expect(answer.forcedFullRules).toMatchObject([
        {
          job: 'e2e',
          rule: 'owned by no concept',
          count: 9,
          of: 30,
          share: 0.3,
          verdict: 'crossed',
          paths: [
            { path: 'apps/api/src/a.ts', count: 5 },
            { path: 'apps/api/src/b.ts', count: 4 },
          ],
        },
      ]);
    });

    it('twelve pull requests are too few for any bar to be read, however bad they look', async () => {
      await sendSelection(times(12, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [selectionJob('test'), ranEverything('e2e', 'owned by no concept', null)] })));

      const answer = await theAnswer();

      expect(answer.bars).toMatchObject({ minPulls: 20, read: false });
      expect(answer.bars.items.map((bar) => [bar.id, bar.verdict, bar.unread])).toEqual([
        ['e2e-forced-full', 'unread', 'window'],
        ['test-forced-full', 'unread', 'window'],
        ['misses', 'unread', 'window'],
      ]);
      expect(barOf(answer, 'e2e-forced-full')).toMatchObject({ count: 12, of: 12, value: 1 });
    });

    it('the answer reads no most-selected list and no most-selected bar, though the Monitor still holds the bar an earlier send stored', async () => {
      const hot = 'apps/api/tests/unit/hot.test.ts';
      await sendSelection(times(20, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [selectionJob('test', { packages: [selectionPackage('api', [selectionFile(hot)])] }), selectionJob('e2e')] })));
      expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM selection_bars WHERE id = 'most-selected'").first<{ n: number }>())!.n).toBe(1);

      const answer = await theAnswer();

      expect(answer).not.toHaveProperty('mostSelected');
      expect(answer.bars.items.map((bar) => bar.id)).toEqual(['e2e-forced-full', 'test-forced-full', 'misses']);
      expect(JSON.stringify(answer)).not.toContain('most-selected');
      expect(JSON.stringify(answer)).not.toContain(hot);
    });

    it('a rule that forced one package of several is listed, and reads within the bar because it left the job selecting', async () => {
      const oneForced = selectionJob('test', {
        packages: [fullPackage('api', 'a package config changed', 'apps/api/vitest.config.ts', ['a.test.ts']), selectionPackage('web', [])],
      });
      await sendSelection(times(30, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [oneForced, selectionJob('e2e')] })));

      const answer = await theAnswer();

      expect(answer.forcedFullRules).toMatchObject([{ job: 'test', rule: 'a package config changed', count: 30, of: 30, share: 1, verdict: 'within' }]);
      expect(barOf(answer, 'test-forced-full')).toMatchObject({ count: 0, of: 30, verdict: 'within' });
    });

    it('counts only the pull requests merged from the start of the period\'s first Belgian day', async () => {
      // 9 Oct begins in Brussels at 22:00 UTC on the 8th.
      const missed = [{ job: 'test', path: 'a.test.ts', level: 'unit', reason: null }];
      await sendSelection([
        selectionPull(1, { mergedAt: '2026-10-08T21:59:00Z', misses: missed }),
        selectionPull(2, { mergedAt: '2026-10-08T22:00:00Z', misses: missed }),
      ]);

      const answer = await theAnswer('?period=7d');

      expect(answer.firstDay).toBe('2026-10-09');
      expect(answer.pulls.total).toBe(1);
      expect(answer.misses.map((miss) => miss.pull.number)).toEqual([2]);
      expect(barOf(answer, 'misses')).toMatchObject({ count: 1, verdict: 'unread' });
    });

    it('a job asked for alone is read alone: its own bars, rules and misses', async () => {
      await sendSelection(thirtyWithNineFull());

      const e2e = await theAnswer('?job=e2e');
      const test = await theAnswer('?job=test');

      expect(e2e.bars.items.map((bar) => bar.id)).toEqual(['e2e-forced-full', 'misses']);
      expect(e2e.forcedFullRules.map((rule) => rule.job)).toEqual(['e2e']);
      expect(test.bars.items.map((bar) => bar.id)).toEqual(['test-forced-full', 'misses']);
      expect(test.forcedFullRules).toEqual([]);
    });

    it('a period or job it does not know is read as the bars\' own: 14 days, both jobs', async () => {
      await sendSelection(thirtyWithNineFull());

      const answer = await theAnswer('?period=forever&job=nobody');

      expect(answer).toMatchObject({ period: '14d', job: 'both', pulls: { total: 30 } });
    });

    it('with nothing stored, the answer is empty and reads nothing', async () => {
      const answer = await theAnswer();

      expect(answer).toMatchObject({ period: '14d', job: 'both', firstDay: '2026-10-02', storedFrom: null, pulls: { total: 0 }, forcedFullRules: [], misses: [] });
      expect(answer.bars).toMatchObject({ read: false, items: [] });
    });
  });
});
