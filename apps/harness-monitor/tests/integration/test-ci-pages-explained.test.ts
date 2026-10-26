import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { area, kase, model, rule, rules, statements } from '../fixtures/tests-model';
import { withoutExplanations } from './cockpit-support';
import { panelOf } from './series-colours';
import {
  emptyTheDatabase,
  ranEverything,
  selectionBars,
  selectionFile,
  selectionJob,
  selectionPackage,
  selectionPull,
  sendRuns,
  sendSelection,
  sendTestsModel,
  stabilityJob,
  stabilityRun,
  stabilityStep,
} from './support';

const text = (html: string) => html.replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ').replace(/\s+/g, ' ');
/** The explanation an (i) opens, by its id; '' where the page draws none. */
const explanationOf = (html: string, id: string) => new RegExp(`<div id="x-${id}" popover="manual" class="explain-pop">.*?</div>`, 's').exec(html)?.[0] ?? '';
/** The parts of an explanation, by the name of each; null where the page draws none by that id. */
const partsOf = (html: string, id: string) => {
  const panel = explanationOf(html, id);
  return panel ? [...panel.matchAll(/<dt>(.*?)<\/dt>/g)].map((m) => m[1]) : null;
};
const THREE_PARTS = ['What it shows', 'How to read it', 'What to look for'];
/** The (i) a panel carries first, beside its heading: the id of the explanation it opens, null where it has none. */
const firstInfo = (panel: string) => /<button [^>]*data-pop="x-([^"]*)"/.exec(panel)?.[1] ?? null;
/** Every (i) on the page by the explanation it opens, and every explanation drawn. */
const infosOf = (html: string) => ({
  buttons: [...html.matchAll(/<button [^>]*data-pop="(x-[^"]*)"/g)].map((m) => m[1]),
  panels: [...html.matchAll(/<div id="(x-[^"]*)" popover="manual"/g)].map((m) => m[1]),
});
/** A tile as drawn, up to the next one, found by what its label reads. */
const tileOf = (html: string, label: string) =>
  html
    .split('<div class="tile')
    .slice(1)
    .find((tile) => text(/class="tile-label">(.*?)<span class="tile-value"/s.exec(tile)?.[1] ?? '').trim().startsWith(label)) ?? '';
const leadOf = (html: string) => text(/<div class="lead">(.*?)<\/div>/s.exec(html)?.[1] ?? '');
/** Where the lead sits: after the band's sentence and before the first panel. */
const leadPlace = (html: string) => ({
  afterTheSentence: html.indexOf('class="lead"') > html.indexOf('</form>', html.indexOf('class="sentence-form"')),
  beforeThePanels: html.indexOf('class="lead"') < html.indexOf('<section'),
});

const page = async (path: string) => {
  const response = await SELF.fetch(`https://monitor.test${path}`);
  expect(response.status).toBe(200);
  return response.text();
};

afterEach(() => vi.useRealTimers());

// ---- Test selection: one pull request that selected in the Test job and ran everything in E2E, with a miss.
const SELECTED = 'apps/api/tests/unit/a.test.ts';
const RULE = 'e2e%3Aowned+by+no+concept';
async function selection(bars = selectionBars()) {
  await emptyTheDatabase();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
  await sendSelection(
    [
      selectionPull(1, {
        mergedAt: '2026-10-10T10:00:00Z',
        jobs: [selectionJob('test', { packages: [selectionPackage('api', [selectionFile(SELECTED)])] }), ranEverything('e2e', 'owned by no concept', 'apps/api/src/a.ts')],
        misses: [{ job: 'test', path: 'apps/api/tests/unit/b.test.ts', level: 'unit', reason: null }],
      }),
    ],
    bars,
  );
}

