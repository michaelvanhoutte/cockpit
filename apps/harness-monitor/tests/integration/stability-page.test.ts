import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withoutExplanations } from './cockpit-support';
import { GREY, panelOf, RED, slot, swatches } from './series-colours';
import { ciAttempt, emptyTheDatabase, failedJob, failedTest, selectionPull, sendAttempts, sendSelection, stabilityJob, stabilityStep, theSentence } from './support';

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

/** An attempt of `workflow` on main that ended `outcome`, holding one job, `Test`, that ended the same way and took `seconds`. */
const ran = (id: number, createdAt: string, outcome: Outcome, over: { workflow?: string; seconds?: number; failedStep?: string; steps?: ReturnType<typeof stabilityStep>[] } = {}) =>
  ciAttempt(id, 1, {
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

const sha = (c: string) => ({ headSha: c.repeat(40) });
/** An attempt of CI on main, or whatever `over` says, that ended `outcome`. */
const on = (runId: number, attempt: number, createdAt: string, outcome: 'pass' | 'fail' | 'cancelled', over: Record<string, unknown> = {}) =>
  ciAttempt(runId, attempt, { createdAt, conclusion: CONCLUSIONS[outcome], outcome, ...over });
/** What makes an attempt one of a pull request's. */
const branch = (pull: number, over: Record<string, unknown> = {}) => ({ onMain: false, event: 'pull_request', branch: `claude/${pull}-change`, pullRequest: pull, jobs: [], ...over });
/** The failed job of an attempt, naming the tests that failed in it. */
const died = (tests: string[] = [], job = 'Test', step = 'Run pnpm test') => ({ failedJobs: [failedJob(job, tests.map((t) => failedTest(t)), { step })] });
const plain = (cell: string) => cell.replace(/<pre hidden>.*?<\/pre>/gs, '').replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, ' ').replace(/\s+/g, ' ').trim();
/** Each row of the Workflow tab: what its cells read, the strip's squares by day, its prompt and the strip it opens to. */
const workflowRows = (html: string) =>
  [...panelOf(html, 'by-workflow').matchAll(/<tr data-opens>(.*?)<\/tr><tr class="detail" hidden><td colspan="6">(.*?)<\/td><\/tr>/gs)].map(([, row, detail]) => {
    const cells = [...row!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => c[1]!);
    return {
      name: plain(cells[0]!),
      rate: plain(cells[1]!),
      squares: [...cells[2]!.matchAll(/<span title="([^"]*)"><i class="(\w+)"><\/i><b class="(\w*)"><\/b><\/span>/g)].map(([, title, cls, dot]) => ({ title: title!.replace(/&#183;/g, '·'), cls: cls!, dot: dot === 'branch' })),
      failed: plain(cells[3]!),
      top: plain(cells[4]!),
      prompt: cells[5]!.includes('class="copy-prompt"') ? /<pre hidden>(.*?)<\/pre>/s.exec(cells[5]!)![1]! : null,
      detail: detail!,
    };
  });
/** The causes a side of an opened row lists: its count and name. */
const sideCauses = (detail: string, kind: 'main' | 'branch') =>
  [...(new RegExp(`<div class="side ${kind}">(.*?)</div>`, 's').exec(detail)?.[1] ?? '').matchAll(/<li><span class="n \w+">(\d+)<\/span><span>(.*?)<span class="of">/g)].map(([, n, name]) => `${n} ${name}`);

/** The text of a section's table rows, one array of cell texts per row. */
function rowsOf(html: string, id: string): string[][] {
  const panel = new RegExp(`<section[^>]*aria-labelledby="${id}".*?</section>`, 's').exec(html)?.[0] ?? '';
  return [...panel.matchAll(/<tr[ >].*?<\/tr>/gs)]
    .filter((row) => !row[0].startsWith('<tr class="detail"'))
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
    // (the Workflow tab's own rates are held in 'the Workflow tab draws a row per workflow' below)
    it('8 passed, 2 failed, 3 cancelled and 1 skipped read 80% of 10 finished, 3 cancelled', async () => {
      const outcomes: Outcome[] = [...Array<Outcome>(8).fill('pass'), 'fail', 'fail', 'cancelled', 'cancelled', 'cancelled', 'skipped'];
      await sendAttempts(outcomes.map((outcome, i) => ran(i + 1, `2026-10-30T${String(i + 1).padStart(2, '0')}:00:00Z`, outcome)));

      const [row] = rowsOf(await thePage(), 'by-job');

      // Job, last run, pass rate, outcomes, failed, cancelled, median, p90
      expect(row![2]).toBe('80% 8 of 10');
      expect(row![4]).toBe('2');
      expect(row![5]).toBe('3');
    });

    it('colours a rate of 99% or more green and one under 90% red', async () => {
      await sendAttempts([ran(1, '2026-10-30T09:00:00Z', 'pass'), ran(2, '2026-10-30T10:00:00Z', 'pass'), ran(3, '2026-10-30T11:00:00Z', 'fail'), ran(4, '2026-10-30T09:00:00Z', 'pass', { workflow: 'Nightly' })]);

      const html = await thePage();

      expect(html).toMatch(/<span class="rate ok">100%<\/span>/);
      expect(html).toMatch(/<span class="rate poor">66.6%<\/span>/);
    });

    it('counts a job run still going among the outcomes rather than dropping it', async () => {
      const sent = await sendAttempts([ran(1, '2026-10-30T08:00:00Z', 'pass'), ciAttempt(2, 1, { createdAt: '2026-10-30T09:00:00Z', jobs: [stabilityJob('Test', null, { status: 'in_progress', conclusion: null, outcome: 'running', completedAt: null })] })]);

      expect(sent.status).toBe(200);
      expect(await thePage()).toContain('Still running 1');
    });
  });

  describe('Period and Workflow keep only the matching runs, on every tab', () => {
    it('Last 7 days counts the runs inside it and not those either side', async () => {
      await sendAttempts([ran(1, '2026-10-12T10:00:00Z', 'fail'), ran(2, '2026-10-26T10:00:00Z', 'pass'), ran(3, '2026-10-30T10:00:00Z', 'pass')]);

      expect(rowsOf(await thePage('?period=7d'), 'by-job')[0]![2]).toBe('100% 2 of 2');
      expect(rowsOf(await thePage('?period=30d'), 'by-job')[0]![2]).toBe('66.6% 2 of 3');
    });

    it('Workflow: CI keeps only CI on the jobs', async () => {
      await sendAttempts([
        ran(1, '2026-10-30T08:00:00Z', 'fail'),
        ran(2, '2026-10-30T09:00:00Z', 'pass'),
        ran(3, '2026-10-30T08:00:00Z', 'fail', { workflow: 'Nightly' }),
        ran(4, '2026-10-30T09:00:00Z', 'pass', { workflow: 'Nightly' }),
      ]);

      const jobs = rowsOf(await thePage('?workflow=CI'), 'by-job');

      expect(jobs.map((r) => r[0])).toEqual(['Test CI · steps']);
    });
  });

  describe('tiles and overview panels are on the Job tab only', () => {
    it('Job draws the tiles, the outcome bar and the last run of each workflow', async () => {
      await sendAttempts([ran(1, '2026-10-30T09:00:00Z', 'pass')]);

      const html = await thePage();

      expect(html).toContain('class="tiles"');
      expect(hasSection(html, 'ended')).toBe(true);
      expect(hasSection(html, 'last-runs')).toBe(true);
    });

    it('Workflow goes from the sentence on the band to its own content', async () => {
      await sendAttempts([ciAttempt(1, 1, { createdAt: '2026-10-30T09:00:00Z' })]);

      const html = await thePage('?group=workflow');

      expect(html).not.toContain('class="tiles"');
      expect(hasSection(html, 'ended')).toBe(false);
      expect(hasSection(html, 'last-runs')).toBe(false);
      expect(html.indexOf('class="band band-controls"')).toBeLessThan(html.indexOf('<main>'));
    });
  });

  describe("a job opens its steps with each step's median and p90", () => {
    it('a job with three steps shows three rows, in the order the job runs them, with their medians and p90s', async () => {
      const steps = [stabilityStep('Install', 30_000), stabilityStep('Build', 90_000), stabilityStep('Run the tests', 240_000)];
      await sendAttempts([ran(1, '2026-10-30T09:00:00Z', 'pass', { steps }), ran(2, '2026-10-30T10:00:00Z', 'pass', { steps: steps.map((s) => ({ ...s, durationMs: s.durationMs! * 2 })) })]);

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
      await sendAttempts([ran(1, '2026-10-30T09:00:00Z', 'pass')]);

      expect(hasSection(await thePage(), 'steps')).toBe(false);
    });
  });

  describe('the order is a word of the sentence, and puts the rows in the order it names', () => {
    it('each job, slowest first, puts the slowest job first', async () => {
      await sendAttempts([ciAttempt(1, 1, { createdAt: '2026-10-30T09:00:00Z', jobs: [stabilityJob('Fast', 10_000), stabilityJob('Slow', 900_000), stabilityJob('Middle', 100_000)] })]);

      const html = await thePage('?sort=slowest');

      expect(rowsOf(html, 'by-job').map((r) => r[0]!.split(' ')[0])).toEqual(['Slow', 'Middle', 'Fast']);
      expect(theSentence(html).text).toBe('Show CI for [each job] [slowest first] over [the last 7 days]');
    });
  });

  describe('the sentence says what the page shows, and offers only what it can', () => {
    it('the bare address reads each job, least reliable first, over the last 7 days, with the Workflow filter under Only and Open in Actions after it, unfiltered since it counts every branch', async () => {
      await sendAttempts([ran(1, '2026-10-30T09:00:00Z', 'pass')]);

      const html = await thePage();
      const { text: sentence, choices } = theSentence(html);

      expect(sentence).toBe('Show CI for [each job] [least reliable first] over [the last 7 days]');
      expect(choices.group!.offered).toEqual(['each job', 'each workflow', 'each fragile test']);
      expect(choices.sort!.offered).toEqual(['least reliable first', 'slowest first', 'most failures first']);
      expect(choices.period!.offered).toEqual(['the last 7 days', 'the last 30 days', 'the last 90 days', 'everything held']);
      expect(Object.keys(choices)).toEqual(['group', 'sort', 'period', 'workflow']);
      expect(choices.workflow!.held).toBe(false);
      expect(/<div class="only"><span>Only<\/span>.*Open in Actions<\/a><\/div>/s.test(html)).toBe(true);
      expect(html).toContain('href="https://github.com/michaelvanhoutte/cockpit/actions"');
    });

    it('each workflow reads the same, offers the Workflow filter, and opens Actions unfiltered', async () => {
      await sendAttempts([ciAttempt(1, 1, { createdAt: '2026-10-30T09:00:00Z' })]);

      const html = await thePage('?group=workflow');
      const { text: sentence, choices } = theSentence(html);

      expect(sentence).toBe('Show CI for [each workflow] [least reliable first] over [the last 7 days]');
      expect(choices.sort!.offered).toEqual(['least reliable first', 'most failures first']);
      expect(Object.keys(choices)).toEqual(['group', 'sort', 'period', 'workflow']);
      expect(choices.workflow!.offered).toEqual(['All workflows', 'CI']);
      expect(html).toContain('href="https://github.com/michaelvanhoutte/cockpit/actions"');
    });

    it.each(['', '?group=workflow'])('has no grouping tabs, no Sort by toggle and no labelled filter row at %s', async (query) => {
      const html = await thePage(query);

      for (const gone of ['band-tabs', 'aria-label="Group by"', 'class="filters"', 'class="toggles"', 'aria-pressed', '<label ']) expect(html).not.toContain(gone);
    });
  });

  describe('nothing stored for the period shows that there is nothing', () => {
    it('with nothing stored, every tab says nothing in this period', async () => {
      for (const group of ['job', 'workflow', 'tests']) {
        const html = await thePage(`?group=${group}`);

        expect(text(html)).toContain('Nothing in this period');
        expect(html).not.toContain('class="tiles"');
      }
    });

    it('runs older than the period leave it empty, and a longer period finds them', async () => {
      await sendAttempts([ran(1, '2026-09-20T09:00:00Z', 'pass')]);

      expect(text(await thePage('?period=7d'))).toContain('Nothing in this period');
      expect(text(await thePage('?period=90d'))).not.toContain('Nothing in this period');
    });
  });

  describe('each way a run ended has its own colour', () => {
    it('failed is red, cancelled and skipped are grey and stack last, and the series beside them is blue', async () => {
      const job = (outcome: string, name = 'Test') => stabilityJob(name, 60_000, { outcome, conclusion: outcome === 'pass' ? 'success' : outcome });
      await sendAttempts([
        ran(1, '2026-10-30T10:00:00Z', 'pass'),
        ran(2, '2026-10-30T11:00:00Z', 'fail'),
        ran(3, '2026-10-30T12:00:00Z', 'cancelled'),
        ran(4, '2026-10-30T13:00:00Z', 'skipped'),
        ciAttempt(5, 1, { createdAt: '2026-10-30T14:00:00Z', jobs: [job('running', 'Test'), job('other', 'Odd')] }),
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

  });

  describe("the Job tab draws main's figures in each job's row, and opens it to main beside the feature branches", () => {
    const test = (outcome: Outcome, over: Record<string, unknown> = {}) =>
      stabilityJob('Test', 60_000, { conclusion: CONCLUSIONS[outcome], outcome, failedStep: outcome === 'fail' ? 'Run the tests' : null, steps: [stabilityStep('Run the tests', 30_000)], ...over });
    /** Test on main: passed, failed at `x` and was never re-run, passed; a pull request's Test failed at `x` and `y` and passed on a re-run, and Lint failed only there, at once; a third pull request's Test failed and stayed failed. */
    const SCENARIO = [
      on(1, 1, '2026-10-30T09:00:00Z', 'pass', { ...sha('a'), jobs: [test('pass')] }),
      on(2, 1, '2026-10-30T10:00:00Z', 'fail', { ...sha('b'), jobs: [test('fail')], ...died(['x']) }),
      on(3, 1, '2026-10-30T11:00:00Z', 'pass', { ...sha('c'), jobs: [test('pass')] }),
      on(10, 1, '2026-10-29T10:00:00Z', 'fail', { ...branch(5), ...sha('d'), failedJobs: [failedJob('Test', [failedTest('x'), failedTest('y')]), failedJob('Lint', [], { step: 'Run pnpm lint' })] }),
      on(10, 2, '2026-10-29T10:30:00Z', 'pass', { ...branch(5), ...sha('d') }),
      on(11, 1, '2026-10-29T12:00:00Z', 'fail', { ...branch(6), ...sha('e'), ...died(['z']) }),
    ];
    /** Each row of the Job tab: what its cells read and the strip it opens to. */
    const jobRows = (html: string) =>
      [...panelOf(html, 'by-job').matchAll(/<tr data-opens="([^"]*)"[^>]*>(.*?)<\/tr><tr class="detail" hidden><td colspan="8">(.*?)<\/td><\/tr>/gs)].map(([, name, row, detail]) => {
        const cells = [...row!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => plain(c[1]!));
        return { name: name!, cells, rate: cells[2]!, failed: cells[4]!, detail: detail! };
      });

    it("the tiles and panels count main: a feature branch's attempts are in none of them, and no tile counts the time main was red", async () => {
      await sendAttempts(SCENARIO);

      const html = await thePage();
      const said = text(html);

      expect(said).toContain('Runs passed 66.6% 2 of 3 finished');
      expect(said).not.toContain('Time main was red');
      expect(html).not.toContain('id="x-t-red"');
      expect(said).toContain('3 job runs on main');
      expect(hasSection(html, 'last-runs')).toBe(true);
    });

    it("a row keeps main's pass rate and failures, with the flaky failures on feature branches beneath, and a job that only flaked on a branch has a row with nothing on main", async () => {
      await sendAttempts(SCENARIO);

      const rows = jobRows(await thePage());

      expect(rows.map((r) => [r.name, r.rate, r.failed])).toEqual([
        ['Test', '66.6% 2 of 3', '1 +1 on branches'],
        ['Lint', 'no data 0 finished', '— +1 on branches'],
      ]);
    });

    it('a row opens to main beside its feature branches, each with its summary and its top causes', async () => {
      await sendAttempts(SCENARIO);

      const [theTest, lint] = jobRows(await thePage());

      expect(plain(theTest!.detail)).toContain('On main 3 runs · 66.6% passed · 1 failure, 0 passed on a re-run');
      expect(sideCauses(theTest!.detail, 'main')).toEqual(['1 x']);
      expect(plain(theTest!.detail)).toContain('On feature branches 1 failure a later attempt on the same commit passed · 1 commit · 1 branch');
      expect(sideCauses(theTest!.detail, 'branch')).toEqual(['1 x', '1 y']);
      expect(plain(theTest!.detail)).toContain('time goes on main');
      expect(plain(lint!.detail)).toContain('On main No finished run on main in this period.');
      expect(sideCauses(lint!.detail, 'branch')).toEqual(['1 Lint · Run pnpm lint']);
      expect(plain(lint!.detail)).toContain('No step of this job is stored for main.');
    });

    it('a job that did not flake on a branch says so in its strip', async () => {
      await sendAttempts([on(1, 1, '2026-10-30T09:00:00Z', 'pass', { jobs: [test('pass')] })]);

      const [row] = jobRows(await thePage());

      expect(plain(row!.detail)).toContain('This job did not fail and then pass on a feature branch.');
      expect(row!.failed).toBe('—');
    });

    it("a job's steps open beside its row, as main's, and its row stays one that opens", async () => {
      await sendAttempts(SCENARIO);

      const html = await thePage('?steps=CI%7CTest');

      expect(text(panelOf(html, 'steps'))).toContain('CI · on main · median 1m 00s');
      expect(panelOf(html, 'by-job')).toContain('<tr data-opens="Test" class="chosen">');
      expect(plain(jobRows(html)[0]!.detail)).toContain('Hide where Test');
    });

    it("a branch attempt's jobs and steps are never counted as main's", async () => {
      await sendAttempts([
        ...SCENARIO,
        on(12, 1, '2026-10-30T12:00:00Z', 'pass', { ...branch(7), ...sha('f'), jobs: [stabilityJob('Test', 900_000, { steps: [stabilityStep('A branch-only step', 800_000)] })] }),
      ]);

      const html = await thePage('?steps=CI%7CTest');

      expect(jobRows(html)[0]!.rate).toBe('66.6% 2 of 3');
      expect(text(panelOf(html, 'steps'))).not.toContain('A branch-only step');
      expect(text(html)).toContain('3 job runs on main');
    });

    it("the Workflow filter keeps only that workflow's jobs and the flakes on its branches", async () => {
      await sendAttempts([
        ...SCENARIO,
        on(20, 1, '2026-10-30T09:00:00Z', 'fail', { workflow: 'Nightly', ...sha('1'), jobs: [test('fail')], ...died(['n']) }),
        on(21, 1, '2026-10-29T09:00:00Z', 'fail', { workflow: 'Review', ...branch(8), ...sha('2'), failedJobs: [failedJob('Review', [])] }),
        on(21, 2, '2026-10-29T09:30:00Z', 'pass', { workflow: 'Review', ...branch(8), ...sha('2') }),
      ]);

      const names = async (query: string) => jobRows(await thePage(query)).map((r) => [r.name, r.cells[0]]);

      expect(await names('?workflow=CI')).toEqual([['Test', 'Test CI · steps'], ['Lint', 'Lint CI']]);
      expect(await names('?workflow=Review')).toEqual([['Review', 'Review Review']]);
      expect(await names('?workflow=Nightly')).toEqual([['Test', 'Test Nightly · steps']]);
    });

    it('the period changed counts only what is in it, on main and on the branches', async () => {
      await sendAttempts([
        ...SCENARIO,
        on(30, 1, '2026-10-10T10:00:00Z', 'fail', { ...sha('3'), jobs: [test('fail')], ...died(['old']) }),
        on(31, 1, '2026-10-10T11:00:00Z', 'fail', { ...branch(9), ...sha('4'), ...died(['old']) }),
        on(31, 2, '2026-10-10T11:30:00Z', 'pass', { ...branch(9), ...sha('4') }),
      ]);

      expect(jobRows(await thePage('?period=7d'))[0]!.failed).toBe('1 +1 on branches');
      expect(jobRows(await thePage('?period=30d'))[0]!.failed).toBe('2 +2 on branches');
    });

    it("draws a row's strip in the page, hidden, for the opening script to show, with one script for the table", async () => {
      await sendAttempts(SCENARIO);

      const html = await thePage();

      expect(html.match(/<tr class="detail" hidden>/g)).toHaveLength(2);
      expect(html.match(/<table class="openable">/g)).toHaveLength(1);
      expect(html.match(/function toggle\(row\)/g)).toHaveLength(1);
    });

    it('most failures puts the job that flaked on more branches first when main failed both as often', async () => {
      await sendAttempts([
        on(1, 1, '2026-10-30T09:00:00Z', 'pass', { jobs: [stabilityJob('Quiet', 1_000), stabilityJob('Flaky on branches', 1_000)] }),
        on(2, 1, '2026-10-30T10:00:00Z', 'fail', { ...branch(5), ...sha('b'), failedJobs: [failedJob('Flaky on branches', [])] }),
        on(2, 2, '2026-10-30T10:30:00Z', 'pass', { ...branch(5), ...sha('b') }),
      ]);

      expect(jobRows(await thePage('?sort=failures')).map((r) => r.name)).toEqual(['Flaky on branches', 'Quiet']);
    });

    it('a job the report does not recognise is said, not counted', async () => {
      await sendAttempts([on(1, 1, '2026-10-30T09:00:00Z', 'pass', { jobs: [stabilityJob('Test', 1_000), stabilityJob('Odd', 1_000, { conclusion: 'startup_failure', outcome: 'unknown' })] })]);

      expect(text(await thePage())).toContain('Not counted, because the report does not recognise them: 1 run or job concluded startup_failure');
    });

    it('a job name and a cause are drawn as text, never as markup', async () => {
      const name = '<img src=x onerror=alert(1)>';
      await sendAttempts([
        on(1, 1, '2026-10-30T09:00:00Z', 'fail', { ...sha('b'), jobs: [stabilityJob(name, 1_000, { outcome: 'fail', conclusion: 'failure', steps: [stabilityStep('<b>step</b>', 500)] })], failedJobs: [failedJob(name, [failedTest('<script>alert(1)</script>')])] }),
      ]);

      for (const query of ['', `?steps=${encodeURIComponent(`CI|${name}`)}`]) {
        const html = await thePage(query);

        for (const markup of ['<img src=x', '<script>alert(1)', '<b>step']) expect(html).not.toContain(markup);
      }
    });
  });

  describe('the Workflow tab draws a row per workflow, ranked by main, opening to main beside its feature branches', () => {
    /** CI: a failure on main never re-run, one on main a re-run passed with two tests failing, a pull request's flake, and one of another pull request's that stayed failed. */
    const SCENARIO = [
      on(1, 1, '2026-10-30T09:00:00Z', 'pass', { ...sha('a') }),
      on(2, 1, '2026-10-30T10:00:00Z', 'fail', { ...sha('b'), ...died(['x']) }),
      on(3, 1, '2026-10-30T11:00:00Z', 'fail', { ...sha('c'), ...died(['x', 'y']) }),
      on(3, 2, '2026-10-30T11:30:00Z', 'pass', { ...sha('c') }),
      on(10, 1, '2026-10-29T10:00:00Z', 'fail', { ...branch(5), ...sha('d'), ...died(['x']) }),
      on(10, 2, '2026-10-29T10:30:00Z', 'pass', { ...branch(5), ...sha('d') }),
      on(11, 1, '2026-10-29T12:00:00Z', 'fail', { ...branch(6), ...sha('e'), ...died(['x']) }),
    ];

    it.each([
      { situation: 'least reliable on main first', query: '?group=workflow', expected: ['Nightly', 'CI'] },
      { situation: 'most failures on main first', query: '?group=workflow&sort=failures', expected: ['CI', 'Nightly'] },
    ])('$situation', async ({ query, expected }) => {
      await sendAttempts([
        ...Array.from({ length: 8 }, (_, i) => on(100 + i, 1, `2026-10-30T0${i}:00:00Z`, 'pass')),
        ...Array.from({ length: 2 }, (_, i) => on(120 + i, 1, `2026-10-30T1${i}:00:00Z`, 'fail')),
        on(130, 1, '2026-10-30T09:00:00Z', 'pass', { workflow: 'Nightly' }),
        on(131, 1, '2026-10-30T10:00:00Z', 'fail', { workflow: 'Nightly' }),
      ]);

      expect(workflowRows(await thePage(query)).map((r) => r.name)).toEqual(expected);
    });

    it("a row reads main's pass rate, its failures with the branches' beneath, and its top cause as a share of the failures counted", async () => {
      await sendAttempts(SCENARIO);

      const [row, ...others] = workflowRows(await thePage('?group=workflow'));

      expect(others).toEqual([]);
      expect({ name: row!.name, rate: row!.rate, failed: row!.failed, top: row!.top }).toEqual({ name: 'CI', rate: '50% 2 of 4', failed: '2 +1 on branches', top: 'x 3 of 3' });
    });

    it('a workflow that only flaked on a feature branch has a row with no pass rate on main, its branch count and a prompt', async () => {
      await sendAttempts([
        on(1, 1, '2026-10-29T10:00:00Z', 'fail', { ...branch(7), workflow: 'Review', ...sha('b'), ...died(['x']) }),
        on(1, 2, '2026-10-29T10:30:00Z', 'pass', { ...branch(7), workflow: 'Review', ...sha('b') }),
      ]);

      const [row] = workflowRows(await thePage('?group=workflow'));

      expect({ name: row!.name, rate: row!.rate, failed: row!.failed, hasPrompt: row!.prompt !== null }).toEqual({ name: 'Review', rate: 'no run on main', failed: '— +1 on branches', hasPrompt: true });
    });

    it('a workflow with no failure has a row and no prompt', async () => {
      await sendAttempts([on(1, 1, '2026-10-30T09:00:00Z', 'pass'), on(2, 1, '2026-10-30T10:00:00Z', 'pass', { ...sha('b') })]);

      const [row] = workflowRows(await thePage('?group=workflow'));

      expect({ rate: row!.rate, failed: row!.failed, top: row!.top, prompt: row!.prompt }).toEqual({ rate: '100% 2 of 2', failed: '—', top: '—', prompt: null });
    });

    it("a branch failure whose re-run was cancelled is not counted, and a cancelled attempt does not make main's failure flaky", async () => {
      await sendAttempts([
        on(1, 1, '2026-10-30T09:00:00Z', 'pass'),
        on(2, 1, '2026-10-30T10:00:00Z', 'fail', { ...branch(5), ...sha('b') }),
        on(2, 2, '2026-10-30T10:10:00Z', 'cancelled', { ...branch(5), ...sha('b') }),
        on(3, 1, '2026-10-30T11:00:00Z', 'fail', { ...sha('c') }),
        on(3, 2, '2026-10-30T11:10:00Z', 'cancelled', { ...sha('c') }),
      ]);

      const [row] = workflowRows(await thePage('?group=workflow'));

      expect({ rate: row!.rate, failed: row!.failed }).toEqual({ rate: '50% 1 of 2', failed: '1' });
      expect(plain(row!.detail)).toContain('1 failure');
      expect(plain(row!.detail)).toContain('1 failure, 0 passed on a re-run');
      expect(plain(row!.detail)).toContain('Nothing failed and then passed on a feature branch.');
    });

    it('a failed attempt a later one passed counts even when a cancelled attempt came between them', async () => {
      await sendAttempts([
        on(1, 1, '2026-10-30T10:00:00Z', 'fail', { ...branch(5), ...sha('b') }),
        on(1, 2, '2026-10-30T10:10:00Z', 'cancelled', { ...branch(5), ...sha('b') }),
        on(1, 3, '2026-10-30T10:20:00Z', 'pass', { ...branch(5), ...sha('b') }),
      ]);

      expect(workflowRows(await thePage('?group=workflow'))[0]!.failed).toBe('— +1 on branches');
    });

    it("each row has a square for every day of the period, coloured by main's pass rate that day, and a dot on a day a feature branch flaked", async () => {
      await sendAttempts(SCENARIO);

      const { squares } = workflowRows(await thePage('?group=workflow'))[0]!;

      expect(squares.map((s) => [s.title.split(' · ')[0], s.cls, s.dot])).toEqual([
        ['25 Oct 2026', 'none', false],
        ['26 Oct 2026', 'none', false],
        ['27 Oct 2026', 'none', false],
        ['28 Oct 2026', 'none', false],
        ['29 Oct 2026', 'none', true],
        ['30 Oct 2026', 'poor', false],
        ['31 Oct 2026', 'none', false],
      ]);
      expect(squares[5]!.title).toBe('30 Oct 2026 · main: 50%, 2 failed of 4');
      expect(squares[4]!.title).toBe('29 Oct 2026 · main: no finished run · feature branches: 1 flaky');
    });

    it('a row opens to main beside its feature branches, each with its summary and its top causes', async () => {
      await sendAttempts(SCENARIO);

      const { detail } = workflowRows(await thePage('?group=workflow'))[0]!;

      expect(plain(detail)).toContain('On main 4 runs · 50% passed · 2 failures, 1 passed on a re-run');
      expect(plain(detail)).toContain('On feature branches 1 failure a later attempt on the same commit passed · 1 commit · 1 branch');
      expect(sideCauses(detail, 'main')).toEqual(['2 x', '1 y']);
      expect(sideCauses(detail, 'branch')).toEqual(['1 x']);
      expect(plain(detail)).toContain('Runs per day and every failure of CI');
    });

    it('lists three causes a side and counts the rest', async () => {
      await sendAttempts([on(1, 1, '2026-10-30T10:00:00Z', 'fail', { ...died(['a', 'b', 'c', 'd', 'e']) })]);

      const { detail } = workflowRows(await thePage('?group=workflow'))[0]!;

      expect(sideCauses(detail, 'main')).toHaveLength(3);
      expect(plain(detail)).toContain('and 2 other causes');
    });

    it('draws a row\'s strip in the page, hidden, for the opening script to show', async () => {
      await sendAttempts(SCENARIO);

      const html = await thePage('?group=workflow');

      expect(html.match(/<tr class="detail" hidden>/g)).toHaveLength(1);
      expect(html).toContain('<table class="openable">');
    });

    it("a row's prompt names the workflow, its figures and its causes", async () => {
      await sendAttempts(SCENARIO);

      const { prompt } = workflowRows(await thePage('?group=workflow'))[0]!;

      expect(prompt).toContain('The &#34;CI&#34; GitHub Actions workflow in this repository is unstable.');
      expect(prompt).toContain('it passed 50% of its runs, with 2 failures, 1 of which passed on a later attempt of the same commit. On feature branches it failed and then passed on the same commit 1 time.');
      expect(prompt).toContain('- Test &#34;x&#34;');
      expect(prompt).toContain('1 flaky on feature branches');
    });

    it("the Workflow filter, or a workflow's name, opens that workflow's view with its tiles, runs per day, causes and every failure, main first", async () => {
      await sendAttempts([...SCENARIO, on(20, 1, '2026-10-30T09:00:00Z', 'pass', { workflow: 'Nightly' })]);

      const html = await thePage('?group=workflow&workflow=CI');
      const overview = await thePage('?group=workflow');

      expect(overview).toContain('href="/stability?workflow=CI&#38;group=workflow"');
      expect(hasSection(html, 'by-workflow')).toBe(false);
      for (const id of ['per-day', 'causes', 'every-failure']) expect(hasSection(html, id)).toBe(true);
      const said = text(html);
      for (const words of ['Pass rate on main', '50% 2 of 4 finished', 'Failed on main', '1 passed on a later attempt of the same commit', 'Flaky on feature branches', '1 commit', 'Top cause', '2 on main · 1 on feature branches']) expect(said).toContain(words);
      expect(rowsOf(html, 'causes').map((r) => r[0]!.split(' ')[0])).toEqual(['x', 'y']);
      const every = rowsOf(html, 'every-failure');
      expect(every.map((r) => [r[0]!.split(' ')[0], r[3]])).toEqual([
        ['main', 'passed on a later attempt'],
        ['main', 'stayed failed'],
        ['branch', 'passed on a later attempt'],
      ]);
      expect(every[0]![2]).toBe('x y');
    });

    it("a workflow's runs-per-day chart labels its gridlines 0 and 1, not a repeated 1, when its busiest day has one run", async () => {
      await sendAttempts([on(1, 1, '2026-10-30T10:00:00Z', 'pass')]);

      const ticks = [...(await thePage('?group=workflow&workflow=CI')).matchAll(/text-anchor="end" class="axis">(\d+)</g)].map((m) => m[1]);

      expect(ticks).toEqual(['0', '1']);
    });

    it('a Workflow filter naming a workflow with no attempt in the period draws its view with nothing in it', async () => {
      await sendAttempts(SCENARIO);

      const said = text(await thePage('?group=workflow&workflow=Nightly'));

      expect(said).toContain('Pass rate on main —');
      expect(said).toContain('No failure in this period.');
    });

    it('the period changed counts only the attempts in it', async () => {
      await sendAttempts([on(1, 1, '2026-10-20T10:00:00Z', 'fail', { ...sha('b') }), on(2, 1, '2026-10-30T10:00:00Z', 'pass')]);

      expect(workflowRows(await thePage('?group=workflow&period=7d'))[0]!.rate).toBe('100% 1 of 1');
      expect(workflowRows(await thePage('?group=workflow&period=30d'))[0]!.rate).toBe('50% 1 of 2');
      expect(workflowRows(await thePage('?group=workflow&period=30d'))[0]!.squares).toHaveLength(30);
    });

    it('everything held starts at the oldest attempt, and a period longer than the data says how much is stored', async () => {
      await sendAttempts([on(1, 1, '2026-10-20T10:00:00Z', 'fail'), on(2, 1, '2026-10-30T10:00:00Z', 'pass', { ...sha('b') })]);

      expect(workflowRows(await thePage('?group=workflow&period=all'))[0]!.squares).toHaveLength(12);
      expect(text(await thePage('?group=workflow&period=30d'))).toContain('Only 11 of the period s 30 days are stored so far.');
    });

    it('no attempt in the period says so', async () => {
      await sendAttempts([on(1, 1, '2026-09-20T10:00:00Z', 'fail')]);

      expect(text(await thePage('?group=workflow'))).toContain('Nothing in this period');
      expect(text(await thePage('?group=workflow&period=90d'))).not.toContain('Nothing in this period');
    });

    it('a workflow name, a test name and an error are drawn as text, never as markup', async () => {
      const name = '<img src=x onerror=alert(1)>';
      await sendAttempts([on(1, 1, '2026-10-30T10:00:00Z', 'fail', { workflow: name, failedJobs: [failedJob('Test', [failedTest('<script>alert(1)</script>', { error: '<b>boom</b>' })])] })]);

      for (const query of ['', `&workflow=${encodeURIComponent(name)}`]) {
        const html = await thePage(`?group=workflow${query}`);

        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<script>alert(1)');
        expect(html).not.toContain('<b>boom');
      }
    });
  });

  describe('red now reads the newest attempt on main of each workflow, on every tab', () => {
    const walks = { failedJobs: [failedJob('Test', [], { step: 'Run the E2E walks' })] };

    it.each([['job'], ['workflow'], ['tests']])('names a workflow whose newest attempt on main failed, since when, and the job and step that failed, on the %s tab', async (group) => {
      await sendAttempts([on(1, 1, '2026-10-30T09:00:00Z', 'pass'), on(2, 1, '2026-10-31T08:00:00Z', 'fail', walks)]);

      const html = await thePage(`?group=${group}`);

      expect(text(html)).toContain('CI is red now , since 31 Oct 2026, 09:00 (4h 00m): Test at Run the E2E walks failed.');
      expect(html).toContain('href="https://github.com/o/r/actions/runs/2"');
    });

    it('says since the first failure after the last pass, not the newest one', async () => {
      await sendAttempts([on(1, 1, '2026-10-29T09:00:00Z', 'pass'), on(2, 1, '2026-10-30T09:00:00Z', 'fail'), on(3, 1, '2026-10-31T08:00:00Z', 'fail', walks)]);

      expect(text(await thePage())).toContain('CI is red now , since 30 Oct 2026, 10:00 (27h 00m)');
    });

    it.each([
      { situation: 'a re-run of the failed attempt passed', attempts: [on(1, 1, '2026-10-31T08:00:00Z', 'fail'), on(1, 2, '2026-10-31T08:20:00Z', 'pass')] },
      { situation: 'a cancelled attempt came after the pass', attempts: [on(1, 1, '2026-10-31T08:00:00Z', 'pass'), on(2, 1, '2026-10-31T09:00:00Z', 'cancelled')] },
      { situation: 'it failed on a feature branch only', attempts: [on(1, 1, '2026-10-31T08:00:00Z', 'pass'), on(2, 1, '2026-10-31T09:00:00Z', 'fail', branch(5))] },
      { situation: 'nothing failed', attempts: [on(1, 1, '2026-10-31T08:00:00Z', 'pass')] },
    ])('is not there when $situation', async ({ attempts }) => {
      await sendAttempts(attempts);

      for (const group of ['job', 'workflow']) expect(text(await thePage(`?group=${group}`))).not.toContain('is red now');
    });

    it('still names a workflow red when a cancelled attempt followed its failure', async () => {
      await sendAttempts([on(1, 1, '2026-10-31T08:00:00Z', 'fail'), on(2, 1, '2026-10-31T09:00:00Z', 'cancelled')]);

      expect(text(await thePage())).toContain('CI is red now');
    });

    it('names each workflow that is red, whatever the Workflow filter holds', async () => {
      await sendAttempts([on(1, 1, '2026-10-31T08:00:00Z', 'fail', { workflow: 'Nightly' }), on(2, 1, '2026-10-31T09:00:00Z', 'fail', { workflow: 'CI' }), on(3, 1, '2026-10-31T09:00:00Z', 'pass', { workflow: 'Deploy' })]);

      const said = text(await thePage('?workflow=Deploy'));

      expect(said).toContain('CI is red now');
      expect(said).toContain('Nightly is red now');
      expect(said).not.toContain('Deploy is red now');
    });
  });

  describe('the Fragile tests tab lists each test that failed and then passed on the same commit, with its failures on main beside its flaky ones on branches', () => {
    const TRIAGE = ['apps/api/tests/integration/triage.test.ts', 'Triage > a dismissed item leaves the lists'] as const;
    const CAPTURE = ['tests/e2e/capture.test.ts', 'Capture > a thought is kept'] as const;
    /** The failed job of an attempt, naming `[file, name, project?]` tests, each attempt its own job link. */
    const broke = (runId: number, tests: readonly (readonly [string, string, string?])[], over: { job?: string; error?: string | null } = {}) => ({
      failedJobs: [
        failedJob(over.job ?? 'Test', tests.map(([file, name, project]) => failedTest(name, { file, project: project ?? null, ...(over.error === undefined ? {} : { error: over.error }) })), {
          step: 'Run pnpm test',
          url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
        }),
      ],
    });
    /**
     * Triage failed on main twice (the second passed on a re-run) and flaked on one pull request, whose other pull request's failure stayed failed;
     * Capture flaked on a third pull request, on phone and desktop in the one attempt.
     */
    const SCENARIO = [
      on(2, 1, '2026-10-30T10:00:00Z', 'fail', { ...sha('b'), ...broke(2, [TRIAGE]) }),
      on(3, 1, '2026-10-30T11:00:00Z', 'fail', { ...sha('c'), ...broke(3, [TRIAGE]) }),
      on(3, 2, '2026-10-30T11:30:00Z', 'pass', { ...sha('c') }),
      on(10, 1, '2026-10-29T10:00:00Z', 'fail', { ...branch(5), ...sha('d'), ...broke(10, [TRIAGE]) }),
      on(10, 2, '2026-10-29T10:30:00Z', 'pass', { ...branch(5), ...sha('d') }),
      on(11, 1, '2026-10-29T12:00:00Z', 'fail', { ...branch(6), ...sha('e'), ...broke(11, [TRIAGE]) }),
      on(12, 1, '2026-10-28T10:00:00Z', 'fail', { ...branch(7), ...sha('f'), ...broke(12, [[...CAPTURE, 'phone'], [...CAPTURE, 'desktop']], { job: 'E2E (F3)', error: 'Timeout 5000ms' }) }),
      on(12, 2, '2026-10-28T10:30:00Z', 'pass', { ...branch(7), ...sha('f') }),
    ];
    const unescaped = (cell: string) => cell.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    /** Each row of the tab: what its cells read, whether it is tagged a miss, its prompt and the strip it opens to. */
    const fragileRows = (html: string) =>
      [...panelOf(html, 'fragile').matchAll(/<tr data-opens="([^"]*)">(.*?)<\/tr><tr class="detail" hidden><td colspan="4">(.*?)<\/td><\/tr>/gs)].map(([, name, row, detail]) => {
        const cells = [...row!.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => c[1]!);
        return {
          name: unescaped(name!),
          test: plain(cells[0]!),
          failures: plain(cells[1]!),
          last: plain(cells[2]!),
          missed: cells[0]!.includes('>also a miss<'),
          prompt: unescaped(/<pre hidden>(.*?)<\/pre>/s.exec(cells[3]!)![1]!),
          detail: detail!,
        };
      });
    /** The runs a side of an opened row lists: whether a re-run passed, and where it ran. */
    const sideRuns = (detail: string, kind: 'main' | 'branch') =>
      [...(new RegExp(`<div class="side ${kind}">(.*?)</div>`, 's').exec(detail)?.[1] ?? '').matchAll(/<li><span class="n \w+">([^<]*)<\/span><span><a [^>]*>[^<]*<\/a><span class="of">([^<]*)<\/span>/g)].map(([, verdict, label]) => `${verdict} ${label}`);

    it('a row reads the test, the describe blocks above it and its latest error, one bar of its failures with the counts beside it, and its last flaky failure', async () => {
      await sendAttempts(SCENARIO);

      const [triage, capture, ...others] = fragileRows(await thePage('?group=tests'));

      expect(others).toEqual([]);
      expect([triage!.name, triage!.test, triage!.failures]).toEqual(['a dismissed item leaves the lists', 'a dismissed item leaves the lists Triage AssertionError: expected 1 to be 2', '3 2 on main · 1 on branches']);
      expect(triage!.last).toMatch(/^main 30 Oct 2026, 12:00$/);
      expect([capture!.name, capture!.test, capture!.failures]).toEqual(['a thought is kept', 'a thought is kept Capture Timeout 5000ms', '1 none on main · 1 on branches']);
      expect(capture!.last).toMatch(/^branch 28 Oct 2026, 11:00$/);
    });

    it('draws a failure on main in red and a flaky one on a branch in orange, in the one bar, each as wide as its share of the busiest test', async () => {
      await sendAttempts(SCENARIO);

      const bars = [...panelOf(await thePage('?group=tests'), 'fragile').matchAll(/<span class="track stacked"><span class="fill" style="width:([\d.]+)%"><\/span><span class="fill branch" style="width:([\d.]+)%"><\/span><\/span>/g)].map(([, main, branch]) => [main, branch]);

      expect(bars).toEqual([
        ['66.7', '33.3'],
        ['0.0', '33.3'],
      ]);
    });

    it('a failure on a branch that stayed failed is not counted, and a test that failed only on such commits is not listed', async () => {
      await sendAttempts([
        on(1, 1, '2026-10-30T10:00:00Z', 'fail', { ...branch(5), ...sha('a'), ...broke(1, [TRIAGE]) }),
        on(2, 1, '2026-10-30T11:00:00Z', 'pass', { ...branch(5), ...sha('b') }),
        on(3, 1, '2026-10-30T12:00:00Z', 'fail', { ...sha('c'), ...broke(3, [CAPTURE]) }),
      ]);

      const html = await thePage('?group=tests');

      expect(fragileRows(html)).toEqual([]);
      expect(text(html)).toContain('No test failed and then passed on the same commit in this period.');
    });

    it.each([
      { situation: 'Most on main puts the test with most failures on main first', query: '?group=tests', expected: ['a dismissed item leaves the lists', 'a thought is kept'] },
      { situation: 'Most in total counts the branches too', query: '?group=tests&sort=all', expected: ['a thought is kept', 'a dismissed item leaves the lists'] },
    ])('$situation', async ({ query, expected }) => {
      // Capture flaked on three more pull requests: four in total against Triage's three, and none of them on main.
      await sendAttempts([
        ...SCENARIO,
        on(20, 1, '2026-10-30T09:00:00Z', 'fail', { ...branch(8), ...sha('1'), ...broke(20, [CAPTURE]) }),
        on(20, 2, '2026-10-30T09:30:00Z', 'pass', { ...branch(8), ...sha('1') }),
        on(21, 1, '2026-10-30T09:40:00Z', 'fail', { ...branch(9), ...sha('2'), ...broke(21, [CAPTURE]) }),
        on(21, 2, '2026-10-30T09:50:00Z', 'pass', { ...branch(9), ...sha('2') }),
        on(22, 1, '2026-10-30T09:41:00Z', 'fail', { ...branch(10), ...sha('3'), ...broke(22, [CAPTURE]) }),
        on(22, 2, '2026-10-30T09:51:00Z', 'pass', { ...branch(10), ...sha('3') }),
      ]);

      const html = await thePage(query);

      expect(fragileRows(html).map((r) => r.name)).toEqual(expected);
      expect(text(panelOf(html, 'fragile'))).toContain(`2 tests · most failures ${query.includes('sort=all') ? 'in total' : 'on main'} first`);
      expect(theSentence(html).text).toBe(`Show CI for [each fragile test] [${query.includes('sort=all') ? 'most in total' : 'most on main'} first] over [the last 7 days]`);
    });

    it('a test whose file Test selection counts a miss is tagged also a miss, and one whose file it does not is not', async () => {
      await sendAttempts(SCENARIO);
      await sendSelection([selectionPull(7, { mergedAt: '2026-10-29T10:00:00Z', misses: [{ job: 'test', path: TRIAGE[0], level: 'integration', reason: null }] })]);

      const rows = fragileRows(await thePage('?group=tests'));

      expect(rows.map((r) => [r.name, r.missed])).toEqual([
        ['a dismissed item leaves the lists', true],
        ['a thought is kept', false],
      ]);
    });

    it('a miss on a pull request merged before the period tags nothing', async () => {
      await sendAttempts(SCENARIO);
      await sendSelection([selectionPull(7, { mergedAt: '2026-10-10T10:00:00Z', misses: [{ job: 'test', path: TRIAGE[0], level: 'integration', reason: null }] })]);

      expect(fragileRows(await thePage('?group=tests')).map((r) => r.missed)).toEqual([false, false]);
      expect(fragileRows(await thePage('?group=tests&period=30d')).map((r) => r.missed)).toEqual([true, false]);
    });

    it('the Workflow filter keeps only the tests that failed in that workflow, counting only its failures', async () => {
      await sendAttempts([
        ...SCENARIO,
        on(30, 1, '2026-10-30T09:00:00Z', 'fail', { workflow: 'Nightly', ...sha('4'), ...broke(30, [TRIAGE]) }),
        on(30, 2, '2026-10-30T09:30:00Z', 'pass', { workflow: 'Nightly', ...sha('4') }),
      ]);

      const nightlyPage = await thePage('?group=tests&workflow=Nightly');
      const nightly = fragileRows(nightlyPage);
      const ci = fragileRows(await thePage('?group=tests&workflow=CI'));
      const every = fragileRows(await thePage('?group=tests'));

      expect(nightly.map((r) => [r.name, r.failures])).toEqual([['a dismissed item leaves the lists', '1 1 on main · 0 on branches']]);
      expect(text(panelOf(nightlyPage, 'fragile'))).toContain('1 test · most failures on main first');
      expect(ci.map((r) => [r.name, r.failures])).toEqual([
        ['a dismissed item leaves the lists', '3 2 on main · 1 on branches'],
        ['a thought is kept', '1 none on main · 1 on branches'],
      ]);
      expect(every[0]!.failures).toBe('4 3 on main · 1 on branches');
    });

    it('a row opens to its newest runs on main beside its newest on branches, each saying whether a re-run passed, and names the file, projects and jobs', async () => {
      await sendAttempts(SCENARIO);

      const [triage, capture] = fragileRows(await thePage('?group=tests'));

      expect(plain(triage!.detail)).toContain('On main 2 failures · 1 passed on a re-run');
      expect(sideRuns(triage!.detail, 'main')).toEqual(['re-run passed main · CI', 'stayed failed main · CI']);
      expect(plain(triage!.detail)).toContain('On feature branches 1 failure a later attempt passed · 1 branch');
      expect(sideRuns(triage!.detail, 'branch')).toEqual(['re-run passed pull request 5 · CI']);
      expect(plain(triage!.detail)).toContain('apps/api/tests/integration/triage.test.ts · CI · Test');
      expect(plain(capture!.detail)).toContain('It has not failed on main in this period.');
      expect(plain(capture!.detail)).toContain('tests/e2e/capture.test.ts · phone, desktop · CI · E2E (F3)');
    });

    it("draws a row's strip in the page, hidden, for the opening script to show, and the script and the copy script once", async () => {
      await sendAttempts(SCENARIO);

      const html = await thePage('?group=tests');

      expect(html.match(/<tr class="detail" hidden>/g)).toHaveLength(2);
      expect(html).toContain('<table class="openable">');
      expect(html.match(/function toggle\(row\)/g)).toHaveLength(1);
      expect(html.match(/class="copy-prompt"/g)).toHaveLength(2);
    });

    it("a row's prompt names the test, its file and projects, its counts, its error and its runs, main first", async () => {
      await sendAttempts(SCENARIO);

      const [triage, capture] = fragileRows(await thePage('?group=tests'));

      expect(triage!.prompt.split('\n').slice(0, 7)).toEqual([
        'The test "Triage > a dismissed item leaves the lists" in apps/api/tests/integration/triage.test.ts is fragile in CI. It failed and then passed on the same commit 1 time on main and 1 time on feature branches, and failed on main without passing afterwards 1 time. It runs in CI · Test.',
        '',
        'Its latest error: AssertionError: expected 1 to be 2',
        '',
        'Failed runs, main first, newest first:',
        '- https://github.com/o/r/actions/runs/3/job/1 (main, passed on a later attempt)',
        '- https://github.com/o/r/actions/runs/2/job/1 (main, stayed failed)',
      ]);
      expect(triage!.prompt).toContain('- https://github.com/o/r/actions/runs/10/job/1 (feature branch, passed on a later attempt)');
      expect(capture!.prompt).toContain('The test "Capture > a thought is kept" in tests/e2e/capture.test.ts (Playwright projects: phone, desktop) is fragile in CI.');
    });

    it('the period changed counts only the attempts in it', async () => {
      await sendAttempts(SCENARIO);

      expect(fragileRows(await thePage('?group=tests&period=7d')).map((r) => r.failures)).toEqual(['3 2 on main · 1 on branches', '1 none on main · 1 on branches']);
      await sendAttempts([on(40, 1, '2026-10-10T10:00:00Z', 'fail', { ...sha('5'), ...broke(40, [CAPTURE]) }), on(40, 2, '2026-10-10T10:30:00Z', 'pass', { ...sha('5') })]);
      expect(fragileRows(await thePage('?group=tests&period=7d'))[1]!.failures).toBe('1 none on main · 1 on branches');
      expect(fragileRows(await thePage('?group=tests&period=30d'))[1]!.failures).toBe('2 1 on main · 1 on branches');
    });

    it('no attempt in the period says nothing is stored, and attempts with no flaky test say no test failed and then passed', async () => {
      await sendAttempts([on(1, 1, '2026-09-20T10:00:00Z', 'fail')]);
      expect(text(await thePage('?group=tests'))).toContain('Nothing in this period');

      await sendAttempts([on(2, 1, '2026-10-30T10:00:00Z', 'pass')]);
      expect(text(await thePage('?group=tests'))).toContain('No test failed and then passed on the same commit in this period.');
    });

    it('a test name, an error and a file are drawn as text, never as markup', async () => {
      const file = '<img src=x onerror=alert(1)>.test.ts';
      await sendAttempts([
        on(1, 1, '2026-10-30T10:00:00Z', 'fail', { ...sha('b'), failedJobs: [failedJob('Test', [failedTest('<script>alert(1)</script>', { file, error: '<b>boom</b>' })], { url: 'https://github.com/o/r/actions/runs/1/job/1' })] }),
        on(1, 2, '2026-10-30T10:30:00Z', 'pass', { ...sha('b') }),
      ]);
      await sendSelection([selectionPull(7, { mergedAt: '2026-10-30T10:00:00Z', misses: [{ job: 'test', path: file, level: 'unit', reason: null }] })]);

      const html = await thePage('?group=tests');

      expect(fragileRows(html)).toHaveLength(1);
      for (const markup of ['<img src=x', '<script>alert(1)', '<b>boom']) expect(html).not.toContain(markup);
    });
  });

  describe('the tabs that became the Workflow tab still answer, as the Workflow tab', () => {
    it.each([['red'], ['failures'], ['day']])('an address naming %s opens the Workflow tab', async (group) => {
      await sendAttempts([on(1, 1, '2026-10-30T10:00:00Z', 'fail')]);

      const html = await thePage(`?group=${group}`);

      expect(hasSection(html, 'by-workflow')).toBe(true);
      expect(theSentence(html).text).toBe('Show CI for [each workflow] [least reliable first] over [the last 7 days]');
    });
  });
});
