import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withoutExplanations } from './cockpit-support';
import { GREY, panelOf, RED, slot, swatches } from './series-colours';
import { emptyTheDatabase, sendRuns, stabilityJob, stabilityRun, stabilityStep, theSentence } from './support';

beforeEach(async () => {
  await emptyTheDatabase();
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-31T12:00:00Z') });
});
afterEach(() => vi.useRealTimers());

const thePage = async (query = '') => {
  const response = await SELF.fetch(`https://monitor.test/stability${query}`);
  expect(response.status).toBe(200);
  return response.text();
};

const CONCLUSIONS = { pass: 'success', fail: 'failure', cancelled: 'cancelled', skipped: 'skipped' } as const;
type Outcome = keyof typeof CONCLUSIONS;

/** A run of `workflow` that ended `outcome`, holding one job, `Test`, that ended the same way and took `seconds`. */
const ran = (id: number, createdAt: string, outcome: Outcome, over: { workflow?: string; seconds?: number; failedStep?: string; steps?: ReturnType<typeof stabilityStep>[] } = {}) =>
  stabilityRun(id, {
    workflow: over.workflow ?? 'CI',
    createdAt,
    conclusion: CONCLUSIONS[outcome],
    outcome,
    jobs: [
      stabilityJob('Test', (over.seconds ?? 60) * 1000, {
        conclusion: CONCLUSIONS[outcome],
        outcome,
        failedStep: outcome === 'fail' ? (over.failedStep ?? 'Run the tests') : null,
        steps: over.steps ?? [stabilityStep('Run the tests', (over.seconds ?? 60) * 500)],
      }),
    ],
  });