// ---- Test coverage: Inbox holds rules at two levels and Capture inside it; Offline holds a file under 80% covered with a branch nothing takes, and one decided not worth a test.
const API_INT = 'apps/api/tests/integration/capture.test.ts';
const TREE = [
  area('Workspaces', [], [area('Inbox', [...rules(2, 'L1', 'apps/api/tests/unit/capture.test.ts'), rule('A captured thought lands in the inbox', 'L2', API_INT, 20, [kase('a note', API_INT, 22)])], [area('Capture', rules(1, 'F3', 'tests/e2e/capture.test.ts'))])]),
  area('Offline', rules(1, 'L1', 'apps/web/tests/unit/offline.test.ts'), [], {
    statements: [statements('apps/web/src/offline.ts', 20, 9, ['7-12']), statements('apps/web/src/wiring.ts', 10, 2, ['1-8'])],
    branchesNothingTakes: [{ file: 'apps/web/src/offline.ts', line: 7 }],
  }),
];
const tests = async () => {
  await emptyTheDatabase();
  await sendTestsModel(model(TREE, { coverageAvailable: true, notWorthATest: [{ file: 'apps/web/src/wiring.ts', reason: 'Wiring only', notRun: 8 }] }));
};

// ---- CI stability: CI passed, failed at a step, then passed again, on 30 Oct.
const ran = (id: number, createdAt: string, outcome: 'pass' | 'fail') =>
  stabilityRun(id, {
    createdAt,
    conclusion: outcome === 'pass' ? 'success' : 'failure',
    outcome,
    headSha: String(id).repeat(40).slice(0, 40),
    jobs: [stabilityJob('Test', 60_000, { conclusion: outcome === 'pass' ? 'success' : 'failure', outcome, failedStep: outcome === 'fail' ? 'Run the tests' : null, steps: [stabilityStep('Run the tests', 30_000)] })],
  });
async function stability(runs = [ran(1, '2026-10-30T08:00:00Z', 'pass'), ran(2, '2026-10-30T09:00:00Z', 'fail'), ran(3, '2026-10-30T10:00:00Z', 'pass')]) {
  await emptyTheDatabase();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
  for (let at = 0; at < runs.length; at += 50) await sendRuns(runs.slice(at, at + 50));
}

