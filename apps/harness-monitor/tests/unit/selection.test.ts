import { describe, expect, it } from 'vitest';
import { checkSelection, MAX_PULLS } from '../../src/selection';

const file = (path: string, over: Record<string, unknown> = {}) => ({
  path,
  level: 'unit',
  status: 'passed',
  selectedBy: { kind: 'chain', chain: [path, 'src/a.ts'], text: `${path} → src/a.ts` },
  ...over,
});

const pkg = (over: Record<string, unknown> = {}) => ({ name: 'api', dir: 'apps/api', mode: 'changed', report: 'written', reason: null, files: [file('a.test.ts')], ...over });

const job = (name: string, over: Record<string, unknown> = {}) => ({
  job: name,
  status: 'ran',
  ranEverything: false,
  selecting: true,
  filesRun: 1,
  filesTotal: 10,
  prDurationMs: null,
  mainDurationMs: null,
  changedFiles: [{ path: 'src/a.ts', ignored: false }],
  packages: [pkg()],
  ...over,
});

const pull = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: 'A change',
  url: `https://github.com/o/r/pull/${number}`,
  mergedAt: '2026-10-01T12:00:00Z',
  jobs: [job('test'), job('e2e')],
  misses: [],
  ...over,
});

const bars = (over: Record<string, unknown> = {}) => ({
  windowDays: 14,
  minPulls: 20,
  items: [{ id: 'e2e-forced-full', name: 'E2E forced to run every spec', threshold: 0.25, minOver: null }],
  ...over,
});

const send = (pulls: unknown[], over: Record<string, unknown> = {}) => checkSelection({ pulls, bars: bars(), ...over });
const refusal = (pulls: unknown[], over: Record<string, unknown> = {}) => {
  const checked = send(pulls, over);
  return checked.ok ? null : checked.error;
};

