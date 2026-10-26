import { describe, expect, it } from 'vitest';
import { barsOf, dayRange, groupByStart, matchesOutcome, outcomeOf, overBar, packageRows, parseSelectionQuery, ruleRows, selectionAddress, type SelectedFile, verdictOf, whyText } from '../../src/selection-report';
import type { PackageRun, ViewJob, ViewPull } from '../../src/selection-view';

const ran = (over: Partial<ViewJob> = {}): ViewJob => ({ status: 'ran', ranEverything: false, selecting: true, filesRun: 12, filesTotal: 300, prDurationMs: null, mainDurationMs: null, unplacedFiles: null, reasons: [], misses: [], ...over });
const full = (rule: string, path: string | null): ViewJob => ran({ ranEverything: true, selecting: false, reasons: [{ rule, path }] });
const pull = (number: number, jobs: Partial<ViewPull['jobs']> = {}): ViewPull => ({ number, title: `Pull request ${number}`, url: `https://github.com/o/r/pull/${number}`, mergedAt: Date.parse('2026-10-10T10:00:00Z'), jobs: { test: ran(), e2e: ran(), ...jobs } });
const times = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));
const bars = barsOf([]);

describe('Harness Monitor', () => {
  describe("a job's bar is judged on the pull requests of the period and reads unread under the number it needs", () => {
    it.each([
      { situation: '9 of 30 pull requests ran everything, bar 25%', ranEverything: 9, of: 30, over: true },
      { situation: '5 of 30', ranEverything: 5, of: 30, over: false },
      { situation: '7 of 28, exactly a quarter', ranEverything: 7, of: 28, over: true },
      { situation: '12 of 12 is too few pull requests to read', ranEverything: 12, of: 12, over: false },
    ])('$situation', ({ ranEverything, of, over }) => {
      const pulls = times(of, (index) => pull(index + 1, { e2e: index < ranEverything ? full('owned by no concept', null) : ran() }));

      expect(overBar(pulls, 'e2e', bars)).toBe(over);
    });

    it.each([
      { situation: 'a share at the bar', value: 0.25, verdict: 'crossed' },
      { situation: 'a share under it', value: 0.1, verdict: 'within' },
      { situation: 'no share to give', value: null, verdict: 'unread' },
    ])('$situation reads $verdict when the period is big enough', ({ value, verdict }) => {
      expect(verdictOf(true, value, 0.25)).toBe(verdict);
    });

    it('a period too small to read leaves every bar unread, whatever the share', () => {
      expect(verdictOf(false, 1, 0.25)).toBe('unread');
    });

    it("takes the bars' numbers from the last send, and the tool's own where none was sent", () => {
      const sent = barsOf([{ id: 'test-forced-full', threshold: 0.4, minOver: null, minPulls: 30, alarmIssue: 1502 }]);

      expect(sent).toMatchObject({ minPulls: 30, forcedFull: { test: 0.4, e2e: 0.25 }, alarm: { 'test-forced-full': 1502, misses: null } });
      expect(bars).toMatchObject({ minPulls: 20, forcedFull: { test: 0.25, e2e: 0.25 }, misses: 1, mostShare: 0.8, mostMinOver: 10 });
    });
  });

  describe('a pull request is counted by what each job did with it', () => {
    it.each([
      { situation: 'a job that selected a subset', job: ran(), outcome: 'selected' },
      { situation: 'a job that ran everything', job: full('any tsconfig', null), outcome: 'full' },
      { situation: 'a job that never started on a documentation-only pull request', job: ran({ status: 'docs-only' }), outcome: 'docs' },
      { situation: 'a job that left no record', job: ran({ status: 'no-record' }), outcome: 'none' },
    ])('$situation is $outcome', ({ job, outcome }) => {
      expect(outcomeOf(job)).toBe(outcome);
    });

    it('the Pull request tab keeps the ones with a miss, or those that skipped both jobs', () => {
      const missed = pull(1, { test: ran({ misses: [{ path: 'a.test.ts', level: 'unit', reason: null }] }) });
      const docs = pull(2, { test: ran({ status: 'docs-only' }), e2e: ran({ status: 'docs-only' }) });

      expect([missed, docs].filter((p) => matchesOutcome(p, ['test', 'e2e'], 'miss'))).toEqual([missed]);
      expect([missed, docs].filter((p) => matchesOutcome(p, ['test', 'e2e'], 'docs'))).toEqual([docs]);
      expect([missed, docs].filter((p) => matchesOutcome(p, ['test'], 'miss'))).toEqual([missed]);
      expect([missed, docs].filter((p) => matchesOutcome(p, ['e2e'], 'miss'))).toEqual([]);
    });
  });

  describe('a rule that forced a full run counts a pull request once, however many of its paths the rule named', () => {
    it('a pull request that two paths forced counts once for the rule and once for each path', () => {
      const twice = ran({ ranEverything: true, selecting: false, reasons: [{ rule: 'outside every package', path: 'a.ts' }, { rule: 'outside every package', path: 'b.ts' }] });
      const pulls = [pull(1, { test: twice }), pull(2, { test: full('outside every package', 'b.ts') }), pull(3)];

      const [row] = ruleRows(pulls, ['test']);

      expect(row).toMatchObject({ job: 'test', rule: 'outside every package', of: 3 });
      expect(row!.pulls.size).toBe(2);
      expect([...row!.paths.entries()].map(([path, list]) => [path, list.map((p) => p.number)])).toEqual([['a.ts', [1]], ['b.ts', [1, 2]]]);
    });

    it("a rule that forced one package of several is listed, though the pull request did not run everything", () => {
      const oneOfSeveral = ran({ reasons: [{ rule: 'own migration', path: 'apps/api/migrations/0001.sql' }] });

      const [row] = ruleRows([pull(1, { test: oneOfSeveral })], ['test']);

      expect(row!.pulls.size).toBe(1);
      expect(row!.everything.size).toBe(0);
    });

    it('lists the rules of the jobs chosen, the most pull requests first', () => {
      const pulls = [pull(1, { test: full('a', null), e2e: full('b', null) }), pull(2, { e2e: full('b', null) })];

      expect(ruleRows(pulls, ['test', 'e2e']).map((r) => [r.job, r.rule, r.pulls.size])).toEqual([['e2e', 'b', 2], ['test', 'a', 1]]);
      expect(ruleRows(pulls, ['test']).map((r) => r.rule)).toEqual(['a']);
    });
  });

  describe('a package is read by how often a selecting pull request ran something of it', () => {
    it('counts the pull requests it selected on, those it ran something on, and its whole runs, apart', () => {
      const runs: PackageRun[] = [
        { job: 'test', name: 'api', mode: 'changed', report: 'written', rule: null, ran: 4, filesTotal: null },
        { job: 'test', name: 'api', mode: 'changed', report: 'written', rule: null, ran: 0, filesTotal: null },
        { job: 'test', name: 'api', mode: 'full', report: 'written', rule: 'own migration', ran: 30, filesTotal: null },
        { job: 'test', name: 'web', mode: 'changed', report: 'written', rule: null, ran: 0, filesTotal: null },
      ];

      const [api, web] = packageRows(runs);

      expect(api).toMatchObject({ name: 'api', changed: 2, touched: 1, runs: [4], full: 1 });
      expect([...api!.reasons]).toEqual([['own migration', 1]]);
      expect(web).toMatchObject({ name: 'web', changed: 1, touched: 0, full: 0 });
    });

    it('leaves out a run whose process wrote no report, which says nothing of what it ran', () => {
      const [api] = packageRows([
        { job: 'test', name: 'api', mode: 'changed', report: 'written', rule: null, ran: 4, filesTotal: null },
        { job: 'test', name: 'api', mode: 'changed', report: 'none', rule: null, ran: 0, filesTotal: null },
      ]);

      expect(api).toMatchObject({ changed: 1, touched: 1 });
    });

    it('reads its size as the most test files any pull request found in it, and as not recorded where none sent a total', () => {
      const [api, web] = packageRows([
        { job: 'test', name: 'api', mode: 'changed', report: 'written', rule: null, ran: 1, filesTotal: 40 },
        { job: 'test', name: 'api', mode: 'full', report: 'written', rule: 'own migration', ran: 44, filesTotal: 44 },
        { job: 'test', name: 'api', mode: 'changed', report: 'written', rule: null, ran: 1, filesTotal: null },
        { job: 'test', name: 'web', mode: 'changed', report: 'written', rule: null, ran: 0, filesTotal: null },
      ]);

      expect(api!.files).toBe(44);
      expect(web!.files).toBeNull();
    });

    it('every E2E spec is one row, whatever its packages are called', () => {
      const rows = packageRows([
        { job: 'e2e', name: 'desktop', mode: 'changed', report: 'written', rule: null, ran: 2, filesTotal: null },
        { job: 'e2e', name: 'phone', mode: 'changed', report: 'written', rule: null, ran: 0, filesTotal: null },
      ]);

      expect(rows.map((r) => [r.name, r.changed])).toEqual([['Every E2E spec', 2]]);
    });
  });

  describe("a view's address names only what differs from the default, and a drill-down belongs to its own tab", () => {
    it.each([
      { situation: 'the bare address', address: '/selection', group: 'day', period: '14d', job: 'both' },
      { situation: 'a tab, a period and a job', address: '/selection?group=rule&period=7d&job=e2e', group: 'rule', period: '7d', job: 'e2e' },
      { situation: 'a period nothing knows', address: '/selection?period=forever', group: 'day', period: '14d', job: 'both' },
    ])('$situation', ({ address, group, period, job }) => {
      const q = parseSelectionQuery(new URL(address, 'https://monitor.test').searchParams);

      expect(q).toMatchObject({ group, period, job });
      expect(selectionAddress(q)).toBe(address.includes('forever') ? '/selection' : address);
    });

    it.each([
      { situation: 'a pull request on its own tab', address: '/selection?group=pr&pr=77&outcome=miss', drill: { pr: 77, outcome: 'miss' } },
      { situation: 'a pull request on another tab is ignored', address: '/selection?group=rule&pr=77&outcome=miss', drill: { pr: null, outcome: null } },
      { situation: 'a rule', address: '/selection?group=rule&rule=test%3Aown%20migration', drill: { rule: 'test:own migration' } },
      { situation: 'a test', address: '/selection?group=test&test=apps%2Fapi%2Fa.test.ts', drill: { test: 'apps/api/a.test.ts' } },
    ])('$situation', ({ address, drill }) => {
      expect(parseSelectionQuery(new URL(address, 'https://monitor.test').searchParams)).toMatchObject(drill);
    });

    it('a link to another tab leaves the drill-down behind and keeps the period and job', () => {
      const q = parseSelectionQuery(new URL('/selection?group=pr&pr=77&period=7d&job=test', 'https://monitor.test').searchParams);

      expect(selectionAddress(q, { group: 'rule', rule: 'test:any tsconfig' })).toBe('/selection?group=rule&period=7d&job=test&rule=test%3Aany+tsconfig');
      expect(selectionAddress(q, { group: 'pr' })).toBe('/selection?group=pr&period=7d&job=test');
    });
  });

  describe('a selection reads in words, the chain without the test at its head', () => {
    const path = 'apps/api/tests/unit/a.test.ts';

    it.each([
      { situation: 'a chain from a changed file', text: `${path} → apps/api/src/b.ts → apps/api/src/c.ts`, words: 'via apps/api/src/b.ts → apps/api/src/c.ts' },
      { situation: 'the file itself changed', text: 'itself changed', words: 'itself changed' },
      { situation: 'a chain of one is the file itself', text: path, words: 'itself changed' },
      { situation: 'a spec an area owns', text: 'owned by Capture, which `apps/web/src/capture.ts` changed', words: 'owned by Capture, which apps/web/src/capture.ts changed' },
      { situation: 'a file Vitest selected on a trigger the graph does not carry', text: null, words: 'selected by Vitest; no import chain found' },
    ])('$situation', ({ text, words }) => {
      expect(whyText(text, path)).toBe(words);
    });
  });

  describe('the files a check selected are grouped by the changed file their chain started from, largest group first', () => {
    /** A file picked through the steps of `chain` from the changed file at its end. */
    const through = (path: string, ...chain: string[]): SelectedFile => ({ package: 'api', path, status: 'passed', text: [path, ...chain].join(' → ') });
    const ofPackage = (name: string, file: SelectedFile): SelectedFile => ({ ...file, package: name });
    const times = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));
    const labelled = (files: SelectedFile[]) => groupByStart(files).map((g) => [g.label, g.files.length]);

    it('167 files from item.ts and 32 from client.ts put item.ts first, each with how many files of each package it holds', () => {
      const files = [
        ...times(32, (n) => ofPackage('web', through(`apps/web/tests/unit/c${n}.test.ts`, 'apps/web/src/client.ts'))),
        ...times(100, (n) => through(`apps/api/tests/unit/i${n}.test.ts`, 'apps/api/src/item.ts')),
        ...times(67, (n) => ofPackage('web', through(`apps/web/tests/unit/i${n}.test.ts`, 'apps/api/src/item.ts'))),
      ];

      const groups = groupByStart(files);

      expect(groups.map((g) => [g.label, g.files.length, g.byPackage])).toEqual([
        ['apps/api/src/item.ts', 167, [['api', 100], ['web', 67]]],
        ['apps/web/src/client.ts', 32, [['web', 32]]],
      ]);
    });

    it('groups of equal size are ordered by path', () => {
      const files = [through('t/1.test.ts', 'src/b.ts'), through('t/2.test.ts', 'src/c.ts'), through('t/3.test.ts', 'src/a.ts')];

      expect(labelled(files)).toEqual([['src/a.ts', 1], ['src/b.ts', 1], ['src/c.ts', 1]]);
    });

    it('test files whose chain is only their own path are one group: the test files that changed themselves', () => {
      const own = (path: string): SelectedFile => ({ package: 'api', path, status: 'passed', text: path });
      const files = [own('t/1.test.ts'), { package: 'api', path: 't/2.test.ts', status: 'passed', text: 'itself changed' } as SelectedFile, through('t/3.test.ts', 'src/a.ts')];

      expect(groupByStart(files).map((g) => [g.kind, g.label, g.files.length])).toEqual([
        ['itself', 'The test files that changed themselves', 2],
        ['file', 'src/a.ts', 1],
      ]);
    });

    it('a file with no chain text is its own group, whatever else was selected', () => {
      const files = [{ package: 'api', path: 't/1.test.ts', status: 'passed', text: null } as SelectedFile, through('t/2.test.ts', 'src/a.ts')];

      expect(groupByStart(files).map((g) => [g.kind, g.label])).toEqual([['none', 'no import chain found'], ['file', 'src/a.ts']]);
    });

    it('an E2E spec picked by its area is grouped under the words of the area, backticks left out', () => {
      const spec = (path: string): SelectedFile => ({ package: 'e2e', path, status: 'passed', text: 'owned by Panels, through `apps/web/src/DashboardBar.tsx`, changed' });

      expect(labelled([spec('tests/e2e/a.test.ts'), spec('tests/e2e/b.test.ts')])).toEqual([['owned by Panels, through apps/web/src/DashboardBar.tsx, changed', 2]]);
    });

    it.each([
      { situation: '155 of 167 chains passing through index.ts just before item.ts', size: 167, through: 155, said: { step: 'apps/api/src/index.ts', count: 155 } },
      { situation: 'half of a group of ten, which is enough', size: 10, through: 5, said: { step: 'apps/api/src/index.ts', count: 5 } },
      { situation: 'three of a group of five', size: 5, through: 3, said: { step: 'apps/api/src/index.ts', count: 3 } },
      { situation: 'all of a group of four, too few to say anything about', size: 4, through: 4, said: null },
      { situation: 'four of a group of ten, under half', size: 10, through: 4, said: null },
    ])('$situation', ({ size, through: viaIndex, said }) => {
      const files = times(size, (n) => (n < viaIndex ? through(`t/${n}.test.ts`, 'apps/api/src/index.ts', 'apps/api/src/item.ts') : through(`t/${n}.test.ts`, `apps/api/src/other-${n}.ts`, 'apps/api/src/item.ts')));

      expect(groupByStart(files)[0]!.through).toEqual(said);
    });

    it('a chain straight from the test file to the changed file has no step before the changed file to be mostly through', () => {
      const files = times(6, (n) => through(`t/${n}.test.ts`, 'apps/api/src/item.ts'));

      expect(groupByStart(files)[0]).toMatchObject({ label: 'apps/api/src/item.ts', through: null });
    });
  });

  describe('the overview lists each Belgian day of the period, from the first pull request held where that is later', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');

    it.each([
      { situation: 'seven days, all of them held', period: '7d', oldest: '2026-09-01T10:00:00Z', first: '2026-10-09', days: 7 },
      { situation: 'seven days, held only from the 13th', period: '7d', oldest: '2026-10-13T10:00:00Z', first: '2026-10-13', days: 3 },
      { situation: 'everything held starts at the oldest pull request', period: 'all', oldest: '2026-10-01T10:00:00Z', first: '2026-10-01', days: 15 },
      { situation: 'nothing held is today alone', period: 'all', oldest: null, first: '2026-10-15', days: 1 },
    ] as const)('$situation', ({ period, oldest, first, days }) => {
      const range = dayRange(period, oldest === null ? null : Date.parse(oldest), now);

      expect(range[0]).toBe(first);
      expect(range.at(-1)).toBe('2026-10-15');
      expect(range).toHaveLength(days);
    });
  });
});
