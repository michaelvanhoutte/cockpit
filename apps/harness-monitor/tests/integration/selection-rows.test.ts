import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionAnswer } from '../../src/selection-store';
import { docsOnly, emptyTheDatabase, ranEverything, selectionBars, selectionFile, selectionJob, selectionPackage, selectionPull, sendSelection, storedSelection } from './support';

beforeEach(emptyTheDatabase);
afterEach(() => vi.useRealTimers());

const theAnswer = async (query = '?period=all'): Promise<SelectionAnswer> => {
  const response = await SELF.fetch(`https://monitor.test/selection${query}`);
  expect(response.status).toBe(200);
  return response.json();
};

const twelveFiles = Array.from({ length: 12 }, (_, i) => selectionFile(`apps/api/tests/unit/t${i}.test.ts`));

describe('Harness Monitor', () => {
  describe("a pull request's selection per job is stored once, with its selected files and their chains, and a later send replaces it", () => {
    it('a Test job that selected 12 files and an E2E job that ran everything by a rule are two rows, the 12 files with their chains, and the rule', async () => {
      const response = await sendSelection([
        selectionPull(101, {
          jobs: [
            selectionJob('test', { packages: [selectionPackage('api', twelveFiles)] }),
            ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts', ['tests/e2e/capture.test.ts']),
          ],
        }),
      ]);

      expect(response.status).toBe(200);
      expect(await storedSelection()).toEqual([
        { pull_number: 101, job: 'e2e', status: 'ran', packages: 1, files: 1, changed: 1 },
        { pull_number: 101, job: 'test', status: 'ran', packages: 1, files: 12, changed: 1 },
      ]);
      const answer = await theAnswer();
      expect(answer.forcedFullRules).toMatchObject([{ job: 'e2e', rule: 'owned by no concept', paths: [{ path: 'apps/api/src/a.ts', count: 1 }] }]);
      expect(answer.mostSelected.find((row) => row.path === 'apps/api/tests/unit/t0.test.ts')).toMatchObject({
        job: 'test',
        selectedPulls: 1,
        mostCommonChain: 'apps/api/tests/unit/t0.test.ts → apps/api/src/a.ts',
      });
    });

    it('the same pull request sent again is stored once, with what the later send holds', async () => {
      await sendSelection([selectionPull(101, { jobs: [selectionJob('test', { packages: [selectionPackage('api', twelveFiles)] }), selectionJob('e2e')] })]);
      await sendSelection([selectionPull(101, { jobs: [selectionJob('test', { packages: [selectionPackage('api', twelveFiles.slice(0, 3))] }), selectionJob('e2e')] })]);

      expect(await storedSelection()).toEqual([
        { pull_number: 101, job: 'e2e', status: 'ran', packages: 0, files: 0, changed: 1 },
        { pull_number: 101, job: 'test', status: 'ran', packages: 1, files: 3, changed: 1 },
      ]);
    });

    it('a documentation-only pull request is stored as documentation only, with no files', async () => {
      await sendSelection([selectionPull(7, { jobs: [docsOnly('test'), docsOnly('e2e')] })]);

      expect(await storedSelection()).toEqual([
        { pull_number: 7, job: 'e2e', status: 'docs-only', packages: 0, files: 0, changed: 1 },
        { pull_number: 7, job: 'test', status: 'docs-only', packages: 0, files: 0, changed: 1 },
      ]);
      expect((await theAnswer()).pulls.jobs).toMatchObject([
        { job: 'test', ran: 0, docsOnly: 1 },
        { job: 'e2e', ran: 0, docsOnly: 1 },
      ]);
    });

    it('a file of a package that ran everything is stored as run whole, with no chain', async () => {
      await sendSelection([selectionPull(8, { jobs: [ranEverything('test', 'a lockfile changed', 'pnpm-lock.yaml', ['apps/api/tests/unit/a.test.ts']), selectionJob('e2e')] })]);

      expect(await theAnswer()).toMatchObject({
        mostSelected: [{ path: 'apps/api/tests/unit/a.test.ts', selectedPulls: 0, fullRunPulls: 1, mostCommonChain: null }],
      });
    });
  });

  describe('a miss found after the pull request was stored reaches it on the next send', () => {
    it('a pull request sent without a miss and then with one has the miss', async () => {
      await sendSelection([selectionPull(101)]);
      expect((await theAnswer()).misses).toEqual([]);

      await sendSelection([selectionPull(101, { misses: [{ job: 'test', path: 'apps/api/tests/unit/missed.test.ts', level: 'unit', reason: null }] })]);

      expect((await theAnswer()).misses).toMatchObject([{ job: 'test', path: 'apps/api/tests/unit/missed.test.ts', level: 'unit', reason: null, pull: { number: 101 } }]);
    });

    it('a miss of the E2E job is told apart by its job', async () => {
      await sendSelection([selectionPull(101, { misses: [{ job: 'e2e', path: 'tests/e2e/capture.test.ts', level: 'e2e', reason: 'docs only' }] })]);

      expect((await theAnswer('?period=all&job=test')).misses).toEqual([]);
      expect((await theAnswer('?period=all&job=e2e')).misses).toMatchObject([{ job: 'e2e', reason: 'docs only' }]);
    });
  });

  describe("the bars' thresholds and open alarm issues sent with the rows are what the verdicts are judged against", () => {
    const barOf = async (id: string) => (await theAnswer()).bars.items.find((bar) => bar.id === id)!;
    const items = (e2e: Record<string, unknown>) => [
      { id: 'e2e-forced-full', name: 'E2E forced to run every spec', minOver: null, ...e2e },
      { id: 'misses', name: 'Misses', threshold: 1, minOver: null, alarmIssue: null },
    ];

    it('a send with the E2E bar at 25% and an open alarm issue reads the bar at 25% and names that issue', async () => {
      await sendSelection([selectionPull(1)], selectionBars({}, items({ threshold: 0.25, alarmIssue: 1234 })));

      expect(await barOf('e2e-forced-full')).toMatchObject({ threshold: 0.25, alarmIssue: 1234 });
    });

    it('a later send with the threshold changed to 30% reads the bar at 30%', async () => {
      await sendSelection([selectionPull(1)], selectionBars({}, items({ threshold: 0.25, alarmIssue: 1234 })));
      await sendSelection([selectionPull(1)], selectionBars({}, items({ threshold: 0.3, alarmIssue: 1234 })));

      expect(await barOf('e2e-forced-full')).toMatchObject({ threshold: 0.3 });
    });

    it.each([
      { situation: 'a send that could not read the alarm issues, which leaves the open one', alarm: undefined, named: 1234 },
      { situation: 'a send that read them and found none open, which clears it', alarm: null, named: null },
      { situation: 'a send that read a newer one', alarm: 1300, named: 1300 },
    ])('$situation', async ({ alarm, named }) => {
      await sendSelection([selectionPull(1)], selectionBars({}, items({ threshold: 0.25, alarmIssue: 1234 })));
      const later = items({ threshold: 0.25, ...(alarm === undefined ? {} : { alarmIssue: alarm }) });

      await sendSelection([selectionPull(1)], selectionBars({}, later));

      expect(await barOf('e2e-forced-full')).toMatchObject({ alarmIssue: named });
    });
  });

  describe('the Monitor says when its newest stored pull request merged, where the next send reads from', () => {
    it.each([
      { situation: 'with nothing stored', sent: [], newestMerge: null },
      {
        situation: 'with pull requests stored',
        sent: [selectionPull(1, { mergedAt: '2026-10-22T08:00:00Z' }), selectionPull(2, { mergedAt: '2026-10-20T08:00:00Z' })],
        newestMerge: '2026-10-22T08:00:00.000Z',
      },
    ])('$situation', async ({ sent, newestMerge }) => {
      if (sent.length > 0) await sendSelection(sent);

      const response = await SELF.fetch('https://monitor.test/v1/selection');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ newestMerge });
    });
  });

  describe("a send of test selection's pull requests without the write key stores nothing", () => {
    it.each([
      { situation: 'with no key', headers: {} },
      { situation: 'with a wrong key', headers: { authorization: 'Bearer not-the-key' } },
    ])('a send $situation is refused', async ({ headers }) => {
      const response = await sendSelection([selectionPull(1)], selectionBars(), headers);

      expect(response.status).toBe(401);
      expect(await storedSelection()).toEqual([]);
    });
  });

  describe('a send holding anything of the wrong shape is refused whole, saying which and why', () => {
    it('a selected file with no chain among good pull requests stores none of the send, and names the file', async () => {
      const noChain = { path: 'apps/api/tests/unit/odd.test.ts', level: 'unit', status: 'passed' };
      const bad = selectionPull(9, { jobs: [selectionJob('test', { packages: [selectionPackage('api', [noChain])] }), selectionJob('e2e')] });

      const response = await sendSelection([selectionPull(1), bad, selectionPull(3)]);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe('Pull request 1 (#9): job test package api file apps/api/tests/unit/odd.test.ts has no selectedBy.');
      expect(await storedSelection()).toEqual([]);
    });
  });
});
