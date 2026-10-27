import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/worker';
import { withoutExplanations } from './cockpit-support';
import { GREY, RED, slot, swatches } from './series-colours';
import { cycleCheck, cyclePull, cycleRound, docsOnly, emptyTheDatabase, fullPackage, ranEverything, selectionFile, selectionJob, selectionPackage, selectionPull, sendPulls, sendSelection, theSentence } from './support';

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

/** What a panel reads as its figures, without the (i)s and the explanations they open. */
const plain = (html: string) => withoutExplanations(html).replace(/<[^>]+>/g, ' ').replace(/&rarr;/g, '→').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const text = (html: string) => plain(html.replace(/<style>.*?<\/style>/s, ''));
const hasSection = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"`).test(html);
const sectionOf = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';
const tiles = (html: string) => [...withoutExplanations(html).matchAll(/<div class="tile ([^"]*)">(.*?)<\/div>/gs)].map((m) => ({ cls: m[1]!.trim(), text: plain(m[2]!) }));
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
const MINUTE = 60_000;
const NEWEST = Date.parse('2026-10-14T10:00:00Z');
/** Pull request `n` of a run of thirty, merged three hours before the one before: 1 is the newest. */
const mergedAt = (n: number) => new Date(NEWEST - (n - 1) * 3 * 3_600_000).toISOString();

/** A pull request's rounds as cycle time holds them: each round names the checks and the minutes each held it up. */
const rounds = (...each: Record<string, number | number[]>[]) =>
  each.map((checks) =>
    cycleRound(
      Object.entries(checks).flatMap(([name, held]) =>
        [held].flat().map((minutes, index) => cycleCheck(name, minutes * MINUTE, { attempt: index + 1, last: name === 'E2E (F3)' && index === [held].flat().length - 1 })),
      ),
    ),
  );
const heldBy = (n: number, rounds: ReturnType<typeof cycleRound>[], over: Record<string, unknown> = {}) => cyclePull(n, { mergedAt: mergedAt(n), rounds, ...over });