/** The text of a section's table rows, one array of cell texts per row. */
function rowsOf(html: string, id: string): string[][] {
  const panel = new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';
  return [...panel.matchAll(/<tr[ >].*?<\/tr>/gs)]
    .map((row) => [...row[0].matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map((cell) => cell[1]!.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter((cells) => cells.length > 0)
    .slice(1);
}

const hasSection = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"`).test(html);
/** What the page or a panel reads as its figures, without the (i)s and the explanations they open. */
const text = (html: string) => withoutExplanations(html).replace(/<style>.*?<\/style>/s, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

describe('Harness Monitor', () => {
  describe("CI stability's stored runs are a page, and the same address answers JSON to a request that asks", () => {
    it('opens as a page from its own tab in the top bar', async () => {
      const html = await thePage();

      expect(html).toMatch(/<a href="\/stability" title="[^"]*" aria-current="page">CI stability<\/a>/);
      expect(html).toMatch(/<a href="\/" title="[^"]*">Claude Code costs<\/a>/);
      expect(html.match(/<h1\b/g) ?? []).toHaveLength(0);
    });

    it.each([
      { situation: 'format=json in the address', url: 'https://monitor.test/stability?format=json', headers: {} },
      { situation: 'an Accept header for JSON', url: 'https://monitor.test/stability', headers: { accept: 'application/json' } },
    ])('answers JSON for $situation', async ({ url, headers }) => {
      const response = await SELF.fetch(url, { headers });

      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ period: '30d', windows: expect.any(Array) });
    });

    it('answers a browser, which accepts HTML first, with the page', async () => {
      const response = await SELF.fetch('https://monitor.test/stability', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });

      expect(response.headers.get('content-type')).toContain('text/html');
    });
  });

  describe('a job passes its rate as passed runs against passed and failed runs, with cancelled and skipped apart', () => {
    it('8 passed, 2 failed, 3 cancelled and 1 skipped read 80% of 10 finished, 3 cancelled', async () => {
      const outcomes: Outcome[] = [...Array<Outcome>(8).fill('pass'), 'fail', 'fail', 'cancelled', 'cancelled', 'cancelled', 'skipped'];
      await sendRuns(outcomes.map((outcome, i) => ran(i + 1, `2026-10-30T${String(i + 1).padStart(2, '0')}:00:00Z`, outcome)));

      const [row] = rowsOf(await thePage(), 'by-job');

      // Job, last run, pass rate, outcomes, failed, cancelled, median, p90
      expect(row![2]).toBe('80% 8 of 10');
      expect(row![4]).toBe('2');
      expect(row![5]).toBe('3');
    });

    it('colours a rate of 99% or more green and one under 90% red', async () => {
      await sendRuns([ran(1, '2026-10-30T09:00:00Z', 'pass'), ran(2, '2026-10-30T10:00:00Z', 'pass', { workflow: 'Nightly' }), ran(3, '2026-10-30T11:00:00Z', 'fail', { workflow: 'Nightly' })]);

      const html = await thePage('?group=workflow');

      expect(html).toMatch(/<span class="rate ok">100%<\/span>/);
      expect(html).toMatch(/<span class="rate poor">50%<\/span>/);
    });

    it('counts a job run still going among the outcomes rather than dropping it', async () => {
      const sent = await sendRuns([stabilityRun(1, { createdAt: '2026-10-30T09:00:00Z', status: 'in_progress', conclusion: null, outcome: 'running', jobs: [stabilityJob('Test', null, { status: 'in_progress', conclusion: null, outcome: 'running', completedAt: null })] })]);

      expect(sent.status).toBe(200);
      expect(await thePage()).toContain('Still running 1');
    });
  });

  describe('while a red spell is open, every tab says main is red, naming the workflow and the step it died on', () => {
    it.each([['job'], ['workflow'], ['red'], ['failures'], ['day']])('on the %s tab', async (group) => {
      await sendRuns([ran(1, '2026-10-30T09:00:00Z', 'pass'), ran(2, '2026-10-31T08:00:00Z', 'fail', { failedStep: 'Run the E2E walks' })]);

      const html = await thePage(`?group=${group}`);

      expect(text(html)).toContain('CI is red now');
      expect(text(html)).toContain('for 4h 00m');
      expect(text(html)).toContain('Test at Run the E2E walks failed');
    });

    it('is not there when nothing is red', async () => {
      await sendRuns([ran(1, '2026-10-30T09:00:00Z', 'fail'), ran(2, '2026-10-30T10:00:00Z', 'pass')]);

      expect(text(await thePage())).not.toContain('is red now');
    });

    it('says so whatever workflow the filter holds', async () => {
      await sendRuns([ran(1, '2026-10-31T08:00:00Z', 'fail', { workflow: 'Nightly' }), ran(2, '2026-10-31T09:00:00Z', 'pass')]);

      expect(text(await thePage('?workflow=CI'))).toContain('Nightly is red now');
    });
  });

  describe('Period and Workflow keep only the matching runs, on every tab', () => {
    it('Last 7 days counts the runs inside it and not those either side', async () => {
      await sendRuns([ran(1, '2026-10-12T10:00:00Z', 'fail'), ran(2, '2026-10-26T10:00:00Z', 'pass'), ran(3, '2026-10-30T10:00:00Z', 'pass')]);

      expect(rowsOf(await thePage('?period=7d'), 'by-job')[0]![2]).toBe('100% 2 of 2');
      expect(rowsOf(await thePage('?period=30d'), 'by-job')[0]![2]).toBe('66.6% 2 of 3');
    });

    it('Workflow: CI keeps only CI on the jobs, the workflows and the spells', async () => {
      await sendRuns([
        ran(1, '2026-10-30T08:00:00Z', 'fail'),
        ran(2, '2026-10-30T09:00:00Z', 'pass'),
        ran(3, '2026-10-30T08:00:00Z', 'fail', { workflow: 'Nightly' }),
        ran(4, '2026-10-30T09:00:00Z', 'pass', { workflow: 'Nightly' }),
      ]);

      const jobs = rowsOf(await thePage('?workflow=CI'), 'by-job');
      const everyWorkflow = rowsOf(await thePage('?workflow=CI&group=workflow'), 'by-workflow');
      const spells = rowsOf(await thePage('?workflow=CI&group=red'), 'spells');

      expect(jobs.map((r) => r[0])).toEqual(['Test CI · steps']);
      // Each workflow lists every workflow: a filter to one would repeat the rows, so the address drops it.
      expect(everyWorkflow.map((r) => r[0])).toEqual(['CI 1 job', 'Nightly 1 job']);
      expect(spells.map((r) => r[0])).toEqual(['CI Test · Run the tests']);
    });
  });

  describe('tiles and overview panels are on the Job tab only', () => {
    it('Job draws the tiles, the outcome bar and the last run of each workflow', async () => {
      await sendRuns([ran(1, '2026-10-30T09:00:00Z', 'pass')]);

      const html = await thePage();

      expect(html).toContain('class="tiles"');
      expect(hasSection(html, 'ended')).toBe(true);
      expect(hasSection(html, 'last-runs')).toBe(true);
    });

    it.each([['workflow'], ['red'], ['failures'], ['day']])('the %s tab goes from the sentence on the band to its own content', async (group) => {
      await sendRuns([ran(1, '2026-10-30T09:00:00Z', 'fail'), ran(2, '2026-10-30T10:00:00Z', 'pass')]);

      const html = await thePage(`?group=${group}`);

      expect(html).not.toContain('class="tiles"');
      expect(hasSection(html, 'ended')).toBe(false);
      expect(hasSection(html, 'last-runs')).toBe(false);
      expect(html.indexOf('class="band band-controls"')).toBeLessThan(html.indexOf('<main>'));
    });
  });

  describe("a job opens its steps with each step's median and p90", () => {
    it('a job with three steps shows three rows, in the order the job runs them, with their medians and p90s', async () => {
      const steps = [stabilityStep('Install', 30_000), stabilityStep('Build', 90_000), stabilityStep('Run the tests', 240_000)];
      await sendRuns([ran(1, '2026-10-30T09:00:00Z', 'pass', { steps }), ran(2, '2026-10-30T10:00:00Z', 'pass', { steps: steps.map((s) => ({ ...s, durationMs: s.durationMs! * 2 })) })]);

      const html = await thePage('?steps=CI%7CTest');

      const panel = /<section[^>]*aria-labelledby="steps".*?<\/section>/s.exec(html)![0];
      const rows = [...panel.matchAll(/<li><span class="step-name">(.*?)<\/span>.*?<span class="num">(.*?)<\/span><span class="num faint-num">(.*?)<\/span><span class="num faint-num">(.*?)<\/span><\/li>/gs)].map((m) => m.slice(1, 5));
      expect(rows).toEqual([
        ['Install', '45s', '1m 00s', '2'],
        ['Build', '2m 15s', '3m 00s', '2'],
        ['Run the tests', '6m 00s', '8m 00s', '2'],
      ]);
      expect(html).toContain('class="chosen"');
    });

    it('no steps open until a job is named', async () => {
      await sendRuns([ran(1, '2026-10-30T09:00:00Z', 'pass')]);

      expect(hasSection(await thePage(), 'steps')).toBe(false);
    });
  });

  describe('Failures counts failures per job and step, and lists each recent failure linked to its run', () => {
    it('two failures at one step and one at another read 2 and 1, most first, each failure linked to its run', async () => {
      await sendRuns([
        ran(1, '2026-10-28T09:00:00Z', 'fail', { failedStep: 'Run the tests' }),
        ran(2, '2026-10-29T09:00:00Z', 'fail', { failedStep: 'Install' }),
        ran(3, '2026-10-30T09:00:00Z', 'fail', { failedStep: 'Run the tests' }),
      ]);

      const html = await thePage('?group=failures');

      expect(rowsOf(html, 'where-they-died').map((r) => [r[0], r[2]])).toEqual([
        ['Test Run the tests', '2'],
        ['Test Install', '1'],
      ]);
      const recent = /<section[^>]*aria-labelledby="recent-failures".*?<\/section>/s.exec(html)![0];
      expect(recent).toContain('href="https://github.com/o/r/actions/runs/3"');
      expect(recent).toContain('href="https://github.com/o/r/actions/runs/1"');
      expect(rowsOf(html, 'recent-failures').map((r) => r[3])).toEqual(['Run the tests', 'Install', 'Run the tests']);
    });
  });

  describe('the order is a word of the sentence, and puts the rows in the order it names', () => {
    it('each job, slowest first, puts the slowest job first', async () => {
      await sendRuns([
        stabilityRun(1, { createdAt: '2026-10-30T09:00:00Z', jobs: [stabilityJob('Fast', 10_000), stabilityJob('Slow', 900_000), stabilityJob('Middle', 100_000)] }),
      ]);

      const html = await thePage('?sort=slowest');

      expect(rowsOf(html, 'by-job').map((r) => r[0]!.split(' ')[0])).toEqual(['Slow', 'Middle', 'Fast']);
      expect(theSentence(html).text).toBe('Show CI on main for [each job] [slowest first] over [the last 7 days]');
    });
  });

  describe('the sentence says what the page shows, and offers only what it can', () => {
    it('the bare address reads each job, least reliable first, over the last 7 days, with the Workflow filter under Only and Open in Actions after it', async () => {
      await sendRuns([ran(1, '2026-10-30T09:00:00Z', 'pass')]);

      const html = await thePage();
      const { text: sentence, choices } = theSentence(html);

      expect(sentence).toBe('Show CI on main for [each job] [least reliable first] over [the last 7 days]');
      expect(choices.group!.offered).toEqual(['each job', 'each workflow', 'each red spell', 'each failure', 'each day']);
      expect(choices.sort!.offered).toEqual(['least reliable first', 'slowest first', 'most failures first']);
      expect(choices.period!.offered).toEqual(['the last 7 days', 'the last 30 days', 'the last 90 days', 'everything held']);
      expect(Object.keys(choices)).toEqual(['group', 'sort', 'period', 'workflow']);
      expect(choices.workflow!.held).toBe(false);
      expect(/<div class="only"><span>Only<\/span>.*Open in Actions<\/a><\/div>/s.test(html)).toBe(true);
    });

    it.each([
      { situation: 'each failure', query: '?group=failures', keys: ['group', 'period', 'workflow'] },
      { situation: 'each day', query: '?group=day', keys: ['group', 'period', 'workflow'] },
      { situation: 'each red spell', query: '?group=red', keys: ['group', 'sort', 'period', 'workflow'] },
      { situation: 'each workflow, which offers no Workflow filter', query: '?group=workflow&workflow=CI', keys: ['group', 'sort', 'period'] },
    ])('$situation offers $keys', async ({ query, keys }) => {
      expect(Object.keys(theSentence(await thePage(query)).choices)).toEqual(keys);
    });

    it.each(['', '?group=workflow', '?group=red', '?group=failures', '?group=day'])('has no grouping tabs, no Sort by toggle and no labelled filter row at %s', async (query) => {
      const html = await thePage(query);

      for (const gone of ['band-tabs', 'aria-label="Group by"', 'class="filters"', 'class="toggles"', 'aria-pressed', '<label ']) expect(html).not.toContain(gone);
    });
  });

  describe('nothing stored for the period shows that there is nothing', () => {
    it('with nothing stored, every tab says nothing in this period', async () => {
      for (const group of ['job', 'workflow', 'red', 'failures', 'day']) {
        const html = await thePage(`?group=${group}`);

        expect(text(html)).toContain('Nothing in this period');
        expect(html).not.toContain('class="tiles"');
      }
    });

    it('runs older than the period leave it empty, and a longer period finds them', async () => {
      await sendRuns([ran(1, '2026-09-20T09:00:00Z', 'pass')]);

      expect(text(await thePage('?period=7d'))).toContain('Nothing in this period');
      expect(text(await thePage('?period=90d'))).not.toContain('Nothing in this period');
    });
  });

  describe('each way a run ended has its own colour, and each workflow ever red the colour of its place among them', () => {
    it('failed is red, cancelled and skipped are grey and stack last, and the series beside them is blue', async () => {
      const job = (outcome: string, name = 'Test') => stabilityJob(name, 60_000, { outcome, conclusion: outcome === 'pass' ? 'success' : outcome });
      await sendRuns([
        ran(1, '2026-10-30T10:00:00Z', 'pass'),
        ran(2, '2026-10-30T11:00:00Z', 'fail'),
        ran(3, '2026-10-30T12:00:00Z', 'cancelled'),
        ran(4, '2026-10-30T13:00:00Z', 'skipped'),
        stabilityRun(5, { createdAt: '2026-10-30T14:00:00Z', jobs: [job('running', 'Test'), job('other', 'Odd')] }),
      ]);

      const html = await thePage();

      expect(swatches(panelOf(html, 'ended'))).toEqual([
        ['Passed', slot(1)],
        ['Failed', RED],
        ['Still running', slot(2)],
        ['Other or unrecognised', slot(6)],
        ['Cancelled', GREY],
        ['Skipped', GREY],
      ]);
    });

    it('the first eight workflows ever red take the slots of their place, and the ninth is Other, in the key and in the per-day line', async () => {
      const workflows = Array.from({ length: 9 }, (_, i) => 'W' + (i + 1));
      await sendRuns(workflows.flatMap((workflow, i) => [ran(10 + i * 2, '2026-10-30T0' + i + ':00:00Z', 'fail', { workflow }), ran(11 + i * 2, '2026-10-30T0' + i + ':30:00Z', 'pass', { workflow })]));

      const html = await thePage('?group=day');

      expect(swatches(panelOf(html, 'red-per-day'))).toEqual([
        ...workflows.slice(0, 8).map((name, i) => [name, slot(i + 1)]),
        ['Other', GREY],
      ]);
      const lines = [...panelOf(html, 'red-per-day').matchAll(/<g[^>]*><polyline points="[^"]*" fill="none" stroke="([^"]*)"/g)].map((m) => m[1]);
      expect(lines).toEqual([...workflows.slice(0, 8).map((_, i) => slot(i + 1)), GREY, 'var(--ink-strong)']);
    });
  });

});