describe('Harness Monitor', () => {
  describe('every tile, chart, panel and table on Test selection carries an (i) explaining it', () => {
    it.each([
      { tile: 'Test job ran everything', id: 't-test-full' },
      { tile: 'E2E job ran everything', id: 't-e2e-full' },
      { tile: 'Misses', id: 't-misses' },
      { tile: 'Most selected test', id: 't-most' },
    ])('on each day, the $tile tile carries its own (i), with the three parts', async ({ tile, id }) => {
      await selection();

      const html = await page('/selection');

      expect(tileOf(html, tile)).toContain(`data-pop="x-${id}"`);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { panel: 'What each job did', id: 'what-each-job-did' },
      { panel: 'A typical pull request', id: 'typical-pull-request' },
      { panel: 'Share that ran everything per day', id: 'ran-everything-per-day' },
    ])('on each day, $panel carries its own (i), with the three parts', async ({ id }) => {
      await selection();

      const html = await page('/selection');

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { tab: 'By day', query: '', id: 'by-day' },
      { tab: 'Pull request', query: '?group=pr', id: 'by-pull-request' },
      { tab: 'What forced a full run', query: '?group=rule', id: 'by-rule' },
      { tab: 'Package', query: '?group=package', id: 'by-package' },
      { tab: 'Most selected tests', query: '?group=test', id: 'most-selected-tests' },
      { tab: 'Misses', query: '?group=miss', id: 'misses' },
    ])('the $tab table carries an (i) saying what its rows are', async ({ query, id }) => {
      await selection();

      const html = await page(`/selection${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it.each([
      { view: 'a pull request opened through the address, what each job ran and why', query: '?group=pr&pr=1', id: 'pull-request', parts: THREE_PARTS },
      { view: 'a rule opened through the address, its paths', query: `?group=rule&rule=${RULE}`, id: 'rule', parts: ['What it shows'] },
      { view: 'a test opened through the address, the pull requests that selected it', query: `?group=test&test=${encodeURIComponent(SELECTED)}`, id: 'test', parts: ['What it shows'] },
    ])('$view carries its (i)', async ({ query, id, parts }) => {
      await selection();

      const html = await page(`/selection${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(parts);
    });

    it('a period too short for a bar to judge reads unread, and its tiles and panels keep their (i)', async () => {
      await selection();

      const html = await page('/selection');

      expect(text(withoutExplanations(tileOf(html, 'Test job ran everything')))).toContain('unread: 1 pull request, a bar needs 20');
      expect(tileOf(html, 'Test job ran everything')).toContain('data-pop="x-t-test-full"');
      expect(firstInfo(panelOf(html, 'what-each-job-did'))).toBe('what-each-job-did');
    });

    it('draws each (i) once, each to an explanation of its own on the page', async () => {
      await selection();

      const { buttons, panels } = infosOf(await page('/selection'));

      // Four tiles, what each job did, the typical pull request, the chart and the table.
      expect(buttons).toHaveLength(8);
      expect(new Set(buttons).size).toBe(8);
      expect(panels.sort()).toEqual([...buttons].sort());
    });
  });

  describe('every tile, chart, panel and table on Test coverage carries an (i) explaining it', () => {
    it.each([
      { tile: 'Rules', id: 't-rules' },
      { tile: 'Cases', id: 't-cases' },
      { tile: 'Covered', id: 't-covered' },
      { tile: 'Branches nothing takes', id: 't-branches' },
      { tile: 'Areas with no rule', id: 't-empty' },
    ])('on each concept area, the $tile tile carries its own (i), with the three parts', async ({ tile, id }) => {
      await tests();

      const html = await page('/tests');

      expect(tileOf(html, tile)).toContain(`data-pop="x-${id}"`);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it('on each concept area, Every area carries its own (i), with the three parts', async () => {
      await tests();

      const html = await page('/tests');

      expect(firstInfo(panelOf(html, 'areas'))).toBe('areas');
      expect(partsOf(html, 'areas')).toEqual(THREE_PARTS);
    });

    it.each([
      { view: 'Gaps, its files to test next', query: '?group=gaps', id: 'gap-files' },
    ])('$view carries an (i) saying what it shows', async ({ query, id }) => {
      await tests();

      const html = await page(`/tests${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)?.[0]).toBe('What it shows');
    });
  });

  describe('the panel opened beside the table carries an explanation on its head', () => {
    it('an opened panel has an (i) on its head, with the three parts, and the bare page has none for it', async () => {
      await tests();

      const html = await page('/tests?tests=Inbox~~');

      const head = /<div class="pane-head">.*?<nav class="pane-tabs"/s.exec(html)?.[0] ?? '';
      expect(firstInfo(head)).toBe('pane');
      expect(partsOf(html, 'pane')).toEqual(THREE_PARTS);
      expect(infosOf(await page('/tests')).buttons).not.toContain('x-pane');
    });
  });

  describe('Covered and the Gaps table each carry an explanation, and no removed panel’s does', () => {
    it.each([
      { situation: 'Concept area, its Covered tile', query: '', id: 't-covered' },
      { situation: 'Gaps, its table', query: '?group=gaps', id: 'gap-files' },
    ])('$situation carries an (i)', async ({ query, id }) => {
      await tests();

      expect(infosOf(await page(`/tests${query}`)).buttons).toContain(`x-${id}`);
    });

    it.each([[''], ['?group=gaps'], ['?group=level'], ['?group=package'], ['?node=Inbox'], ['?tests=Inbox~~']])('the page at %j draws no explanation of the removed panels, tabs or files column', async (query) => {
      await tests();

      const { buttons, panels } = infosOf(await page(`/tests${query}`));

      for (const gone of ['x-where', 'x-worst', 'x-by-level', 'x-by-package', 'x-t-files', 'x-own-rules', 'x-tests', 'x-rule', 'x-cases', 'x-gap-branches']) {
        expect(buttons).not.toContain(gone);
        expect(panels).not.toContain(gone);
      }
    });
  });

  describe('the spark icon, Files to test next and Decided not to test each carry an explanation', () => {
    it('Concept area: the spark icon’s (i) sits on the Covered heading, with the three parts', async () => {
      await tests();

      const html = await page('/tests');

      expect(firstInfo(/<th [^>]*>[^<]*<span class="nw">Covered.*?<\/th>/s.exec(html)?.[0] ?? '')).toBe('ask');
      expect(partsOf(html, 'ask')).toEqual(THREE_PARTS);
    });

    it('Gaps: Files to test next and Decided not to test each carry an (i) saying what it shows', async () => {
      await tests();

      const html = await page('/tests?group=gaps');

      for (const id of ['gap-files', 'gap-decided']) {
        expect(firstInfo(panelOf(html, id))).toBe(id);
        expect(partsOf(html, id)).toEqual(['What it shows']);
      }
    });
  });

  describe('every tile, chart, panel and table on CI stability carries an (i) explaining it', () => {    it.each([
      { tile: 'Runs passed', id: 't-passed' },
      { tile: 'Time main was red', id: 't-red' },
      { tile: 'Least reliable job', id: 't-least' },
      { tile: 'Slowest job', id: 't-slowest' },
    ])('on each job, the $tile tile carries its own (i), with the three parts', async ({ tile, id }) => {
      await stability();

      const html = await page('/stability');

      expect(tileOf(html, tile)).toContain(`data-pop="x-${id}"`);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { panel: 'How every job run ended', query: '', id: 'ended' },
      { panel: 'Last run of each workflow', query: '', id: 'last-runs' },
      { panel: 'a job opened to its steps', query: '?steps=CI%7CTest', id: 'steps' },
      { panel: 'Time main was red, per day', query: '?group=day', id: 'red-per-day' },
    ])('$panel carries its own (i), with the three parts', async ({ query, id }) => {
      await stability();

      const html = await page(`/stability${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { table: 'By job', query: '', id: 'by-job' },
      { table: 'By workflow', query: '?group=workflow', id: 'by-workflow' },
      { table: 'Red spells', query: '?group=red', id: 'spells' },
      { table: 'Where they died', query: '?group=failures', id: 'where-they-died' },
      { table: 'Recent failures', query: '?group=failures', id: 'recent-failures' },
      { table: 'By day', query: '?group=day', id: 'by-day' },
    ])('the $table table carries an (i) saying what its rows are', async ({ query, id }) => {
      await stability();

      const html = await page(`/stability${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it.each([
      { table: 'Red spells', query: '?group=red', id: 'spells', said: 'main was not red in this period' },
      { table: 'Recent failures', query: '?group=failures', id: 'recent-failures', said: 'No failure in this period' },
    ])('a period main was never red in keeps the (i) on $table, which says so', async ({ query, id, said }) => {
      await stability([ran(1, '2026-10-30T08:00:00Z', 'pass')]);

      const html = await page(`/stability${query}`);

      expect(text(panelOf(html, id))).toContain(said);
      expect(firstInfo(panelOf(html, id))).toBe(id);
    });

    it('draws each (i) once, each to an explanation of its own on the page', async () => {
      await stability();

      const { buttons, panels } = infosOf(await page('/stability?steps=CI%7CTest'));

      // Four tiles, how the runs ended, the last runs, the steps and the table.
      expect(buttons).toHaveLength(8);
      expect(new Set(buttons).size).toBe(8);
      expect(panels.sort()).toEqual([...buttons].sort());
    });
  });

  describe('each test and CI page opens with its question and the words it defines', () => {
    it.each([['/selection'], ['/selection?group=rule']])('Test selection, under the band’s sentence, at %s', async (path) => {
      await selection();

      const html = await page(path);

      expect(leadOf(html)).toContain('Does CI run only the tests a change can affect?');
      for (const words of ['selected a subset', 'ran everything', 'A miss is', 'A bar is']) expect(leadOf(html)).toContain(words);
      expect(leadPlace(html)).toEqual({ afterTheSentence: true, beforeThePanels: true });
    });

    it.each([['/tests'], ['/tests?group=gaps']])('Test coverage, under the band’s sentence, at %s', async (path) => {
      await tests();

      const html = await page(path);

      expect(leadOf(html)).toContain('What do the tests cover, and at which level?');
      for (const words of ['A rule is', 'its cases are', 'A testing level is', 'An area is']) expect(leadOf(html)).toContain(words);
      expect(leadPlace(html)).toEqual({ afterTheSentence: true, beforeThePanels: true });
    });

    it('Test coverage, with no snapshot to show, opens with the same lead', async () => {
      await emptyTheDatabase();

      const html = await page('/tests');

      expect(html).toContain('No snapshot of main&rsquo;s tests has arrived yet');
      expect(leadOf(html)).toContain('What do the tests cover, and at which level?');
    });

    it.each([['/stability'], ['/stability?group=red']])('CI stability, under the band’s sentence, at %s', async (path) => {
      await stability();

      const html = await page(path);

      expect(leadOf(html)).toContain('How often do the automated checks fail, and which ones?');
      for (const words of ['A pass rate is', 'A cancelled run', 'A red spell is', 'A fluke is']) expect(leadOf(html)).toContain(words);
      expect(leadPlace(html)).toEqual({ afterTheSentence: true, beforeThePanels: true });
    });
  });

  describe('a fixed note on a test or CI page is said once, in its explanation; a note read from the figures stays', () => {
    it.each([
      { panel: 'How every job run ended', query: '', id: 'ended', note: 'A pass rate counts only the runs that finished' },
      { panel: 'a job’s steps', query: '?steps=CI%7CTest', id: 'steps', note: 'skipped and cancelled steps are left out' },
      { panel: 'Red spells', query: '?group=red', id: 'spells', note: 'A spell runs from a failing run to the next passing one' },
      { panel: 'By day', query: '?group=day', id: 'by-day', note: 'Workflows red at the same time count once under Any workflow' },
    ])('CI stability: $panel no longer says it under its heading, and its explanation does', async ({ query, id, note }) => {
      await stability();

      const html = await page(`/stability${query}`);

      expect(text(withoutExplanations(panelOf(html, id)))).not.toContain(note);
      expect(text(explanationOf(html, id))).toContain(note);
    });

    it('CI stability: past the newest hundred failures, the list still says under it how many it shows of how many', async () => {
      await stability(Array.from({ length: 101 }, (_, i) => ran(i + 1, new Date(Date.UTC(2026, 9, 30, 0, i)).toISOString(), 'fail')));

      const html = await page('/stability?group=failures');

      expect(text(withoutExplanations(panelOf(html, 'recent-failures')))).toContain('The newest 100 are listed; the counts above use all 101.');
    });

    it.each([
      { panel: 'What each job did', query: '', id: 'what-each-job-did', note: 'Selecting a subset is selection working' },
      { panel: 'By package', query: '?group=package', id: 'by-package', note: 'runs only the files the change reaches' },
      { panel: 'Most selected tests', query: '?group=test', id: 'most-selected-tests', note: 'narrowing it is what would shrink the count' },
      { panel: 'Misses', query: '?group=miss', id: 'misses', note: 'widen the import chain' },
    ])('Test selection: $panel no longer says it under its table, and its explanation does', async ({ query, id, note }) => {
      await selection();

      const html = await page(`/selection${query}`);

      expect(text(withoutExplanations(panelOf(html, id)))).not.toContain(note);
      expect(text(explanationOf(html, id))).toContain(note);
    });

    it.each([
      { situation: 'both jobs share one', thresholds: [0.3, 0.3], says: 'ran everything read against the 30% bar' },
      { situation: 'each job has its own', thresholds: [0.3, 0.4], says: 'ran everything read against each job s bar, Test job 40%, E2E job 30%' },
    ])('Test selection: what each job did reads the bar the send carried, where $situation', async ({ thresholds, says }) => {
      await selection(
        selectionBars({}, [
          { id: 'e2e-forced-full', name: 'E2E', threshold: thresholds[0], minOver: null, alarmIssue: null },
          { id: 'test-forced-full', name: 'Test', threshold: thresholds[1], minOver: null, alarmIssue: null },
          { id: 'misses', name: 'Misses', threshold: 1, minOver: null, alarmIssue: null },
          { id: 'most-selected', name: 'Most selected', threshold: 0.8, minOver: 10, alarmIssue: null },
        ]),
      );

      const html = await page('/selection');

      expect(text(withoutExplanations(panelOf(html, 'what-each-job-did')))).toContain(says);
    });
  });
});