/** The rule table as a reader sees it: each group's heading as one cell, each rule as its cells. */
const ruleTable = (html: string) =>
  [...sectionOf(html, 'by-rule').matchAll(/<tr[ >].*?<\/tr>/gs)]
    .map((row) => [...row[0].replace(/<pre hidden>.*?<\/pre>/gs, '').matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((cell) => plain(cell[1]!)))
    .filter((cells) => cells.length > 0)
    .slice(1);

/**
 * Thirty pull requests, newest first. E2E ran every spec on 1 to 3 for a rule to fix, on 4 for an expected rule,
 * on 25 for an expected one and on 26 for one to fix, both stopped; the Test job ran every package on 5 for an expected rule
 * and on 6 for one to fix. Every pull request's checks held it 2 minutes (E2E) and 3 (Test), save those that ran everything.
 */
const aMonitor = async () => {
  const forced = new Map<number, { e2e?: ReturnType<typeof ranEverything>; test?: ReturnType<typeof ranEverything> }>([
    [1, { e2e: ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts') }],
    [2, { e2e: ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts') }],
    [3, { e2e: ranEverything('e2e', 'owned by no concept', 'apps/api/src/b.ts') }],
    [4, { e2e: ranEverything('e2e', 'e2e support, registry or config', 'tools/test-explorer/concepts.json') }],
    [5, { test: ranEverything('test', 'any tsconfig', 'tsconfig.json') }],
    [6, { test: ranEverything('test', 'outside every package', 'readme.md') }],
    [25, { e2e: ranEverything('e2e', 'lockfile', 'pnpm-lock.yaml') }],
    [26, { e2e: ranEverything('e2e', 'spec with no area', 'tests/e2e/a.test.ts') }],
  ]);
  const held: Record<number, { e2e: number; test: number }> = { 1: { e2e: 10, test: 3 }, 2: { e2e: 6, test: 3 }, 3: { e2e: 3, test: 3 }, 4: { e2e: 20, test: 3 }, 5: { e2e: 2, test: 5 }, 6: { e2e: 2, test: 9 } };
  await sendSelection(times(30, (index) => selectionPull(index + 1, { mergedAt: mergedAt(index + 1), jobs: [forced.get(index + 1)?.test ?? selectionJob('test'), forced.get(index + 1)?.e2e ?? selectionJob('e2e')] })));
  await sendPulls(times(30, (index) => heldBy(index + 1, rounds({ Test: held[index + 1]?.test ?? 3, 'E2E (F3)': held[index + 1]?.e2e ?? 2 }))));
};

describe('Harness Monitor', () => {
  describe('test selection is a page, and the same address answers JSON to a request that asks', () => {
    it('opens from its own tab in the top bar, between cycle time and CI stability, with the sentence of the page on the band', async () => {
      const html = await thePage();

      expect(html).toMatch(/<a href="\/selection" title="[^"]*" aria-current="page">Test selection<\/a>/);
      expect([...html.matchAll(/<nav class="pages".*?<\/nav>/gs)][0]![0].match(/>([^<]+)<\/a>/g)).toEqual([
        '>Claude Code costs</a>',
        '>Cockpit&rsquo;s Claude calls</a>',
        '>Cycle time</a>',
        '>Test selection</a>',
        '>Test coverage</a>',
        '>CI stability</a>',
      ]);
      expect(theSentence(html).choices.group!.offered).toEqual(['each day', 'each rule that forced a full run', 'each test skipped, then failed on main']);
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

  describe('each day leads with one tile per question: what ran more than needed, and what ran less', () => {
    const missedIn = (n: number, path: string) => selectionPull(n, { mergedAt: MERGED, misses: [{ job: 'test', path, level: 'unit', reason: null }] });

    it('the time rules to fix could have saved counts the rules to fix only, and its note gives every full run per job', async () => {
      await aMonitor();

      const [more] = tiles(await thePage());

      expect(more!.text).toContain('Ran more than needed 19m 00s');
      expect(more!.text).toContain('could have been saved: 4 full runs forced by rules to fix, against a typical selected run');
      // The expected ones and the rules that stopped are in the note, with the time they add.
      expect(more!.text).toContain('8 full runs in all (Test job 2 of 30 · E2E job 6 of 30), 39m 00s counting the expected ones too');
      expect(more!.text).toContain('Which rules');
    });

    it('is the measure each rule that forced a full run is ranked by, so the rules to fix add up to it', async () => {
      await aMonitor();

      const [more] = tiles(await thePage());
      const toFix = ruleTable(await thePage('?group=rule'))
        .slice(1, 3)
        .map((row) => row[2]);

      expect(toFix).toEqual(['13m 00s 3 full runs', '6m 00s 1 full run']);
      expect(more!.text).toContain('Ran more than needed 19m 00s');
    });

    it('its link opens the rules, keeping the job and period', async () => {
      await aMonitor();

      expect(await thePage('?job=e2e&period=7d')).toContain('<a href="/selection?group=rule&#38;period=7d&#38;job=e2e">Which rules</a>');
    });

    it('five tests skipped by their pull request and then failed on main read 5 tests, linking to their rows', async () => {
      await sendSelection(times(5, (index) => missedIn(index + 1, `apps/api/tests/unit/m${index}.test.ts`)));

      const [, less] = tiles(await thePage());

      expect(less!.text).toContain('Ran less than needed 5 tests skipped by their pull request, then failed on main Which ones');
      expect(await thePage()).toContain('<a href="/selection?group=miss">Which ones</a>');
    });

    it('none in the period reads 0 tests, and one reads 1 test', async () => {
      await sendSelection([selectionPull(1, { mergedAt: MERGED })]);
      const none = tiles(await thePage())[1]!.text;
      await sendSelection([missedIn(2, 'apps/api/tests/unit/m.test.ts')]);
      const one = tiles(await thePage())[1]!.text;

      expect(none).toContain('Ran less than needed 0 tests');
      expect(none).not.toContain('Which ones');
      expect(one).toContain('Ran less than needed 1 test ');
    });

    it('the job chosen is read alone: its own full runs and its own misses', async () => {
      await sendSelection([
        selectionPull(1, { mergedAt: MERGED, jobs: [selectionJob('test'), ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts')], misses: [{ job: 'test', path: 'a.test.ts', level: 'unit', reason: null }, { job: 'e2e', path: 'tests/e2e/b.test.ts', level: 'e2e', reason: null }] }),
      ]);

      const [more, less] = tiles(await thePage('?job=e2e'));

      expect(more!.text).toContain('1 full run in all (E2E job 1 of 1)');
      expect(more!.text).not.toContain('Test job');
      expect(less!.text).toContain('Ran less than needed 1 test ');
    });

    it('the tile explains itself with an (i), and the page has no Most selected tile, typical pull request panel or by-day table', async () => {
      await aMonitor();

      const html = await thePage();

      expect(tiles(html).map((t) => t.text.split(' ').slice(0, 6).join(' '))).toEqual(['Ran more than needed 19m 00s', 'Ran less than needed 0 tests']);
      expect(html).toContain('data-pop="x-t-more"');
      expect(html).toContain('data-pop="x-t-less"');
      for (const gone of ['Most selected', 'A typical pull request', 'By day', 'typical-pull-request', 'by-day', 'Misses']) expect(text(html)).not.toContain(gone);
      expect(['what-each-job-did', 'ran-everything-per-day'].map((id) => hasSection(html, id))).toEqual([true, true]);
    });

    it('a period too small for a bar to read draws the figures all the same, and no job over the bar', async () => {
      await sendSelection(times(12, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [selectionJob('test'), ranEverything('e2e', 'owned by no concept', null)] })));

      const html = await thePage();

      expect(tiles(html)).toHaveLength(2);
      expect(text(sectionOf(html, 'what-each-job-did'))).not.toContain('over the bar');
    });

    it('a period reaches the pull requests merged from the start of its first Belgian day', async () => {
      // 9 Oct begins in Brussels at 22:00 UTC on the 8th, the first day of the last seven.
      const missed = (n: number, mergedAt: string) => selectionPull(n, { mergedAt, misses: [{ job: 'test', path: `apps/api/tests/unit/m${n}.test.ts`, level: 'unit', reason: null }] });
      await sendSelection([missed(1, '2026-10-08T21:59:00Z'), missed(2, '2026-10-08T22:00:00Z')]);

      const html = await thePage('?period=7d&group=miss');

      expect(rowsOf(html, 'misses').map((row) => row[0])).toEqual([expect.stringContaining('m2.test.ts')]);
    });
  });

  describe('the job keeps only its own rows, on every tab', () => {
    it('what forced a full run lists the E2E job\'s rules alone for E2E, and both jobs\' for both', async () => {
      await sendSelection(
        times(30, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [ranEverything('test', 'any tsconfig', 'tsconfig.json'), ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts')] })),
      );

      const e2e = rowsOf(await thePage('?group=rule&job=e2e'), 'by-rule');
      const both = rowsOf(await thePage('?group=rule'), 'by-rule');

      expect(e2e.filter((row) => row.length > 1).map((row) => row.slice(0, 2))).toEqual([['E2E job', expect.stringContaining('owned by no concept')]]);
      expect(both.filter((row) => row.length > 1).map((row) => row[0])).toEqual(['E2E job', 'Test job']);
    });

  });

  describe('each test skipped, then failed on main is a row with the pull request that skipped it, and a prompt that settles it', () => {
    const missed = (path: string, job: 'test' | 'e2e' = 'test', reason: string | null = null) => ({ job, path, level: job === 'e2e' ? 'e2e' : 'unit', reason });
    /** The rows as a reader sees them: the test with its level and job, the pull request with when it merged, the button. */
    const missTable = (html: string) =>
      [...sectionOf(html, 'misses').matchAll(/<tr[ >].*?<\/tr>/gs)]
        .map((row) => [...row[0].replace(/<pre hidden>.*?<\/pre>/gs, '').matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((cell) => plain(cell[1]!)))
        .filter((cells) => cells.length > 0)
        .slice(1);

    it('a Test job miss is a row with its path, level and job, the pull request that skipped it and when that merged', async () => {
      await sendSelection([selectionPull(7, { mergedAt: '2026-10-10T10:00:00Z', misses: [missed('apps/api/tests/unit/a.test.ts')] })]);

      const html = await thePage('?group=miss');

      expect(headers(html, 'misses')).toEqual(['Test', 'Skipped in', 'Prompt']);
      expect(missTable(html)).toEqual([['apps/api/tests/unit/a.test.ts unit · Test job', '#7 Pull request 7 10 Oct 2026, 12:00', 'Copy prompt']]);
      expect(html).toContain('<a href="/selection?group=pr&#38;pr=7"><span class="pr-no">#7</span> Pull request 7</a>');
    });

    it('a miss whose pull request changed only documents says it ran no tests', async () => {
      await sendSelection([
        selectionPull(1, { mergedAt: MERGED, jobs: [docsOnly('test'), docsOnly('e2e')], misses: [missed('tests/e2e/b.test.ts', 'e2e', 'docs only')] }),
        selectionPull(2, { mergedAt: MERGED, misses: [missed('apps/api/tests/unit/a.test.ts')] }),
      ]);

      const [ran, docs] = missTable(await thePage('?group=miss'));

      expect(docs![1]).toContain('it changed only documents, so it ran no tests');
      expect(ran![1]).not.toContain('only documents');
    });

    it('two misses from one pull request are two rows, the newest pull request first', async () => {
      await sendSelection([
        selectionPull(1, { mergedAt: '2026-10-09T10:00:00Z', misses: [missed('apps/api/tests/unit/old.test.ts')] }),
        selectionPull(2, { mergedAt: '2026-10-10T10:00:00Z', misses: [missed('apps/api/tests/unit/a.test.ts'), missed('apps/api/tests/unit/b.test.ts')] }),
      ]);

      const html = await thePage('?group=miss');

      expect(missTable(html).map((row) => row[0]!.split(' ')[0])).toEqual(['apps/api/tests/unit/a.test.ts', 'apps/api/tests/unit/b.test.ts', 'apps/api/tests/unit/old.test.ts']);
      expect(text(sectionOf(html, 'misses'))).toContain('3 tests · newest first');
    });

    it('the job chosen keeps only its own', async () => {
      await sendSelection([selectionPull(1, { mergedAt: MERGED, misses: [missed('apps/api/tests/unit/a.test.ts'), missed('tests/e2e/b.test.ts', 'e2e')] })]);

      expect(missTable(await thePage('?group=miss&job=e2e')).map((row) => row[0]!.split(' ')[0])).toEqual(['tests/e2e/b.test.ts']);
    });

    it('none in the period says nothing failed on main that its pull request skipped, under the explanation', async () => {
      await sendSelection([selectionPull(1, { mergedAt: MERGED })]);

      const view = sectionOf(await thePage('?group=miss'), 'misses');

      expect(text(view)).toContain('None in this period: nothing failed on main that its pull request skipped.');
      expect(view).not.toContain('<table');
    });

    it('is titled for what it is, and explains under the title what to make of a row, aligned with it', async () => {
      await sendSelection([selectionPull(1, { mergedAt: MERGED })]);

      const view = sectionOf(await thePage('?group=miss'), 'misses');

      expect(text(view)).toContain('Tests that were skipped, then failed on main');
      expect(view).toMatch(/<\/div><p class="view-lead">The pull request skipped these tests, and they failed on main once it merged\. If the pull request broke the test, the selection missed that its files lead to this test: teach it that a change to those files runs it\. If the test is flaky, the selection was right and the test needs fixing\. The prompt has Claude find out which, and make the fix\.<\/p>/);
    });

    it("each row's Copy prompt is its own, held in the page and never shown", async () => {
      await sendSelection([
        selectionPull(7, { mergedAt: '2026-10-10T10:00:00Z', misses: [missed('apps/api/tests/unit/a.test.ts')] }),
        selectionPull(8, { mergedAt: '2026-10-09T10:00:00Z', jobs: [docsOnly('test'), docsOnly('e2e')], misses: [missed('tests/e2e/b.test.ts', 'e2e', 'docs only')] }),
      ]);

      const html = sectionOf(await thePage('?group=miss'), 'misses');
      const prompts = [...html.matchAll(/<pre hidden>(.*?)<\/pre>/gs)].map((m) => m[1]!.replaceAll('&#34;', '"').replaceAll('&#39;', "'"));

      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain('apps/api/tests/unit/a.test.ts (unit, Test job) failed on main\'s run of the merge of #7 "Pull request 7" (merged 10 Oct 2026, 12:00)');
      expect(prompts[0]).toContain('If it could not, say what did break it');
      expect(prompts[1]).toContain('tests/e2e/b.test.ts (e2e, E2E job) failed on main\'s run of the merge of #8 "Pull request 8"');
      expect(prompts[1]).toContain('its change being documentation only');
      expect(html.match(/<pre(?! hidden)/g)).toBeNull();
      expect(html.match(/class="copy-prompt"/g)).toHaveLength(2);
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
      expect(html).toContain('<a class="back" href="/selection">&larr; Each day</a>');
    });

    it('opens from the paths of a rule, and keeps the period and job', async () => {
      await sendSelection(times(30, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [ranEverything('test', 'any tsconfig', 'tsconfig.json'), selectionJob('e2e')] })));

      const html = await thePage('?group=rule&rule=test%3Aany%20tsconfig&period=7d&job=test');

      expect(html).toContain('href="/selection?group=pr&#38;period=7d&#38;job=test&#38;pr=7"');
    });
  });

  describe('a rule opens its paths worst first with their pull requests', () => {
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

  });

  describe('the tiles and the overview panels are on each day only', () => {
    const views = [
      { view: 'each day', query: '?group=day', tiles: true, overview: true },
      { view: 'each rule that forced a full run', query: '?group=rule', tiles: false, overview: false },
      { view: 'each test skipped, then failed on main', query: '?group=miss', tiles: false, overview: false },
      { view: "one pull request's selection", query: '?group=pr&pr=7', tiles: false, overview: false },
    ];

    it.each(views)('$view has the tiles: $tiles, the overview panels: $overview', async ({ query, ...expected }) => {
      await sendSelection(thirtyWithNineFull());

      const html = await thePage(query);

      expect(html.includes('class="tiles"')).toBe(expected.tiles);
      expect(['what-each-job-did', 'ran-everything-per-day'].map((id) => hasSection(html, id))).toEqual(Array(2).fill(expected.overview));
      expect(html).toContain('name="period"');
      expect(html).toContain('name="job"');
    });
  });

  describe('the sentence says what the page shows, and offers only what it can', () => {
    it('the bare address reads each day, in both jobs, over the last 14 days, with no Only row', async () => {
      const html = await thePage();
      const { text: sentence, choices } = theSentence(html);

      expect(sentence).toBe('Show test selection for [each day] in [both jobs] over [the last 14 days]');
      expect(choices.group!.offered).toEqual(['each day', 'each rule that forced a full run', 'each test skipped, then failed on main']);
      expect(choices.job!.offered).toEqual(['both jobs', 'the Test job', 'the E2E job']);
      expect(choices.period!.offered).toEqual(['the last 7 days', 'the last 14 days', 'everything held']);
      expect(Object.keys(choices)).toEqual(['group', 'job', 'period']);
      expect(html).not.toContain('class="only"');
    });

    it.each(['?group=package', '?group=pr', '?group=pr&outcome=full', '?group=test', '?group=test&test=apps%2Fapi%2Fa.test.ts'])('an address asking for a row the sentence does not offer, %s, reads each day', async (query) => {
      await sendSelection(thirtyWithNineFull());

      const html = await thePage(query);

      expect(theSentence(html).text).toBe('Show test selection for [each day] in [both jobs] over [the last 14 days]');
      expect(html.includes('class="tiles"')).toBe(true);
    });

    it("one pull request's address opens its whole selection, with no row of its own in the list, and keeps the view when the period or job changes", async () => {
      await sendSelection([selectionPull(7, { mergedAt: MERGED })]);

      const html = await thePage('?group=pr&pr=7');
      const { text: sentence, choices } = theSentence(html);

      expect(text(sectionOf(html, 'pull-request'))).toContain('#7 Pull request 7');
      expect(sentence).toBe('Show test selection for [one pull request] in [both jobs] over [the last 14 days]');
      expect(choices.group).toMatchObject({ chosen: 'one pull request', disabled: [] });
      expect(html).toContain('<option value="pr" selected hidden>one pull request</option>');
      expect(choices.group!.offered.slice(1)).toEqual(['each day', 'each rule that forced a full run', 'each test skipped, then failed on main']);
      // The held choice is sent as it stands, so the form keeps the view and the pull request.
      expect(html).toContain('<input type="hidden" name="pr" value="7">');
    });

    it.each(['', '?group=rule', '?group=miss', '?group=pr&pr=7'])('has no grouping tabs, no Job toggle and no labelled filter row at %s', async (query) => {
      const html = await thePage(query);

      for (const gone of ['band-tabs', 'aria-label="Group by"', 'class="filters"', 'class="toggles"', 'aria-pressed', '<label ']) expect(html).not.toContain(gone);
    });
  });

  describe('each rule that forced a full run says what it could have saved, in three groups, with a prompt to fix the ones to fix', () => {
    it('lists Rules to fix, then Expected, then Stopped, each by the time it could have saved, with the job, advice, full runs, pull requests as n of m, paths and when it last forced one', async () => {
      await aMonitor();

      const table = ruleTable(await thePage('?group=rule'));

      expect(table.map((row) => (row.length === 1 ? row[0] : `${row[0]} · ${row[1]!.split(' ')[0]}…`))).toEqual([
        'Rules to fix',
        'E2E job · owned…',
        'Test job · outside…',
        'Expected: they force a full run by design',
        'E2E job · e2e…',
        'Test job · any…',
        'Stopped: none of the last 20 pull requests',
        'E2E job · lockfile…',
        'E2E job · spec…',
      ]);
      const cells = (rule: string) => table.find((row) => row[1]?.startsWith(rule))!;
      expect(cells('owned by no concept')).toEqual(['E2E job', expect.stringContaining('The area registry cannot place this file'), '13m 00s 3 full runs', '3 of 30', '2 paths', '14 Oct 2026', 'Copy prompt']);
      expect(cells('outside every package')).toEqual(['Test job', expect.stringContaining('A file outside every package’s directory'), '6m 00s 1 full run', '1 of 30', '1 path', '13 Oct 2026', 'Copy prompt']);
      expect(cells('e2e support, registry or config')).toEqual(['E2E job', expect.stringContaining('shared by every walk'), '18m 00s 1 full run', '1 of 30', '1 path', '14 Oct 2026', '']);
      expect(cells('any tsconfig')).toEqual(['Test job', expect.stringContaining('can extend another package'), '2m 00s 1 full run', '1 of 30', '1 path', '14 Oct 2026', '']);
    });

    it('a rule that stopped says so in its last forced, whether it was marked expected or not, and keeps no prompt', async () => {
      await aMonitor();

      const table = ruleTable(await thePage('?group=rule'));

      expect(table.find((row) => row[1]?.startsWith('lockfile'))).toEqual(['E2E job', expect.stringContaining('The lockfile changes'), '0s 1 full run', '1 of 30', '1 path', 'stopped 11 Oct 2026', '']);
      expect(table.find((row) => row[1]?.startsWith('spec with no area'))).toEqual(['E2E job', expect.stringContaining('A changed spec'), '0s 1 full run', '1 of 30', '1 path', 'stopped 11 Oct 2026', '']);
      expect(sectionOf(await thePage('?group=rule'), 'by-rule')).toContain('<span class="pill grey">stopped 11 Oct 2026</span>');
    });

    it('names each job\'s typical selected run under the table, and carries no bar', async () => {
      await aMonitor();

      const html = await thePage('?group=rule');

      expect(text(sectionOf(html, 'by-rule'))).toContain('less a typical selected run of the same job (Test job 3m 00s, E2E job 2m 00s).');
      expect(headers(html, 'by-rule')).toEqual(['Job', 'Rule', 'Could have saved', 'Pull requests', 'Paths', 'Last forced', 'Prompt']);
    });

    it('a job over its bar draws no pill on any row, and no bar in the header', async () => {
      await sendSelection(thirtyWithNineFull());

      const html = await thePage('?group=rule&job=e2e');

      expect(text(sectionOf(html, 'by-rule'))).toContain('owned by no concept');
      expect(sectionOf(html, 'by-rule')).not.toMatch(/over the bar|within|class="pill (over|good)"|>Bar /);
      expect(text(await thePage('?group=day'))).toContain('over the bar');
    });

    it('only a rule to fix has Copy prompt, and no prompt is shown', async () => {
      await aMonitor();

      const html = sectionOf(await thePage('?group=rule'), 'by-rule');
      const withButton = [...html.matchAll(/<tr[ >].*?<\/tr>/gs)].filter((row) => row[0].includes('class="copy-prompt"')).map((row) => plain(row[0].replace(/<pre hidden>.*?<\/pre>/gs, '')).split(' ').slice(0, 3).join(' '));

      expect(withButton).toEqual(['E2E job owned', 'Test job outside']);
      expect(html.match(/<pre hidden>/g)).toHaveLength(2);
      expect(html.match(/<pre(?! hidden)/g)).toBeNull();
    });

    it('the prompt a rule to fix copies names the rule, its file and tests, its paths and what it could have saved', async () => {
      await aMonitor();

      const prompts = [...sectionOf(await thePage('?group=rule'), 'by-rule').matchAll(/<pre hidden>(.*?)<\/pre>/gs)].map((m) => m[1]!.replaceAll('&#34;', '"').replaceAll('&#39;', "'"));

      expect(prompts[0]).toContain('The E2E job ran every spec on 3 of the 30 pull requests merged 10 Oct 2026 to 14 Oct 2026 that ran it, forced by the rule "owned by no concept" in scripts/lib/e2e-selection.mjs. Selecting instead would have saved about 13m 00s of CI time.');
      expect(prompts[0]).toContain('- apps/api/src/a.ts: 2 pull requests (#1, #2)\n- apps/api/src/b.ts: 1 pull request (#3)');
      expect(prompts[0]).toContain('scripts/lib/e2e-selection.test.mjs');
      expect(prompts[1]).toContain('The Test job ran every test file of the packages it forced on 1 of the 30 pull requests');
      expect(prompts[1]).toContain('scripts/lib/test-selection.mjs');
    });

    it('the job chosen keeps only its own rules and its own typical selected run', async () => {
      await aMonitor();

      const table = ruleTable(await thePage('?group=rule&job=test'));

      expect(table.filter((row) => row.length > 1).map((row) => row[0])).toEqual(['Test job', 'Test job']);
      expect(text(sectionOf(await thePage('?group=rule&job=test'), 'by-rule'))).toContain('(Test job 3m 00s).');
    });

    it('a job with no selected run in the period says so, and its rules could have saved nothing to name', async () => {
      await sendSelection(times(3, (index) => selectionPull(index + 1, { mergedAt: MERGED, jobs: [selectionJob('test'), ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts')] })));
      await sendPulls(times(3, (index) => cyclePull(index + 1, { mergedAt: MERGED, rounds: rounds({ 'E2E (F3)': 9 }) })));

      const html = await thePage('?group=rule&job=e2e');

      expect(ruleTable(html).find((row) => row.length > 1)).toEqual(['E2E job', expect.any(String), '— 3 full runs', '3 of 3', '1 path', '10 Oct 2026', 'Copy prompt']);
      expect(text(sectionOf(html, 'by-rule'))).toContain('(E2E job no selected run in this period)');
    });
  });

  describe("the page reads each pull request's check time from cycle time's rows, over the period", () => {
    const checks = (...each: [string, number, Record<string, unknown>?][]) => cycleRound(each.map(([name, minutes, over]) => cycleCheck(name, minutes * MINUTE, over)));
    /** An E2E run that ran everything on pull request 1, and two that selected, 1 minute each unless told otherwise; the figure the rule could have saved. */
    const saved = async (first: unknown, selected: unknown[] = [cyclePull(2, { mergedAt: MERGED, rounds: [checks(['E2E (F3)', 1])] }), cyclePull(3, { mergedAt: MERGED, rounds: [checks(['E2E (F3)', 1])] })]) => {
      await sendSelection([selectionPull(1, { mergedAt: MERGED, jobs: [selectionJob('test'), ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts')] }), selectionPull(2, { mergedAt: MERGED }), selectionPull(3, { mergedAt: MERGED })]);
      await sendPulls([first, ...selected]);
      const row = [...sectionOf(await thePage('?group=rule&job=e2e'), 'by-rule').matchAll(/<tr[ >].*?<\/tr>/gs)].map((r) => plain(r[0])).find((r) => r.includes('owned by no concept'))!;
      return /(\d+h \d\dm|\d+m \d\ds|\d+s) \d+ full runs?/.exec(row)?.[1];
    };

    it('a pull request with two rounds, E2E in both, counts both rounds added up', async () => {
      const twoRounds = cyclePull(1, { mergedAt: MERGED, rounds: [checks(['E2E (F3)', 8], ['Test', 2]), checks(['E2E (F3)', 4])] });

      expect(await saved(twoRounds)).toBe('11m 00s');
    });

    it("a re-run attempt in a round counts as cycle time counts it: its time waited is added to the round's", async () => {
      const reRun = cyclePull(1, { mergedAt: MERGED, rounds: [checks(['E2E (F3)', 5, { failure: 'fluke', flukeMs: 3 * MINUTE }], ['E2E (F3)', 3, { attempt: 2, last: true }])] });

      expect(await saved(reRun)).toBe('7m 00s');
    });

    it("a pull request cycle time dates before the period is not read, so it is not one of the typical selected runs", async () => {
      const first = cyclePull(1, { mergedAt: MERGED, rounds: [checks(['E2E (F3)', 10])] });
      const oldRow = cyclePull(2, { mergedAt: '2026-08-01T10:00:00Z', rounds: [checks(['E2E (F3)', 50])] });
      const inPeriod = cyclePull(3, { mergedAt: MERGED, rounds: [checks(['E2E (F3)', 2])] });

      expect(await saved(first, [oldRow, inPeriod])).toBe('8m 00s');
    });

    it('only the Test and E2E (F3) checks are read: no other check holds a job up', async () => {
      const others = cyclePull(1, { mergedAt: MERGED, rounds: [checks(['E2E (F3)', 8], ['Checks', 30], ['Test Explorer', 30])] });

      expect(await saved(others)).toBe('7m 00s');
    });
  });

  describe('nothing in the period says nothing in this period', () => {
    it.each([{ situation: 'each day' }, { situation: 'each rule', query: '?group=rule' }, { situation: 'each test skipped, then failed on main', query: '?group=miss' }, { situation: 'a period that holds only older pull requests', query: '?period=7d', older: true }])('$situation of an empty Monitor', async ({ query, older }) => {
      if (older) await sendSelection([selectionPull(1, { mergedAt: '2026-08-01T10:00:00Z' })]);

      const html = await thePage(query ?? '');

      expect(text(html)).toContain('Nothing in this period. No pull request merged in it.');
      expect(html.includes('class="tiles"')).toBe(false);
    });

    it('a period with nothing forcing a full run says so', async () => {
      await sendSelection([selectionPull(1, { mergedAt: MERGED })]);

      expect(text(await thePage('?group=rule'))).toContain('Nothing forced a full run in this period.');
    });
  });

  describe('a pull request that selected a subset but ran no file of a package does not say every package ran in full', () => {
    it('says only that nothing was selected', async () => {
      await sendSelection([selectionPull(7, { mergedAt: MERGED, jobs: [selectionJob('test', { packages: [selectionPackage('api', [])] }), selectionJob('e2e')] })]);

      const drill = text(sectionOf(await thePage('?group=pr&pr=7&job=test'), 'pull-request'));

      expect(drill).toContain('Nothing selected.');
      expect(drill).not.toContain('ran in full');
    });
  });

  describe('a view kept at the edge is the one the address asks for, drill-down included', () => {
    it('two pull requests opened from the same tab are two views, each its own', async () => {
      await sendSelection([selectionPull(7, { mergedAt: MERGED }), selectionPull(8, { mergedAt: MERGED })]);
      const cached = { ...env, PAGE_CACHE_SECONDS: '300' };
      const open = async (query: string) => {
        const ctx = createExecutionContext();
        const response = await worker.fetch(new Request(`https://monitor.test/selection${query}`), cached, ctx);
        await waitOnExecutionContext(ctx);
        return text(sectionOf(await response.text(), 'pull-request'));
      };

      const seven = await open('?group=pr&pr=7');
      const eight = await open('?group=pr&pr=8');

      expect(seven).toContain('Pull request 7');
      expect(eight).toContain('Pull request 8');
    });
  });

  describe('a job has its own colour, and what a job did with a pull request has its own', () => {
    it('Test is violet and E2E orange on the per-day chart, the outcomes keyed selected, ran everything, and the greys for a job that never started', async () => {
      const pulls = [
        selectionPull(1, { mergedAt: MERGED, jobs: [selectionJob('test'), selectionJob('e2e')] }),
        selectionPull(2, { mergedAt: MERGED, jobs: [ranEverything('test', 'any tsconfig', 'tsconfig.json'), ranEverything('e2e', 'owned by no concept', 'apps/api/src/b.ts')] }),
        selectionPull(3, { mergedAt: MERGED, jobs: [docsOnly('test'), docsOnly('e2e')] }),
        // A pull request the Selection job left no record of for E2E.
        selectionPull(4, { mergedAt: MERGED, jobs: [selectionJob('test'), { ...docsOnly('e2e'), status: 'no-record' }] }),
      ];
      expect((await sendSelection(pulls)).status).toBe(200);

      const html = await thePage();

      expect(swatches(sectionOf(html, 'ran-everything-per-day'))).toEqual([['Test job', slot(1)], ['E2E job', slot(2)]]);
      expect(swatches(sectionOf(html, 'what-each-job-did'))).toEqual([
        ['Test job', slot(1)],
        ['Selected a subset', slot(1)],
        ['Ran everything', slot(2)],
        ['Skipped: documentation only', GREY],
        ['E2E job', slot(2)],
        ['Selected a subset', slot(1)],
        ['Ran everything', slot(2)],
        ['Skipped: documentation only', GREY],
        ['No record', GREY],
      ]);
    });

    it('a job over the bar draws Ran everything in red, which is bad, instead of orange', async () => {
      await sendSelection(thirtyWithNineFull());

      const legend = swatches(sectionOf(await thePage(), 'what-each-job-did'));

      expect(legend.slice(legend.findIndex(([name]) => name === 'E2E job'))).toContainEqual(['Ran everything · over the bar', RED]);
    });
  });

});
