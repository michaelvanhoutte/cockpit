import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docsOnly, emptyTheDatabase, fullPackage, ranEverything, selectionBars, selectionFile, selectionJob, selectionPackage, selectionPull, sendSelection } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
});
afterEach(() => vi.useRealTimers());

const thePage = async (query = '') => {
  const response = await SELF.fetch(`https://monitor.test/selection${query}`);
  expect(response.status).toBe(200);
  return response.text();
};

/** The text of a section's table rows, one array of cell texts per row, the header row left out. */
function rowsOf(html: string, id: string): string[][] {
  const panel = new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';
  return [...panel.matchAll(/<tr[ >].*?<\/tr>/gs)]
    .map((row) => [...row[0].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((cell) => plain(cell[1]!)))
    .filter((cells) => cells.length > 0)
    .slice(1);
}

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&rarr;/g, '→').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const text = (html: string) => plain(html.replace(/<style>.*?<\/style>/s, ''));
const hasSection = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"`).test(html);
const sectionOf = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';
const tiles = (html: string) => [...html.matchAll(/<div class="tile ([^"]*)">(.*?)<\/div>/gs)].map((m) => ({ cls: m[1]!.trim(), text: plain(m[2]!) }));
const headers = (html: string, id: string) => [...(/<thead>.*?<\/thead>/s.exec(sectionOf(html, id))?.[0] ?? '').matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map((m) => plain(m[1]!));

const MERGED = '2026-10-10T10:00:00Z';
const times = <T>(count: number, make: (index: number) => T) => Array.from({ length: count }, (_, index) => make(index));

/** Thirty pull requests, the first nine of which ran E2E in full by a rule, five on one path and four on another. */
const thirtyWithNineFull = () =>
  times(30, (index) =>
    selectionPull(index + 1, {
      mergedAt: MERGED,
      jobs: [selectionJob('test'), index < 9 ? ranEverything('e2e', 'owned by no concept', index < 5 ? 'apps/api/src/a.ts' : 'apps/api/src/b.ts') : selectionJob('e2e')],
    }),
  );

const HOT = 'apps/api/tests/unit/hot.test.ts';
/** Twenty pull requests: seven ran the Test job's package whole, of the thirteen that selected, eleven picked the hot test. */
const hotTest = () =>
  times(20, (index) =>
    selectionPull(index + 1, {
      mergedAt: MERGED,
      jobs: [
        index < 7
          ? ranEverything('test', 'a lockfile changed', 'pnpm-lock.yaml', [HOT])
          : selectionJob('test', { packages: [selectionPackage('api', index < 18 ? [selectionFile(HOT, { selectedBy: { kind: 'chain', chain: [HOT, 'apps/api/src/a.ts', 'apps/api/src/b.ts'], text: `${HOT} → apps/api/src/a.ts → apps/api/src/b.ts` } })] : [])] }),
        selectionJob('e2e'),
      ],
    }),
  );

describe('Harness Monitor', () => {
  describe('test selection is a page, and the same address answers JSON to a request that asks', () => {
    it('opens from its own tab in the top bar, between cycle time and CI stability, with the six tabs of the page on the band', async () => {
      const html = await thePage();

      expect(html).toContain('<a href="/selection" aria-current="page">Test selection</a>');
      expect([...html.matchAll(/<nav class="pages".*?<\/nav>/gs)][0]![0].match(/>([^<]+)<\/a>/g)).toEqual([
        '>Claude Code costs</a>',
        '>Cockpit&rsquo;s Claude calls</a>',
        '>Cycle time</a>',
        '>Test selection</a>',
        '>CI stability</a>',
      ]);
      expect([...html.matchAll(/<nav class="band"[^>]*>.*?<\/nav>/gs)][0]![0].match(/>([^<]+)<\/a>/g)).toEqual([
        '>Overview</a>',
        '>Pull request</a>',
        '>What forced a full run</a>',
        '>Package</a>',
        '>Most selected tests</a>',
        '>Misses</a>',
      ]);
    });

    it('answers JSON to ?format=json or an Accept header for it, and a page to anything else', async () => {
      await sendSelection(thirtyWithNineFull());

      const byParameter = await SELF.fetch('https://monitor.test/selection?format=json');
      const byHeader = await SELF.fetch('https://monitor.test/selection', { headers: { accept: 'application/json' } });
      const byBrowser = await SELF.fetch('https://monitor.test/selection', { headers: { accept: 'text/html,application/xhtml+xml' } });

      expect(byParameter.headers.get('content-type')).toContain('application/json');
      expect(byHeader.headers.get('content-type')).toContain('application/json');
      expect(await byParameter.json()).toEqual(await byHeader.json());
      expect(byBrowser.headers.get('content-type')).toContain('text/html');
    });
  });

  describe("each bar's verdict is judged for the chosen period and job, and reads unread under the pull requests it needs", () => {
    it('nine of thirty pull requests running E2E in full is over the bar, with the rule behind most of them and the alarm issue', async () => {
      await sendSelection(
        thirtyWithNineFull(),
        selectionBars({}, [
          { id: 'e2e-forced-full', name: 'E2E', threshold: 0.25, minOver: null, alarmIssue: 1520 },
          { id: 'test-forced-full', name: 'Test', threshold: 0.25, minOver: null, alarmIssue: null },
          { id: 'misses', name: 'Misses', threshold: 1, minOver: null, alarmIssue: null },
          { id: 'most-selected', name: 'Most selected', threshold: 0.8, minOver: 10, alarmIssue: null },
        ]),
      );

      const html = await thePage();

      const [test, e2e] = tiles(html).filter((t) => /ran everything/i.test(t.text));
      expect(e2e).toMatchObject({ cls: 'up' });
      expect(e2e!.text).toContain('E2E job ran everything 30% 9 of 30 pull requests that ran it · bar 25%');
      expect(html).toContain('Mostly <a href="/selection?group=rule&#38;rule=e2e%3Aowned+by+no+concept">owned by no concept</a>, 9 of them');
      expect(e2e!.text).toContain('Alarm issue #1520');
      expect(html).toContain('href="https://github.com/michaelvanhoutte/cockpit/issues/1520"');
      expect(test).toMatchObject({ cls: 'down' });
      expect(test!.text).toContain('Test job ran everything 0%');
    });

    it('twelve pull requests are too few to read, so no bar judges them and each says what it needs', async () => {
      await sendSelection(times(12, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [selectionJob('test'), ranEverything('e2e', 'owned by no concept', null)] })));

      const all = tiles(await thePage());

      expect(all).toHaveLength(4);
      expect(all.map((t) => t.cls)).toEqual(['', '', '', '']);
      expect(all[0]!.text).toContain('unread: 12 pull requests, a bar needs 20');
    });

    it('the job chosen is read alone: its own tile, and the misses and most selected test of its own rows', async () => {
      await sendSelection(thirtyWithNineFull());

      const e2e = tiles(await thePage('?job=e2e')).map((t) => t.text.split(' ').slice(0, 3).join(' '));

      expect(e2e).toEqual(['E2E job ran', 'Misses 0 a', 'Most selected test']);
    });

    it('a period reaches the pull requests merged from the start of its first Belgian day', async () => {
      // 9 Oct begins in Brussels at 22:00 UTC on the 8th, the first day of the last seven.
      await sendSelection([selectionPull(1, { mergedAt: '2026-10-08T21:59:00Z' }), selectionPull(2, { mergedAt: '2026-10-08T22:00:00Z' })]);

      const html = await thePage('?period=7d&group=pr');

      expect(rowsOf(html, 'by-pull-request').map((row) => row[0])).toEqual([expect.stringContaining('#2 Pull request 2')]);
    });
  });

  describe('the job keeps only its own rows, on every tab', () => {
    it('what forced a full run lists the E2E job\'s rules alone for E2E, and both jobs\' for both', async () => {
      await sendSelection(
        times(30, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [ranEverything('test', 'any tsconfig', 'tsconfig.json'), ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts')] })),
      );

      const e2e = rowsOf(await thePage('?group=rule&job=e2e'), 'by-rule');
      const both = rowsOf(await thePage('?group=rule'), 'by-rule');

      expect(e2e.map((row) => row.slice(0, 2))).toEqual([['E2E job', expect.stringContaining('owned by no concept')]]);
      expect(both.map((row) => row[0])).toEqual(['E2E job', 'Test job']);
    });

    it('the Pull request tab has a column for each job asked for, and only that job\'s outcome', async () => {
      await sendSelection([selectionPull(1, { mergedAt: MERGED, jobs: [selectionJob('test', { filesRun: 4, filesTotal: 50 }), ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts', ['a.test.ts', 'b.test.ts'])] })]);

      const both = await thePage('?group=pr');
      const test = await thePage('?group=pr&job=test');

      expect(headers(both, 'by-pull-request')).toEqual(['Pull request', 'Test job', 'E2E job', 'Misses', 'Test job time']);
      expect(rowsOf(both, 'by-pull-request')[0]!.slice(1, 3)).toEqual(['Selected 4 of 50 test files', 'Ran everything 2 owned by no concept: apps/api/src/a.ts']);
      expect(headers(test, 'by-pull-request')).toEqual(['Pull request', 'Test job', 'Misses', 'Test job time']);
      expect(text(sectionOf(test, 'by-pull-request'))).not.toContain('owned by no concept');
    });

    it('the Misses tab lists the misses of the job asked for, with why a documentation-only pull request did not run them', async () => {
      await sendSelection([
        selectionPull(1, { mergedAt: MERGED, misses: [{ job: 'test', path: 'apps/api/tests/unit/a.test.ts', level: 'unit', reason: null }, { job: 'e2e', path: 'tests/e2e/b.test.ts', level: 'e2e', reason: 'docs only' }] }),
      ]);

      expect(rowsOf(await thePage('?group=miss'), 'misses').map((row) => [row[1], row[3], row[4]])).toEqual([
        ['apps/api/tests/unit/a.test.ts', 'Test job', 'not run'],
        ['tests/e2e/b.test.ts', 'E2E job', 'docs only'],
      ]);
      expect(rowsOf(await thePage('?group=miss&job=e2e'), 'misses').map((row) => row[1])).toEqual(['tests/e2e/b.test.ts']);
    });
  });

  describe("a pull request opens its changed files, each package's mode and reason, its selected files with their chains and its misses", () => {
    const missed = { job: 'test', path: 'apps/api/tests/unit/missed.test.ts', level: 'unit', reason: null };

    it('one that selected a subset in the Test job and ran everything in the E2E job opens both, each as it ran', async () => {
      await sendSelection([
        selectionPull(7, {
          mergedAt: MERGED,
          misses: [missed],
          jobs: [
            selectionJob('test', {
              filesRun: 2,
              filesTotal: 40,
              changedFiles: [{ path: 'apps/api/src/b.ts', ignored: false }, { path: 'docs/readme.md', ignored: true }],
              packages: [
                selectionPackage('api', [selectionFile(HOT, { selectedBy: { kind: 'chain', chain: [HOT, 'apps/api/src/a.ts', 'apps/api/src/b.ts'], text: `${HOT} → apps/api/src/a.ts → apps/api/src/b.ts` } })]),
                fullPackage('web', 'own migration', 'apps/web/migrations/0001.sql', ['apps/web/tests/unit/w.test.ts']),
              ],
            }),
            ranEverything('e2e', 'owned by no concept', 'apps/api/src/x.ts', ['tests/e2e/a.test.ts', 'tests/e2e/b.test.ts']),
          ],
        }),
      ]);

      const html = await thePage('?group=pr&pr=7');
      const drill = text(sectionOf(html, 'pull-request'));

      expect(drill).toContain('#7 Pull request 7');
      expect(drill).toContain('3 changed files');
      expect(drill).toContain('docs/readme.md (ignored by selection)');
      // Test job: each package with its mode and reason, the selected file with the chain behind it, the miss.
      expect(drill).toContain('Selected a subset: 2 of 40 test files run');
      expect(rowsOf(html, 'pull-request').map((row) => row.slice(0, 4))).toEqual(
        expect.arrayContaining([
          ['api', 'changed', '—', '1'],
          ['web', 'full', 'own migration apps/web/migrations/0001.sql', '1'],
          ['e2e', 'full', 'owned by no concept apps/api/src/x.ts', '2'],
        ]),
      );
      expect(drill).toContain(`${HOT} via apps/api/src/a.ts → apps/api/src/b.ts`);
      expect(drill).toContain('1 miss: apps/api/tests/unit/missed.test.ts failed on main and did not run here.');
      expect(drill).toContain('Nothing selected: every package that ran, ran in full.');
    });

    it("says how many of a package's test files each ran, and how many changed files the browser tier placed on no walk, where the send counted them", async () => {
      await sendSelection([
        selectionPull(9, {
          mergedAt: MERGED,
          jobs: [selectionJob('test', { packages: [selectionPackage('api', [selectionFile(HOT)], { filesTotal: 40 })] }), selectionJob('e2e', { unplacedFiles: 2, packages: [selectionPackage('e2e', [], { filesTotal: 30 })] })],
        }),
      ]);

      const html = await thePage('?group=pr&pr=9');

      expect(rowsOf(html, 'pull-request').filter((row) => row[0] !== 'Tier').map((row) => [row[0], row[3]])).toEqual([['api', '1 of 40'], ['e2e', '0 of 30']]);
      expect(text(sectionOf(html, 'pull-request'))).toContain('2 changed files placed no walk');
    });

    it('says nothing of unplaced files where the browser tier placed every one, or the send did not count them', async () => {
      await sendSelection([
        selectionPull(9, { mergedAt: MERGED, jobs: [selectionJob('test'), selectionJob('e2e', { unplacedFiles: 0 })] }),
        selectionPull(10, { mergedAt: MERGED, jobs: [selectionJob('test'), selectionJob('e2e')] }),
      ]);

      expect(text(sectionOf(await thePage('?group=pr&pr=9'), 'pull-request'))).not.toContain('placed no walk');
      expect(text(sectionOf(await thePage('?group=pr&pr=10'), 'pull-request'))).not.toContain('placed no walk');
    });

    it('one that ran everything shows the rule and the paths that forced it, with counts and not every file', async () => {
      await sendSelection([selectionPull(8, { mergedAt: MERGED, jobs: [ranEverything('test', 'any tsconfig', 'tsconfig.json', times(30, (i) => `apps/api/tests/unit/f${i}.test.ts`)), docsOnly('e2e')] })]);

      const drill = text(sectionOf(await thePage('?group=pr&pr=8'), 'pull-request'));

      expect(drill).toContain('Ran everything: 30 of 300 test files run');
      expect(drill).toContain('any tsconfig tsconfig.json');
      expect(drill).not.toContain('f12.test.ts');
      expect(drill).toContain('Skipped: documentation only.');
    });

    it('a pull request nothing holds says so, and still offers the way back', async () => {
      const html = await thePage('?group=pr&pr=999');

      expect(text(html)).toContain('That pull request is not in the data held.');
      expect(html).toContain('<a class="back" href="/selection?group=pr">&larr; Every pull request</a>');
    });

    it('opens from the table of pull requests, and keeps the period and job', async () => {
      await sendSelection([selectionPull(7, { mergedAt: MERGED })]);

      const html = await thePage('?group=pr&period=7d&job=test');

      expect(html).toContain('href="/selection?group=pr&#38;period=7d&#38;job=test&#38;pr=7"');
    });
  });

  describe('a rule opens its paths worst first with their pull requests, and a test opens the pull requests that selected it and why', () => {
    it('a rule forced by two paths lists the one that forced the most pull requests first, with each pull request linked', async () => {
      await sendSelection(thirtyWithNineFull());

      const html = await thePage('?group=rule&rule=e2e%3Aowned%20by%20no%20concept');

      expect(rowsOf(html, 'rule').map((row) => row.slice(0, 2))).toEqual([['apps/api/src/a.ts', '5'], ['apps/api/src/b.ts', '4']]);
      expect(rowsOf(html, 'rule')[0]![2]).toBe('#5 #4 #3 #2 #1');
      expect(text(sectionOf(html, 'rule'))).toContain('E2E job: owned by no concept 9 pull requests of 30 · 2 paths, worst first');
      expect(text(sectionOf(html, 'rule'))).toContain('The area registry cannot place this file');
    });

    it('a rule that forced nothing in the period says so', async () => {
      await sendSelection(thirtyWithNineFull());

      expect(text(await thePage('?group=rule&rule=test%3Aany%20tsconfig'))).toContain('This rule forced nothing in this period for the jobs chosen.');
    });

    it('a test selected on eleven of the thirteen pull requests that could skip it opens those eleven, each with its chain', async () => {
      await sendSelection(hotTest());

      const html = await thePage(`?group=test&test=${encodeURIComponent(HOT)}`);

      const rows = rowsOf(html, 'test');
      expect(rows).toHaveLength(11);
      expect(rows[0]).toEqual([expect.stringContaining('#18 Pull request 18'), 'passed', 'via apps/api/src/a.ts → apps/api/src/b.ts']);
      expect(text(sectionOf(html, 'test'))).toContain('selected on 11 · skipped on 2 · ran in full on 7');
    });

    it('the most selected tests list the hot one first, 11 of the 13 that could skip it, over the 80% bar, with the chain that most often picked it', async () => {
      await sendSelection(hotTest());

      const [first] = rowsOf(await thePage('?group=test'), 'most-selected-tests');

      expect(first).toEqual([`${HOT} via apps/api/src/a.ts → apps/api/src/b.ts`, 'unit', '11 of 13 that could skip it · 85%', '7', 'over the bar']);
    });

    it('a test no pull request in the period ran says so', async () => {
      await sendSelection(hotTest());

      expect(text(await thePage('?group=test&test=apps%2Fapi%2Fnothing.test.ts'))).toContain('No pull request in this period ran this test.');
    });
  });

  describe('the tiles and overview panels are on Overview only, and the pull request select is on Pull request only', () => {
    const tabs = [
      { group: 'day', tiles: true, overview: true, select: false },
      { group: 'pr', tiles: false, overview: false, select: true },
      { group: 'rule', tiles: false, overview: false, select: false },
      { group: 'package', tiles: false, overview: false, select: false },
      { group: 'test', tiles: false, overview: false, select: false },
      { group: 'miss', tiles: false, overview: false, select: false },
    ];

    it.each(tabs)('$group has the tiles: $tiles, the overview panels: $overview, the pull request select: $select', async ({ group, ...expected }) => {
      await sendSelection(thirtyWithNineFull());

      const html = await thePage(`?group=${group}`);

      expect(html.includes('class="tiles"')).toBe(expected.tiles);
      expect(['what-each-job-did', 'typical-pull-request', 'ran-everything-per-day', 'by-day'].map((id) => hasSection(html, id))).toEqual(Array(4).fill(expected.overview));
      expect(html.includes('name="outcome"')).toBe(expected.select);
      expect(html).toContain('name="period"');
      expect(html).toContain('name="job" value="e2e"');
    });

    it('a pull request opened leaves the pull request select behind', async () => {
      await sendSelection([selectionPull(7, { mergedAt: MERGED })]);

      expect((await thePage('?group=pr&pr=7')).includes('name="outcome"')).toBe(false);
    });

    it('the Overview lists each day of the period, newest first, with what each job did on it', async () => {
      await sendSelection([selectionPull(1, { mergedAt: '2026-10-14T10:00:00Z', jobs: [selectionJob('test'), ranEverything('e2e', 'owned by no concept', null)] }), selectionPull(2, { mergedAt: '2026-10-12T10:00:00Z' })]);

      const rows = rowsOf(await thePage('?period=7d'), 'by-day');

      // The days before the first pull request held are not listed: nothing there is "no pull request merged".
      expect(rows.map((row) => row.slice(0, 2))).toEqual([['15 Oct 2026', '0'], ['14 Oct 2026', '1'], ['13 Oct 2026', '0'], ['12 Oct 2026', '1']].map(([day, merged]) => [expect.stringContaining(day!.slice(0, 6)), merged]));
      expect(rows[1]![3]).toContain('ran everything on 1 of 1');
    });
  });

  describe('nothing in the period says nothing in this period', () => {
    it.each([{ situation: 'the Overview' }, { situation: 'a tab', query: '?group=rule' }, { situation: 'a period that holds only older pull requests', query: '?period=7d', older: true }])('$situation of an empty Monitor', async ({ query, older }) => {
      if (older) await sendSelection([selectionPull(1, { mergedAt: '2026-08-01T10:00:00Z' })]);

      const html = await thePage(query ?? '');

      expect(text(html)).toContain('Nothing in this period. No pull request merged in it.');
      expect(html.includes('class="tiles"')).toBe(false);
    });

    it('a tab with nothing of its own says what is missing, and a period with nothing forcing a full run says so', async () => {
      await sendSelection([selectionPull(1, { mergedAt: MERGED })]);

      expect(text(await thePage('?group=miss'))).toContain('No misses in this period');
      expect(text(await thePage('?group=rule'))).toContain('Nothing forced a full run in this period.');
      expect(text(await thePage('?group=pr&outcome=full'))).toContain('No pull request in this period matches the filters.');
    });
  });

  describe('Package lists each package by how often a selecting pull request ran something of it', () => {
    it('shows ran something on 1 of 2 that selected for a package that ran a file on one of two pull requests that selected', async () => {
      await sendSelection([
        selectionPull(1, { mergedAt: MERGED, jobs: [selectionJob('test', { packages: [selectionPackage('api', [selectionFile(HOT)])] }), selectionJob('e2e')] }),
        selectionPull(2, { mergedAt: MERGED, jobs: [selectionJob('test', { packages: [selectionPackage('api', [])] }), selectionJob('e2e')] }),
      ]);

      const [row] = rowsOf(await thePage('?group=package'), 'by-package');

      expect(row).toEqual(['api', '—', 'ran something on 1 of 2 that selected · 50%', '1', '0', '—']);
    });

    it('shows the most test files the package held on any pull request of the period', async () => {
      await sendSelection([
        selectionPull(1, { mergedAt: MERGED, jobs: [selectionJob('test', { packages: [selectionPackage('api', [selectionFile(HOT)], { filesTotal: 40 })] }), selectionJob('e2e')] }),
        selectionPull(2, { mergedAt: MERGED, jobs: [selectionJob('test', { packages: [selectionPackage('api', [], { filesTotal: 43 })] }), selectionJob('e2e')] }),
      ]);

      const [row] = rowsOf(await thePage('?group=package'), 'by-package');

      expect(row!.slice(0, 2)).toEqual(['api', '43']);
    });
  });
});