describe('Harness Monitor', () => {
  describe('a selection row of the wrong shape is refused, naming it', () => {
    it('accepts a send of well-formed pull requests, turning the merge time into milliseconds', () => {
      const checked = send([pull(1)]);

      expect(checked.ok).toBe(true);
      if (checked.ok) expect(checked.pulls[0]!.mergedAt).toBe(Date.parse('2026-10-01T12:00:00Z'));
    });

    it.each([
      {
        situation: 'a selected file with no chain',
        pulls: [pull(9, { jobs: [job('test', { packages: [pkg({ files: [{ path: 'odd.test.ts', level: 'unit', status: 'passed' }] })] }), job('e2e')] })],
        error: 'Pull request 0 (#9): job test package api file odd.test.ts has no selectedBy.',
      },
      {
        situation: 'a job other than Test or E2E',
        pulls: [pull(9, { jobs: [job('test'), job('lint')] })],
        error: 'Pull request 0 (#9): has job "lint", which is not test or e2e.',
      },
      {
        situation: 'a job sent twice',
        pulls: [pull(9, { jobs: [job('test'), job('test')] })],
        error: 'Pull request 0 (#9): has job test twice.',
      },
      {
        situation: 'a pull request without its E2E job',
        pulls: [pull(9, { jobs: [job('test')] })],
        error: 'Pull request 0 (#9): has no e2e job.',
      },
      {
        situation: 'a file the job did not run, which is never sent',
        pulls: [pull(9, { jobs: [job('test', { packages: [pkg({ files: [file('skipped.test.ts', { status: 'not run' })] })] }), job('e2e')] })],
        error: 'Pull request 0 (#9): job test package api file skipped.test.ts has status "not run", which is not passed or failed. Only the files a job ran are sent.',
      },
      {
        situation: 'a file of a package that ran everything, claiming it was picked',
        pulls: [pull(9, { jobs: [job('test', { packages: [pkg({ mode: 'full' })] }), job('e2e')] })],
        error: 'Pull request 0 (#9): job test package api file a.test.ts ran in a full package but its selectedBy is chain.',
      },
      {
        situation: 'a file of a package that selected, claiming it ran whole',
        pulls: [pull(9, { jobs: [job('test', { packages: [pkg({ files: [file('a.test.ts', { selectedBy: { kind: 'full' } })] })] }), job('e2e')] })],
        error: 'Pull request 0 (#9): job test package api file a.test.ts ran in a package that selected, but its selectedBy is full.',
      },
      {
        situation: 'an import chain with no steps',
        pulls: [pull(9, { jobs: [job('test', { packages: [pkg({ files: [file('a.test.ts', { selectedBy: { kind: 'chain', chain: [], text: 'x' } })] })] }), job('e2e')] })],
        error: 'Pull request 0 (#9): job test package api file a.test.ts has a selectedBy chain that is not a list of 1 to 100 paths.',
      },
      {
        situation: 'a file sent twice in one package',
        pulls: [pull(9, { jobs: [job('test', { packages: [pkg({ files: [file('a.test.ts'), file('a.test.ts')] })] }), job('e2e')] })],
        error: 'Pull request 0 (#9): job test package api has file a.test.ts twice.',
      },
      {
        situation: 'a job that never ran, naming packages',
        pulls: [pull(9, { jobs: [job('test', { status: 'docs-only' }), job('e2e')] })],
        error: 'Pull request 0 (#9): job test is docs-only but names packages, files run, or ran everything or selected.',
      },
      {
        situation: 'a merge time without a zone',
        pulls: [pull(9, { mergedAt: '2026-10-01T12:00:00' })],
        error: 'Pull request 0 (#9): has a mergedAt that is not an ISO 8601 timestamp with a time zone.',
      },
      {
        situation: 'a pull request in the send twice',
        pulls: [pull(9), pull(9)],
        error: 'Pull request 1 (#9): is in the send twice.',
      },
      {
        situation: 'a miss of no job',
        pulls: [pull(9, { misses: [{ path: 'a.test.ts', level: 'unit', reason: null }] })],
        error: 'Pull request 0 (#9): miss 0 has job null, which is not test or e2e.',
      },
    ])('$situation', ({ pulls, error }) => {
      expect(refusal(pulls)).toBe(error);
    });

    it.each([
      { situation: 'no bars', over: { bars: undefined }, error: 'The send has no bars.' },
      { situation: 'a bar that is not one the answer reads', over: { bars: bars({ items: [{ id: 'speed', name: 'Speed', threshold: 1 }] }) }, error: 'A bar has id "speed", which is not e2e-forced-full or test-forced-full or misses or most-selected.' },
      { situation: 'a threshold that is not above zero', over: { bars: bars({ items: [{ id: 'misses', name: 'Misses', threshold: 0 }] }) }, error: 'Bar misses has threshold 0, which is not a number above zero.' },
      { situation: 'a bar sent twice', over: { bars: bars({ items: [{ id: 'misses', name: 'Misses', threshold: 1 }, { id: 'misses', name: 'Misses', threshold: 1 }] }) }, error: 'The bars have misses twice.' },
    ])('$situation is refused', ({ over, error }) => {
      expect(refusal([pull(1)], over)).toBe(error);
    });

    it('a send without a package total or a count of unplaced files is taken, and reads as not recorded', () => {
      const checked = send([pull(1)]);

      expect(checked.ok && checked.pulls[0]!.jobs.map((j) => [j.unplacedFiles, j.packages[0]!.filesTotal])).toEqual([[null, null], [null, null]]);
    });

    it('keeps a package total and a count of unplaced files as sent, a count of none as none and not as missing', () => {
      const sent = pull(1, { jobs: [job('test', { packages: [pkg({ filesTotal: 40 })] }), job('e2e', { unplacedFiles: 0, packages: [pkg({ filesTotal: 1 })] })] });

      const checked = send([sent]);

      expect(checked.ok && checked.pulls[0]!.jobs.map((j) => [j.unplacedFiles, j.packages[0]!.filesTotal])).toEqual([[null, 40], [0, 1]]);
    });

    it.each([
      { situation: 'a package total that is not a whole number', packages: [pkg({ filesTotal: 2.5 })], error: 'Pull request 0 (#9): job test package api has filesTotal 2.5, which is not a whole number, zero or more.' },
      { situation: 'a package total below the files the package names', packages: [pkg({ filesTotal: 0 })], error: 'Pull request 0 (#9): job test package api has filesTotal 0, fewer than the 1 files it names.' },
      { situation: 'a negative count of unplaced files', over: { unplacedFiles: -1 }, error: 'Pull request 0 (#9): job test has unplacedFiles -1, which is not a whole number, zero or more.' },
      { situation: 'a count of unplaced files on a job that never ran', over: { status: 'docs-only', selecting: false, filesRun: null, filesTotal: null, packages: [], unplacedFiles: 3 }, error: 'Pull request 0 (#9): job test is docs-only but names packages, files run, or ran everything or selected.' },
    ])('$situation is refused', ({ packages, over, error }) => {
      expect(refusal([pull(9, { jobs: [job('test', { ...(packages ? { packages } : {}), ...over }), job('e2e')] })])).toBe(error);
    });

    it('a send of no pull requests, or of more than one send takes, is refused', () => {
      expect(refusal([])).toBe('The send has no pull requests.');
      expect(refusal(Array.from({ length: MAX_PULLS + 1 }, (_, i) => pull(i + 1)))).toBe(`The send has ${MAX_PULLS + 1} pull requests; the most one send takes is ${MAX_PULLS}.`);
    });

    it('keeps an alarm issue that was not sent apart from one sent as none', () => {
      const checked = send([pull(1)], { bars: bars({ items: [{ id: 'misses', name: 'Misses', threshold: 1, alarmIssue: null }, { id: 'most-selected', name: 'Most', threshold: 0.8, minOver: 10 }] }) });

      expect(checked.ok && checked.bars.items.map((item) => item.alarmIssue)).toEqual([null, undefined]);
    });
  });
});
