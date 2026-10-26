import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { area, kase, model, rule, rules, statements } from '../fixtures/tests-model';
import { withoutExplanations } from './cockpit-support';
import { panelOf } from './series-colours';
import {
  ciAttempt,
  emptyTheDatabase,
  failedJob,
  failedTest,
  ranEverything,
  selectionBars,
  selectionFile,
  selectionJob,
  selectionPackage,
  selectionPull,
  sendAttempts,
  sendSelection,
  sendTestsModel,
  stabilityJob,
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
  ciAttempt(id, 1, {
    createdAt,
    conclusion: outcome === 'pass' ? 'success' : 'failure',
    outcome,
    headSha: String(id).repeat(40).slice(0, 40),
    jobs: [stabilityJob('Test', 60_000, { conclusion: outcome === 'pass' ? 'success' : 'failure', outcome, failedStep: outcome === 'fail' ? 'Run the tests' : null, steps: [stabilityStep('Run the tests', 30_000)] })],
    failedJobs: outcome === 'fail' ? [failedJob('Test', [failedTest('a dismissed item leaves the lists')], { step: 'Run the tests' })] : [],
  });
async function stability(attempts = [ran(1, '2026-10-30T08:00:00Z', 'pass'), ran(2, '2026-10-30T09:00:00Z', 'fail'), ran(3, '2026-10-30T10:00:00Z', 'pass')]) {
  await emptyTheDatabase();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
  await sendAttempts(attempts);
}

describe('Harness Monitor', () => {
  describe('every tile, chart, panel and table on Test selection carries an (i) explaining it', () => {
    it.each([
      { tile: 'Ran more than needed', id: 't-more' },
      { tile: 'Ran less than needed', id: 't-less' },
    ])('on each day, the $tile tile carries its own (i), with the three parts', async ({ tile, id }) => {
      await selection();

      const html = await page('/selection');

      expect(tileOf(html, tile)).toContain(`data-pop="x-${id}"`);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { panel: 'What each job did', id: 'what-each-job-did' },
      { panel: 'Share that ran everything per day', id: 'ran-everything-per-day' },
    ])('on each day, $panel carries its own (i), with the three parts', async ({ id }) => {
      await selection();

      const html = await page('/selection');

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { tab: 'Ran more than needed: what forced a full run', query: '?group=rule', id: 'by-rule' },
      { tab: 'Tests that were skipped, then failed on main', query: '?group=miss', id: 'misses' },
    ])('the $tab table carries an (i) saying what its rows are', async ({ query, id }) => {
      await selection();

      const html = await page(`/selection${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it.each([
      { view: 'a pull request opened through the address, what each job ran and why', query: '?group=pr&pr=1', id: 'pull-request', parts: THREE_PARTS },
      { view: 'a rule opened through the address, its paths', query: `?group=rule&rule=${RULE}`, id: 'rule', parts: ['What it shows'] },
    ])('$view carries its (i)', async ({ query, id, parts }) => {
      await selection();

      const html = await page(`/selection${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(parts);
    });

    it('a period too short for a bar to judge keeps the tiles and panels, each with its (i)', async () => {
      await selection();

      const html = await page('/selection');

      expect(tileOf(html, 'Ran more than needed')).toContain('data-pop="x-t-more"');
      expect(tileOf(html, 'Ran less than needed')).toContain('data-pop="x-t-less"');
      expect(firstInfo(panelOf(html, 'what-each-job-did'))).toBe('what-each-job-did');
    });

    it('draws each (i) once, each to an explanation of its own on the page', async () => {
      await selection();

      const { buttons, panels } = infosOf(await page('/selection'));

      // Two tiles, what each job did and the chart.
      expect(buttons).toHaveLength(4);
      expect(new Set(buttons).size).toBe(4);
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
      { panel: 'Runs per day of a workflow', query: '?group=workflow&workflow=CI', id: 'per-day' },
    ])('$panel carries its own (i), with the three parts', async ({ query, id }) => {
      await stability();

      const html = await page(`/stability${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { tile: 'Pass rate on main', id: 't-wf-rate' },
      { tile: 'Failed on main', id: 't-wf-failed' },
      { tile: 'Flaky on feature branches', id: 't-wf-flaky' },
      { tile: 'Top cause', id: 't-wf-top' },
    ])('on a workflow, the $tile tile carries its own (i), with the three parts', async ({ tile, id }) => {
      await stability();

      const html = await page('/stability?group=workflow&workflow=CI');

      expect(tileOf(html, tile)).toContain(`data-pop="x-${id}"`);
      expect(partsOf(html, id)).toEqual(THREE_PARTS);
    });

    it.each([
      { table: 'By job', query: '', id: 'by-job' },
      { table: 'By workflow', query: '?group=workflow', id: 'by-workflow' },
      { table: 'What made a workflow fail', query: '?group=workflow&workflow=CI', id: 'causes' },
      { table: 'Every failure', query: '?group=workflow&workflow=CI', id: 'every-failure' },
    ])('the $table table carries an (i) saying what its rows are', async ({ query, id }) => {
      await stability();

      const html = await page(`/stability${query}`);

      expect(firstInfo(panelOf(html, id))).toBe(id);
      expect(partsOf(html, id)).toEqual(['What it shows']);
    });

    it.each([
      { table: 'What made a workflow fail', id: 'causes', said: 'No failure in this period' },
      { table: 'Every failure', id: 'every-failure', said: 'No failure in this period' },
    ])('a period main never failed in keeps the (i) on $table, which says so', async ({ id, said }) => {
      await stability([ran(1, '2026-10-30T08:00:00Z', 'pass')]);

      const html = await page('/stability?group=workflow&workflow=CI');

      expect(text(panelOf(html, id))).toContain(said);
      expect(firstInfo(panelOf(html, id))).toBe(id);
    });

    it('the Fragile tests table carries an (i) saying what its rows are, and keeps it in a period with no fragile test, which says so', async () => {
      await stability();
      const empty = panelOf(await page('/stability?group=tests'), 'fragile');
      expect(text(empty)).toContain('No test failed and then passed on the same commit in this period');
      expect(firstInfo(empty)).toBe('fragile');

      await sendAttempts([
        ciAttempt(20, 1, { createdAt: '2026-10-30T11:00:00Z', conclusion: 'failure', outcome: 'fail', headSha: 'c'.repeat(40), failedJobs: [failedJob('Test', [failedTest('a dismissed item leaves the lists')])] }),
        ciAttempt(20, 2, { createdAt: '2026-10-30T11:30:00Z', headSha: 'c'.repeat(40) }),
      ]);
      const html = await page('/stability?group=tests');
      expect(text(panelOf(html, 'fragile'))).toContain('a dismissed item leaves the lists');
      expect(firstInfo(panelOf(html, 'fragile'))).toBe('fragile');
      expect(partsOf(html, 'fragile')).toEqual(['What it shows']);
      const { buttons, panels } = infosOf(html);
      expect(buttons).toHaveLength(1);
      expect(panels).toEqual(buttons);
    });

    it('draws each (i) once, each to an explanation of its own on the page', async () => {
      await stability();

      const { buttons, panels } = infosOf(await page('/stability?steps=CI%7CTest'));

      // Three tiles, how the runs ended, the last runs, the steps and the table.
      expect(buttons).toHaveLength(7);
      expect(new Set(buttons).size).toBe(7);
      expect(panels.sort()).toEqual([...buttons].sort());
    });

    it.each([
      { situation: 'the rows', query: '?group=workflow', count: 1 },
      { situation: "a workflow's view", query: '?group=workflow&workflow=CI', count: 7 },
    ])('draws each (i) of the Workflow tab once, on $situation', async ({ query, count }) => {
      await stability();

      const { buttons, panels } = infosOf(await page(`/stability${query}`));

      expect(buttons).toHaveLength(count);
      expect(new Set(buttons).size).toBe(count);
      expect(panels.sort()).toEqual([...buttons].sort());
    });
  });

  describe('each test and CI page opens with its question and the words it defines', () => {
    it.each([['/selection'], ['/selection?group=rule']])('Test selection, under the band’s sentence, at %s', async (path) => {
      await selection();

      const html = await page(path);

      expect(leadOf(html)).toContain('Does CI run only the tests a change can affect?');
      for (const words of ['selected a subset', 'ran everything', 'A test skipped, then failed on main', 'A bar is']) expect(leadOf(html)).toContain(words);
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

    it.each([['/stability'], ['/stability?group=workflow']])('CI stability, under the band’s sentence, at %s', async (path) => {
      await stability();

      const html = await page(path);

      expect(leadOf(html)).toContain('How often do the automated checks fail, and which ones?');
      for (const words of ['A pass rate is', 'A cancelled run', 'flaky when a later attempt on the same commit passed', 'A cause is the failing test']) expect(leadOf(html)).toContain(words);
      expect(leadPlace(html)).toEqual({ afterTheSentence: true, beforeThePanels: true });
    });
  });

  describe('a fixed note on a test or CI page is said once, in its explanation; a note read from the figures stays', () => {
    it.each([
      { panel: 'How every job run ended', query: '', id: 'ended', note: 'A pass rate counts only the runs that finished' },
      { panel: 'a job’s steps', query: '?steps=CI%7CTest', id: 'steps', note: 'skipped and cancelled steps are left out' },
      { panel: 'By workflow', query: '?group=workflow', id: 'by-workflow', note: 'A feature branch counts only a failure that a later attempt on the same commit passed' },
      { panel: 'What made a workflow fail', query: '?group=workflow&workflow=CI', id: 'causes', note: 'A cause is the failing test where the attempt names one, otherwise the job and step' },
    ])('CI stability: $panel no longer says it under its heading, and its explanation does', async ({ query, id, note }) => {
      await stability();

      const html = await page(`/stability${query}`);

      expect(text(withoutExplanations(panelOf(html, id)))).not.toContain(note);
      expect(text(explanationOf(html, id))).toContain(note);
    });

    it.each([
      { panel: 'What each job did', query: '', id: 'what-each-job-did', note: 'Selecting a subset is selection working' },
      { panel: 'Tests that were skipped, then failed on main', query: '?group=miss', id: 'misses', note: 'whether the change could have broken the test' },
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
