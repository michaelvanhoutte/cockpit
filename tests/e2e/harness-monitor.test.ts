import { readFile } from 'node:fs/promises';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test } from './support/app';

/**
 * F3, because the sentence's words are selects that submit when changed, and the
 * band only stays on screen while a page scrolls in a browser. What each
 * grouping sums, and what each filter and colouring keeps, is
 * apps/harness-monitor/tests/integration/costs-grouping.test.ts,
 * costs-filters.test.ts, costs-split.test.ts, costs-engineer-colouring.test.ts
 * and costs-sentence.test.ts; a pull request's page and the CSV are
 * pull-request-page.test.ts and csv-export.test.ts. This proves the page those
 * figures sit on is reachable, laid out, pinned and switchable, on a phone
 * too, and drawn in Cockpit's look
 * (apps/harness-monitor/tests/integration/cockpit-look.test.ts holds its markup).
 * Cockpit's Claude calls page is cockpit-claude-calls-page.test.ts; this finds it from
 * the costs page and reads it on both devices.
 *
 * The Harness Monitor is its own Worker with its own database, on its own port
 * (scripts/e2e-stack.mjs), seeded through the suite-only route of
 * apps/harness-monitor/tests/e2e-worker.ts.
 */
const monitor = process.env.E2E_HARNESS_MONITOR_URL;

/** Today, so the seeded requests are inside the page's default last 30 days. */
const at = new Date(Date.now() - 60_000).toISOString();

const SONNET = 'claude-sonnet-5';
const OPUS = 'claude-opus-4-8';
/** Tokens that cost a dollar at the seeded rates: $2 per million input tokens on Sonnet, $5 on Opus. */
const PER_DOLLAR = { [SONNET]: 500_000, [OPUS]: 200_000 };

/** A request costing exactly `dollars` on a model. */
const request = (id: string, branch: string, category: string, dollars: number, subagent: Record<string, unknown> | null = null, model: keyof typeof PER_DOLLAR = SONNET) => ({
  requestId: `e2e-${id}`,
  sessionId: `e2e-session-${branch}`,
  time: at,
  branch,
  category,
  model,
  speed: 'standard',
  inputTokens: dollars * PER_DOLLAR[model],
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  subagent: subagent !== null,
  ...subagent,
  ranWhere: 'local',
  source: 'hook',
});

/** A Claude call as Cockpit's production sends it, row-numbered so the import copies each once. */
const call = (id: number, over: Record<string, unknown>) => ({
  id,
  at,
  environment: 'production',
  feature: 'clean-up-a-note',
  promptVersion: 'v1',
  startedBy: 'captured-in-app',
  model: 'claude-sonnet-5',
  outcome: 'ok',
  tokensIn: 100,
  cacheRead: 0,
  cacheWrite: 0,
  tokensOut: 20,
  costUsd: 1,
  pullRequest: null,
  runId: null,
  branch: null,
  ...over,
});

const SEED = {
  calls: [
    call(9_001, {}),
    // Two contract runs on one pull request, one on another, and a nightly run on main.
    call(9_002, { environment: 'ci', startedBy: 'contract-run', pullRequest: 9001, runId: 7_001, costUsd: 0.5 }),
    call(9_003, { environment: 'ci', startedBy: 'contract-run', pullRequest: 9001, runId: 7_002, costUsd: 0.25 }),
    call(9_004, { environment: 'ci', startedBy: 'contract-run', pullRequest: 9002, runId: 7_003, costUsd: 0.75 }),
    call(9_005, { environment: 'ci', startedBy: 'contract-run', runId: 7_004, costUsd: 0.1 }),
  ],
  rows: [
    request('1', 'claude/e2e-filter-panel', 'building', 4),
    request('2', 'claude/e2e-filter-panel', 'after-push', 2),
    request('3', 'claude/e2e-teams-message', 'building', 1),
    request('4', 'claude/e2e-teams-message', 'ci-reviews', 1),
    // The only Opus request, so a model filter has something to keep and something to leave out.
    request('7', 'claude/e2e-teams-message', 'building', 1, null, OPUS),
    // Free, so no total moves: they are here to be drawn beneath the session's main agent.
    request('5', 'claude/e2e-filter-panel', 'building', 0, { subagentType: 'Explore', subagentId: 'e2e-explore-1' }),
    request('6', 'claude/e2e-filter-panel', 'building', 0, {}),
  ],
  pullRequests: [
    { branch: 'claude/e2e-filter-panel', number: 9001, title: 'Add a filter panel', state: 'MERGED', mergedAt: '2026-01-02T10:00:00Z', issue: 9000, engineer: 'e2e-alice', size: { added: 120, removed: 30, openedAt: '2026-01-01T10:00:00Z', ciRounds: 2, issueTitle: 'Filter the inbox' } },
    { branch: 'claude/e2e-teams-message', number: 9002, title: 'Save a Teams message', state: 'OPEN', mergedAt: null, issue: null, engineer: 'e2e-bob' },
  ],
};

test.describe('Harness Monitor', () => {
  /** A word of the band's sentence, or one of the filters under "Only", by what a screen reader calls it. */
  const choice = (page: Page, name: string) => page.getByRole('combobox', { name, exact: true });
  /** Chooses an option and waits for the page it submits to. */
  const choose = async (page: Page, name: string, option: string, address: RegExp) => {
    await choice(page, name).selectOption({ label: option });
    await expect(page).toHaveURL(address);
  };

  test('the costs page opens on each day, is regrouped and recoloured by the sentence with its filters kept, opens one pull request through Sessions and exports it', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const seeded = await api.post(`${monitor}/__e2e/seed`, { data: SEED });
    expect(seeded.ok()).toBe(true);

    await page.goto(`${monitor}/`);

    // The bare address reads each day, coloured by phase, over the last 30 days; both charts are drawn and the table's own column reads Day.
    await expect(choice(page, 'Rows')).toHaveValue('day');
    await expect(choice(page, 'Colours')).toHaveValue('phase');
    await expect(choice(page, 'Period')).toHaveValue('30d');
    await expect(page.getByRole('img', { name: /^Cost per day/ })).toBeVisible();
    await expect(page.getByRole('img', { name: /^Tokens per day/ })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Cost by day' }).getByRole('columnheader', { name: 'Day' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Where the period.s \$9\.00 went, by phase/ })).toBeVisible();
    // The change card is gone.
    await expect(page.getByRole('region', { name: 'Change on the previous period' })).toHaveCount(0);

    // Coloured by model: the bar, both charts and the day's bar hover are by model, and the address carries it.
    await choose(page, 'Colours', 'model', /[?&]split=model(&|$)/);
    await expect(page.getByRole('heading', { name: /Where the period.s \$9\.00 went, by model/ })).toBeVisible();
    await expect(page.getByRole('img', { name: `${SONNET} $8.00, ${OPUS} $1.00` })).toBeVisible();
    await expect(page.getByRole('img', { name: new RegExp(`^Cost per day.*${SONNET}, ${OPUS}`) })).toBeVisible();
    await expect(page.getByRole('img', { name: new RegExp(`^Tokens per day.*${SONNET}, ${OPUS}`) })).toBeVisible();
    const day = page.getByRole('region', { name: 'Cost by day' }).locator('td.split-cell').first();
    await expect(day).toHaveAttribute('title', `${SONNET} $8.00 · ${OPUS} $1.00`);

    // Coloured by engineer is not offered for each engineer, which already is one.
    await choose(page, 'Rows', 'each engineer', /[?&]group=engineer(&|$)/);
    await expect(choice(page, 'Colours').locator('option[value="engineer"]')).toBeDisabled();

    // Only Opus, then each pull request: the rows are pull requests and the model filter is kept.
    await choose(page, 'Rows', 'each pull request', /[?&]group=pr(&|$)/);
    // Ordering by total is kept by the sentence's other choices, but other rows start in their own order.
    await page.getByRole('region', { name: 'Cost by pull request' }).getByRole('link', { name: 'Total', exact: true }).click();
    await expect(page).toHaveURL(/[?&]sort=total(&|$)/);
    await choose(page, 'Rows', 'each issue', /[?&]group=issue(&|$)/);
    expect(new URL(page.url()).searchParams.has('sort')).toBe(false);
    await choose(page, 'Rows', 'each pull request', /[?&]group=pr(&|$)/);
    await choose(page, 'Model', OPUS, /[?&]model=claude-opus-4-8(&|$)/);
    const table = page.getByRole('region', { name: 'Cost by pull request' });
    await expect(table.getByRole('row', { name: /#9002 Save a Teams message/ })).toContainText('$1.00');
    await expect(table.getByRole('row', { name: /#9001/ })).toHaveCount(0);
    await expect(choice(page, 'Model')).toHaveValue(OPUS);
    await expect(choice(page, 'Rows')).toHaveValue('pr');
    // A pull request's table has no column per colour, nor the review columns.
    await expect(table.getByRole('columnheader', { name: 'Coloured by model' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Rounds' })).toHaveCount(0);

    // Every model again: both pull requests, the bar's hover naming each model's dollars.
    await choose(page, 'Model', 'All models', /[?&]model=(&|$)/);
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ })).toContainText('$6.00');
    await expect(table.getByRole('row', { name: /#9002 Save a Teams message/ })).toContainText('$3.00');
    await expect(table.getByRole('row', { name: /#9002 Save a Teams message/ }).locator('td.split-cell')).toHaveAttribute('title', `${SONNET} $2.00 · ${OPUS} $1.00`);
    // What linking read of a pull request: its lines.
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ })).toContainText('+120 −30');
    await expect(page.getByText('at API list price')).toBeVisible();
    // The page fits the screen; only the table scrolls inside its own box.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Open one pull request from the table: its total, categories and sessions.
    // The title opens GitHub in a new tab; Sessions opens the monitor's own page.
    await expect(table.getByRole('link', { name: /#9001 Add a filter panel/ })).toHaveAttribute('target', '_blank');
    await table.getByRole('row', { name: /#9001 Add a filter panel/ }).getByRole('link', { name: 'Sessions' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /#9001 Add a filter panel/ })).toBeVisible();
    await expect(page.locator('#pr-total')).toHaveText('$6.00');
    const byCategory = page.getByRole('region', { name: 'By category' });
    await expect(byCategory).toContainText('Building');
    await expect(byCategory).toContainText('$4.00');
    await expect(byCategory).toContainText('app reviews not measured');
    const sessions = page.getByRole('region', { name: 'Sessions' });
    await expect(sessions.getByRole('row', { name: /e2e-session-claude\/e2e-filter-panel/ })).toContainText('Local');
    await expect(sessions.getByRole('row', { name: /e2e-session-claude\/e2e-filter-panel/ })).toContainText('$6.00');
    // The session's subagents sit indented beneath its main agent, each by type or as not recorded.
    const subagents = sessions.locator('tr[data-agent="subagent"]');
    await expect(subagents).toHaveCount(2);
    await expect(subagents.filter({ hasText: 'Explore' })).toContainText('e2e-explore-1');
    await expect(subagents.filter({ hasText: 'type not recorded' })).toHaveCount(1);
    const indent = (row: ReturnType<typeof subagents.first>) => row.locator('td').first().evaluate((td) => parseFloat(getComputedStyle(td).paddingLeft));
    expect(await indent(subagents.first())).toBeGreaterThan(await indent(sessions.locator('tr[data-agent="main"]').first()));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Narrow to a category, then export: the file holds exactly that page's requests.
    await page.getByLabel('Category', { exact: true }).selectOption('after-push');
    await expect(page.locator('#pr-total')).toHaveText('$2.00');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
    expect(download.suggestedFilename()).toBe('claude-code-pull-request-9001.csv');
    const csv = (await readFile((await download.path())!, 'utf8')).trimEnd().split('\r\n');
    expect(csv[0]).toMatch(/^time,session,branch,pull_request,issue,engineer,category,model,/);
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain(',claude/e2e-filter-panel,9001,9000,e2e-alice,after-push,');

    // Back to the costs page, each engineer, narrowed to one phase: the table and the bar both narrow, and the sentence is kept.
    await page.getByRole('link', { name: 'All costs' }).click();
    await choose(page, 'Rows', 'each engineer', /[?&]group=engineer(&|$)/);
    const byEngineer = page.getByRole('region', { name: 'Cost by engineer' });
    await expect(byEngineer.getByRole('row', { name: /e2e-alice/ })).toContainText('$6.00');
    await expect(byEngineer.getByRole('row', { name: /e2e-bob/ })).toContainText('$3.00');
    await choose(page, 'Phase', 'After push', /[?&]category=after-push(&|$)/);
    await expect(page.getByRole('heading', { name: /Where the period.s \$2\.00 went, by phase/ })).toBeVisible();
    await expect(byEngineer.getByRole('row', { name: /e2e-alice/ })).toContainText('$2.00');
    await expect(byEngineer.getByRole('row', { name: /e2e-bob/ })).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'After push $2.00' })).toBeVisible();
    await expect(choice(page, 'Rows')).toHaveValue('engineer');
  });

  test('the sentence stays on screen as the page scrolls, on a desk and on a phone', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    expect((await api.post(`${monitor}/__e2e/seed`, { data: SEED })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    await page.goto(`${monitor}/`);

    // Scrolled to the table, the band is still the first thing on screen.
    await page.getByRole('region', { name: 'Cost by day' }).scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const band = page.locator('.band-controls');
    expect(Math.round((await band.boundingBox())!.y)).toBe(0);
    const rowsOf = (selector: string) => page.locator(selector).evaluateAll((all) => [...new Set(all.map((e) => Math.round(e.getBoundingClientRect().top)))].length);
    const inView = (selector: string) => page.locator(selector).evaluateAll((all) => all.every((e) => e.getBoundingClientRect().bottom <= window.innerHeight && e.getBoundingClientRect().top >= 0));
    expect(await inView('.sentence select')).toBe(true);
    expect(await inView('.only select')).toBe(true);

    // The sentence is one row of words on a desk and wraps on a phone; Only's filters are one row on a desk and two to a row on a phone.
    const filters = await page.locator('.only select').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    const perRow = [...new Set(filters)].map((top) => filters.filter((t) => t === top).length);
    expect(filters).toHaveLength(4);
    if (onAPhone) {
      expect(await rowsOf('.sentence select')).toBeGreaterThan(1);
      expect(Math.max(...perRow)).toBe(2);
      // Two to a row means two equal columns across the band, not two that happen to fit.
      const right = await page.locator('.only select').nth(1).evaluate((el) => Math.round(el.getBoundingClientRect().right));
      expect(right).toBe(await page.evaluate(() => document.documentElement.clientWidth - 12));
    } else {
      expect(await rowsOf('.sentence select')).toBe(1);
      expect(perRow).toEqual([4]);
      // The band is the two lines of the sentence and Only, one under the other.
      const tops = await page.evaluate(() => [document.querySelector('.sentence select')!, document.querySelector('.only select')!].map((e) => e.getBoundingClientRect().top));
      expect(tops[1]).toBeGreaterThan(tops[0]!);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('on a dark device, choosing Light draws every page light at once and from the first frame after a reload, until Match device puts it back, with the choice in the top bar', async ({ page }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    // Cockpit's warm grey ground and its field, in each appearance.
    const LIGHT = ['rgb(226, 226, 223)', 'rgb(255, 255, 255)'];
    const DARK = ['rgb(35, 36, 42)', 'rgb(20, 21, 25)'];
    const colours = () => page.evaluate(() => [document.body, document.querySelector('#appearance')!].map((e) => getComputedStyle(e).backgroundColor));
    const appearance = page.getByRole('combobox', { name: 'Appearance', exact: true });
    // Where on the page the choice was first drawn: still in the head means before anything below it was.
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if (Reflect.get(window, 'appearanceDrawnIn') === undefined && document.documentElement.hasAttribute('data-appearance')) Reflect.set(window, 'appearanceDrawnIn', document.body === null ? 'head' : 'body');
      }).observe(document, { attributes: true, subtree: true });
    });
    const drawnIn = () => page.evaluate(() => Reflect.get(window, 'appearanceDrawnIn'));

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${monitor}/`);

    // Nothing chosen: the device's dark, with Match device showing.
    expect(await colours()).toEqual(DARK);
    await expect(appearance).toHaveValue('');
    expect(await drawnIn()).toBeUndefined();

    // The select sits at the right of the top bar: after the status on a desk, on the brand row on a phone where the status is hidden and the current tab still runs into the band.
    const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
    const [select, brand, status, tabs, tab, band] = await Promise.all([box('#appearance'), box('.brand'), box('.status'), box('.pages'), box('.pages a[aria-current=page]'), box('.band')]);
    const right = await page.evaluate(() => document.documentElement.clientWidth);
    if (onAPhone) {
      expect(select.y + select.height / 2).toBeGreaterThan(brand.y);
      expect(select.y + select.height / 2).toBeLessThan(brand.y + brand.height);
      expect(select.x).toBeGreaterThan(brand.x + brand.width);
      expect(Math.round(select.x + select.width)).toBe(right - 12);
      expect(tabs.y).toBeGreaterThanOrEqual(brand.y + brand.height - 1);
      expect(Math.abs(tab.y + tab.height - band.y)).toBeLessThan(1.5);
    } else {
      expect(select.x).toBeGreaterThan(status.x + status.width);
      expect(Math.round(select.x + select.width)).toBe(right - 20);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Light chosen: light at once, on the page already open.
    await page.evaluate(() => Reflect.set(window, 'thisPage', true));
    await appearance.selectOption({ label: 'Light' });
    expect(await colours()).toEqual(LIGHT);
    await expect(appearance).toHaveValue('light');
    expect(await page.evaluate(() => Reflect.get(window, 'thisPage'))).toBe(true);
    // The rest does not differ with the width, so a phone's walk ends here.
    if (onAPhone) return;

    // Another page, then a reload: light before anything below the head was drawn, and the select showing Light.
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Cycle time' }).click();
    await expect(page).toHaveURL(/\/cycle-time/);
    expect(await colours()).toEqual(LIGHT);
    await expect(appearance).toHaveValue('light');
    await page.reload();
    expect(await colours()).toEqual(LIGHT);
    await expect(appearance).toHaveValue('light');
    expect(await drawnIn()).toBe('head');

    // Match device: dark again, and remembered as nothing.
    await appearance.selectOption({ label: 'Match device' });
    expect(await colours()).toEqual(DARK);
    await page.reload();
    expect(await colours()).toEqual(DARK);
    await expect(appearance).toHaveValue('');
  });

  /**
   * CI's attempts on every branch, as the Job, Workflow and Fragile tests tabs and the red-now line read them (main's keep their jobs and steps, a branch's none): CI failed on main once at a test and a re-run was green, a pull request's
   * attempt failed at another test and passed on a re-run, another pull request's failed and stayed failed, and Nightly's only run on main is red.
   */
  async function seedCiAttempts(api: APIRequestContext) {
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString(); // clock-ok: the page reads the Worker's own clock, which the walk cannot inject
    const attempt = (runId: number, number: number, workflow: string, hours: number, failed: { job: string; step: string; tests: { file: string; name: string; project: string | null }[] } | null, over: Record<string, unknown> = {}) => ({
      runId,
      attempt: number,
      workflow,
      path: `.github/workflows/${workflow.toLowerCase()}.yml`,
      event: 'push',
      branch: 'main',
      pullRequest: null,
      onMain: true,
      headSha: String(runId).padEnd(40, 'c'),
      status: 'completed',
      conclusion: failed ? 'failure' : 'success',
      outcome: failed ? 'fail' : 'pass',
      createdAt: hoursAgo(hours),
      url: `https://github.com/o/r/actions/runs/${runId}${number > 1 ? `/attempts/${number}` : ''}`,
      jobs: [
        {
          name: failed?.job ?? 'Test',
          status: 'completed',
          conclusion: failed ? 'failure' : 'success',
          outcome: failed ? 'fail' : 'pass',
          startedAt: hoursAgo(hours),
          completedAt: hoursAgo(hours),
          durationMs: 120_000,
          failedStep: failed?.step ?? null,
          url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
          steps: [{ number: 1, name: failed?.step ?? 'Run the tests', occurrence: 1, conclusion: failed ? 'failure' : 'success', startedAt: hoursAgo(hours), completedAt: hoursAgo(hours), durationMs: 60_000 }],
        },
      ],
      failedJobs: failed ? [{ name: failed.job, step: failed.step, url: `https://github.com/o/r/actions/runs/${runId}/job/1`, testsMore: 0, tests: failed.tests.map((t) => ({ ...t, error: 'AssertionError: expected 1 to be 2' })) }] : [],
      ...over,
    });
    const triage = { file: 'apps/api/tests/integration/triage.test.ts', name: 'Triage > a dismissed item leaves the lists', project: null };
    const capture = { file: 'tests/e2e/capture.test.ts', name: 'Capture > a thought is kept', project: 'phone' };
    const onPull = (pull: number) => ({ onMain: false, event: 'pull_request', branch: `claude/${pull}-change`, pullRequest: pull, jobs: [] });
    const attempts = [
      attempt(9_002_001, 1, 'CI', 50, null),
      attempt(9_002_002, 1, 'CI', 40, { job: 'Test', step: 'Run the tests', tests: [triage] }),
      attempt(9_002_002, 2, 'CI', 39, null),
      attempt(9_002_003, 1, 'CI', 30, null),
      attempt(9_002_010, 1, 'CI', 20, { job: 'E2E (F3)', step: 'Run pnpm test:e2e', tests: [capture] }, onPull(9_101)),
      attempt(9_002_010, 2, 'CI', 19, null, onPull(9_101)),
      attempt(9_002_011, 1, 'CI', 10, { job: 'Test', step: 'Run the tests', tests: [triage] }, { ...onPull(9_102), headSha: 'e'.repeat(40) }),
      attempt(9_002_020, 1, 'Nightly', 5, { job: 'Test explorer', step: 'Build the snapshot', tests: [] }, { event: 'schedule' }),
    ];
    expect((await api.post(`${monitor}/__e2e/seed-ci-attempts`, { data: { attempts } })).ok()).toBe(true);
  }

  test('CI stability opens from the top bar, its sentence and the Workflow filter narrow it, choosing each workflow lists every workflow in its own order and a Workflow filter opens that workflow, Open in Actions follows the filter on a desk, and a phone scrolls the wide tables inside their panels', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCiAttempts(api);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    // From the costs page, the top bar's own tab opens it on each job, with the tiles an overview has.
    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'CI stability' }).click();
    await expect(page.getByText('Show CI for')).toBeVisible();
    await expect(choice(page, 'Rows')).toHaveValue('job');
    await expect(choice(page, 'Order')).toHaveValue('worst');
    await expect(choice(page, 'Period')).toHaveValue('7d');
    await expect(page.getByRole('region', { name: 'How every job run ended' })).toBeVisible();
    // While Nightly is red, the line says so on this tab and on the next.
    await expect(page.getByRole('status').filter({ hasText: 'Nightly is red now' })).toContainText('Build the snapshot');

    // On a desk Open in Actions follows the Workflow filter on the band's Only row; the page never scrolls sideways, and the wide table scrolls inside its panel.
    await expect(page.locator('.only select')).toHaveCount(1);
    const actions = page.locator('.only').getByRole('link', { name: 'Open in Actions' });
    const [filter, link] = await Promise.all([choice(page, 'Workflow').boundingBox(), actions.boundingBox()]);
    if (!onAPhone) {
      expect(Math.abs(link!.y - filter!.y)).toBeLessThan(8);
      expect(link!.x).toBeGreaterThan(filter!.x + filter!.width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const byJob = page.getByRole('region', { name: 'By job' }).locator('.table');
    expect(await byJob.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(onAPhone);

    // Each workflow lists both workflows, with the red line above them and a Workflow filter to open one; choosing CI there opens CI's own view and leaves only its failure.
    await choose(page, 'Rows', 'each workflow', /[?&]group=workflow(&|$)/);
    await expect(choice(page, 'Order')).toHaveValue('worst');
    await expect(page.getByRole('status').filter({ hasText: 'Nightly is red now' })).toBeVisible();
    const workflows = page.getByRole('region', { name: 'By workflow' });
    await expect(workflows.getByRole('row')).toHaveCount(3);
    await choose(page, 'Workflow', 'CI', /[?&]workflow=CI(&|$)/);
    await expect(page).toHaveURL(/[?&]group=workflow(&|$)/);
    const everyFailure = page.getByRole('region', { name: 'Every failure' });
    await expect(everyFailure.getByRole('row')).toHaveCount(3);
    await expect(everyFailure).toContainText('Run the tests');
    await expect(everyFailure).not.toContainText('Build the snapshot');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Each job, slowest first, with the Workflow filter still CI; then each workflow starts in its own order and keeps the filter, so it is still CI's view.
    await choose(page, 'Rows', 'each job', /[?&]group=job(&|$)/);
    await choose(page, 'Order', 'slowest first', /[?&]sort=slowest(&|$)/);
    await expect(page).toHaveURL(/[?&]workflow=CI(&|$)/);
    await choose(page, 'Rows', 'each workflow', /[?&]group=workflow(&|$)/);
    expect(new URL(page.url()).searchParams.has('sort')).toBe(false);
    await expect(choice(page, 'Order')).toHaveValue('worst');
    await expect(choice(page, 'Workflow')).toHaveValue('CI');
    await expect(page.getByRole('region', { name: 'Every failure' })).toBeVisible();
    await choose(page, 'Workflow', 'All workflows', /[?&]workflow=(&|$)/);
    await expect(workflows.getByRole('row')).toHaveCount(3);
    await expect(workflows).toContainText('Nightly');
  });

  test("a CI stability job row opens to main beside its feature branches from its chevron or anywhere on it outside its links, and closes with a second click, with no request, while its name still opens its steps, fitting a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCiAttempts(api);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.goto(`${monitor}/stability`);
    await page.waitForLoadState('load');
    const table = page.getByRole('region', { name: 'By job' });
    const row = (name: string) => table.locator(`tr[data-opens^="${name} in "]`);
    const stripOf = (name: string) => row(name).locator('xpath=following-sibling::tr[1][contains(@class, "detail")]');
    const opening = (name: string) => row(name).getByRole('button', { name: new RegExp(`^(Open|Close) ${name.replace(/[()]/g, '\\$&')} in CI$`) });
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));

    // Ranked by main: Test explorer, red on its only run, then Test, then the job that only flaked on a pull request, and every strip is in the page and closed.
    await expect(table.locator('tr[data-opens] td.first')).toHaveText([/^›Test explorerNightly/, /^›TestCI/, /^›E2E \(F3\)CI$/]);
    // The job with nothing on main has no steps to open, so its name is not a link.
    await expect(table.locator('tr[data-opens] td.first a')).toHaveText(['Test explorer', 'Test']);
    await expect(table.locator('tr.detail')).toHaveCount(3);
    await expect(table.locator('tr.detail').first()).toBeHidden();
    await expect(opening('Test')).toHaveAttribute('aria-expanded', 'false');

    // The chevron opens the strip beneath its row: Test's failure on main beside the branches' sentence, side by side on a desk and above one another on a phone.
    await opening('Test').click();
    await expect(opening('Test')).toHaveAttribute('aria-expanded', 'true');
    await expect(row('Test')).toHaveClass(/\bopen\b/);
    await expect(stripOf('Test')).toBeVisible();
    await expect(stripOf('Test explorer')).toBeHidden();
    const main = stripOf('Test').locator('.side.main');
    const branches = stripOf('Test').locator('.side.branch');
    await expect(main.locator('h4')).toHaveText('On main');
    await expect(branches.locator('h4')).toHaveText('On feature branches');
    await expect(main.locator('li')).toHaveText([/1\s*a dismissed item leaves the lists/]);
    await expect(branches).toContainText('This job did not fail and then pass on a feature branch.');
    const [m, b] = await Promise.all([main.boundingBox(), branches.boundingBox()]);
    if (onAPhone) expect(b!.y).toBeGreaterThan(m!.y + m!.height - 1);
    else {
      expect(Math.abs(b!.y - m!.y)).toBeLessThan(4);
      expect(b!.x).toBeGreaterThan(m!.x + m!.width - 1);
    }
    expect(await noSideways()).toBe(true);

    // Anywhere else on the row closes it, and the same again opens it.
    await row('Test').locator('td').nth(2).click();
    await expect(stripOf('Test')).toBeHidden();
    await expect(opening('Test')).toHaveAttribute('aria-expanded', 'false');
    await row('Test').locator('td').nth(2).click();
    await expect(stripOf('Test')).toBeVisible();

    // The job that only flaked on a pull request has nothing on main and its flake beside it.
    await opening('E2E (F3)').click();
    await expect(stripOf('E2E (F3)').locator('.side.main')).toContainText('No finished run on main in this period.');
    await expect(stripOf('E2E (F3)').locator('.side.branch li')).toHaveText([/1\s*a thought is kept/]);

    // Nothing above sent a request: the strips were in the page.
    expect(requests).toEqual([]);

    // The name still opens the steps, which are main's, and the table's rows stay.
    await row('Test').getByRole('link', { name: 'Test', exact: true }).click();
    await expect(page).toHaveURL(/[?&]steps=CI%7CTest(&|$)/);
    const steps = page.getByRole('region', { name: /^Where Test.s time goes/ });
    await expect(steps).toContainText('on main');
    await expect(steps.locator('.step-name')).toHaveText(['Run the tests']);
    await expect(table.locator('tr[data-opens]')).toHaveCount(3);
    expect(await noSideways()).toBe(true);
  });

  test("a CI stability workflow row opens to main beside its feature branches from its chevron or anywhere on it outside its links, and closes with a second click, with no request; its name opens the workflow's own view, and Copy prompt puts its prompt on the clipboard without opening it, fitting a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCiAttempts(api);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(monitor!).origin });
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.goto(`${monitor}/stability?group=workflow`);
    await page.waitForLoadState('load');
    const table = page.getByRole('region', { name: 'By workflow' });
    const row = (name: string) => table.locator('tr[data-opens]', { has: page.getByRole('link', { name, exact: true }) });
    const stripOf = (name: string) => row(name).locator('xpath=following-sibling::tr[1][contains(@class, "detail")]');
    const opening = (name: string) => row(name).getByRole('button', { name: new RegExp(`^(Open|Close) ${name}$`) });
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));

    // Ranked by main: Nightly, red on its only run, before CI, and every strip is in the page and closed.
    await expect(table.locator('tr[data-opens] td.first a')).toHaveText(['Nightly', 'CI']);
    await expect(table.locator('tr.detail')).toHaveCount(2);
    await expect(table.locator('tr.detail').first()).toBeHidden();
    await expect(opening('CI')).toHaveAttribute('aria-expanded', 'false');

    // The chevron opens the strip beneath its row, main beside the feature branches on a desk and above them on a phone.
    await opening('CI').click();
    await expect(opening('CI')).toHaveAttribute('aria-expanded', 'true');
    await expect(opening('CI')).toHaveAccessibleName('Close CI');
    await expect(row('CI')).toHaveClass(/\bopen\b/);
    await expect(stripOf('CI')).toBeVisible();
    await expect(stripOf('Nightly')).toBeHidden();
    const main = stripOf('CI').locator('.side.main');
    const branches = stripOf('CI').locator('.side.branch');
    await expect(main.locator('h4')).toHaveText('On main');
    await expect(branches.locator('h4')).toHaveText('On feature branches');
    await expect(main.locator('li')).toHaveText([/1\s*a dismissed item leaves the lists/]);
    await expect(branches.locator('li')).toHaveText([/1\s*a thought is kept/]);
    const [m, b] = await Promise.all([main.boundingBox(), branches.boundingBox()]);
    if (onAPhone) expect(b!.y).toBeGreaterThan(m!.y + m!.height - 1);
    else {
      expect(Math.abs(b!.y - m!.y)).toBeLessThan(4);
      expect(b!.x).toBeGreaterThan(m!.x + m!.width - 1);
    }
    if (onAPhone) {
      // On a phone the strip stays inside the panel's width while the wide table scrolls beneath it.
      const [strip, panel] = await Promise.all([stripOf('CI').locator('.strip').boundingBox(), table.locator('.well.table').boundingBox()]);
      expect(strip!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(strip!.x + strip!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
    }
    expect(await noSideways()).toBe(true);

    // Anywhere else on the row closes it, and the same again opens it.
    await row('CI').locator('td').nth(1).click();
    await expect(stripOf('CI')).toBeHidden();
    await expect(opening('CI')).toHaveAttribute('aria-expanded', 'false');
    await expect(row('CI')).not.toHaveClass(/\bopen\b/);
    await row('CI').locator('td').nth(1).click();
    await expect(stripOf('CI')).toBeVisible();

    // Copy prompt copies this row's prompt, says so for a moment, and neither opens nor closes the row it sits in.
    await row('Nightly').getByRole('button', { name: 'Copy prompt' }).click();
    await expect(row('Nightly').locator('.copy-prompt')).toHaveText('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('The "Nightly" GitHub Actions workflow in this repository is unstable.');
    expect(copied).toContain('it passed 0% of its runs, with 1 failure, 0 of which passed on a later attempt of the same commit.');
    expect(copied).toContain('- Test explorer · Build the snapshot: 1 failure on main, 0 flaky on feature branches');
    expect(copied).not.toContain('a dismissed item leaves the lists');
    await expect(opening('Nightly')).toHaveAttribute('aria-expanded', 'false');
    await expect(stripOf('Nightly')).toBeHidden();
    await expect(row('Nightly').getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    await row('CI').getByRole('button', { name: 'Copy prompt' }).click();
    const copiedCi = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedCi).toContain('Test "Triage > a dismissed item leaves the lists" (apps/api/tests/integration/triage.test.ts · Test): 1 failure on main');
    expect(copiedCi).toContain('Test "Capture > a thought is kept" (tests/e2e/capture.test.ts · E2E (F3)): 0 failures on main, 1 flaky on feature branches');
    await expect(stripOf('CI')).toBeVisible();

    // Nothing above sent a request: the strips and the prompts were in the page.
    expect(requests).toEqual([]);

    // The table scrolls inside its panel on a phone and fits it on a desk; the page never scrolls sideways.
    expect(await table.locator('.table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(onAPhone);
    expect(await noSideways()).toBe(true);

    // The name opens the workflow's own view, with its row left closed behind it.
    await row('CI').getByRole('link', { name: 'CI', exact: true }).click();
    await expect(page).toHaveURL(/[?&]workflow=CI(&|$)/);
    await expect(page.getByRole('img', { name: 'Runs per day' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'What made CI fail' })).toContainText('a dismissed item leaves the lists');
    await expect(page.getByRole('region', { name: 'Every failure' }).getByRole('row')).toHaveCount(3);
    expect(await noSideways()).toBe(true);
    await page.goto(`${monitor}/stability?group=workflow`);
    await expect(opening('CI')).toHaveAttribute('aria-expanded', 'false');

    // The keyboard: Tab from the table's (i) reaches the first chevron, and Enter opens and closes it.
    await table.getByRole('button', { name: 'How to read By workflow' }).focus();
    await page.keyboard.press('Tab');
    await expect(table.locator('.chev').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(table.locator('tr.detail').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(table.locator('tr.detail').first()).toBeHidden();
  });

  test('a CI stability fragile test opens to its runs on main beside its runs on branches from its chevron, saying whether a re-run passed, main above the branches on a phone, and Copy prompt puts its prompt on the clipboard without opening it; the order changes with the sentence', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCiAttempts(api);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(monitor!).origin });
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.goto(`${monitor}/stability?group=tests`);
    await page.waitForLoadState('load');
    const table = page.getByRole('region', { name: 'Fragile tests' });
    const row = (name: string) => table.locator('tr[data-opens]', { hasText: name });
    const stripOf = (name: string) => row(name).locator('xpath=following-sibling::tr[1][contains(@class, "detail")]');
    const opening = (name: string) => row(name).getByRole('button', { name: new RegExp(`^(Open|Close) ${name}$`) });
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));

    // Only a test a later attempt passed is listed: the pull request's failure that stayed failed is not. Most on main first, every strip in the page and closed.
    await expect(table.locator('tr[data-opens]')).toHaveCount(2);
    await expect(table.locator('tr[data-opens] td.first')).toHaveText([/^›a dismissed item leaves the lists/, /^›a thought is kept/]);
    await expect(table.locator('tr.detail')).toHaveCount(2);
    await expect(table.locator('tr.detail').first()).toBeHidden();
    await expect(opening('a dismissed item leaves the lists')).toHaveAttribute('aria-expanded', 'false');

    // The chevron opens the failure that passed on a re-run on main beside the branches' sentence, which is below it on a phone.
    await opening('a dismissed item leaves the lists').click();
    const triage = stripOf('a dismissed item leaves the lists');
    await expect(triage).toBeVisible();
    await expect(triage.locator('.side.main li')).toHaveText([/re-run passed/]);
    await expect(triage.locator('.side.branch')).toContainText('It has not flaked on a feature branch in this period.');
    await expect(triage).toContainText('apps/api/tests/integration/triage.test.ts');
    const [m, b] = await Promise.all([triage.locator('.side.main').boundingBox(), triage.locator('.side.branch').boundingBox()]);
    if (onAPhone) expect(b!.y).toBeGreaterThan(m!.y + m!.height - 1);
    else {
      expect(Math.abs(b!.y - m!.y)).toBeLessThan(4);
      expect(b!.x).toBeGreaterThan(m!.x + m!.width - 1);
    }
    if (onAPhone) {
      // On a phone the strip stays inside the panel's width while the wide table scrolls beneath it.
      const [strip, panel] = await Promise.all([triage.locator('.strip').boundingBox(), table.locator('.well.table').boundingBox()]);
      expect(strip!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(strip!.x + strip!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
    }
    expect(await noSideways()).toBe(true);

    // The other test flaked on a pull request only: nothing on main, and its run says a re-run passed.
    await row('a thought is kept').locator('td').nth(1).click();
    const capture = stripOf('a thought is kept');
    await expect(capture.locator('.side.main')).toContainText('It has not failed on main in this period.');
    await expect(capture.locator('.side.branch li')).toHaveText([/re-run passed.*pull request 9101 · CI/]);

    // Copy prompt copies this row's prompt, says so for a moment, and neither opens nor closes the row it sits in.
    await row('a thought is kept').getByRole('button', { name: 'Copy prompt' }).click();
    await expect(row('a thought is kept').locator('.copy-prompt')).toHaveText('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('The test "Capture > a thought is kept" in tests/e2e/capture.test.ts (Playwright project: phone) is fragile in CI.');
    expect(copied).toContain('It failed and then passed on the same commit 0 times on main and 1 time on feature branches.');
    expect(copied).toContain('Its latest error: AssertionError: expected 1 to be 2');
    expect(copied).toContain('(feature branch, passed on a later attempt)');
    expect(copied).not.toContain('a dismissed item leaves the lists');
    await expect(capture).toBeVisible();
    await row('a dismissed item leaves the lists').getByRole('button', { name: 'Copy prompt' }).click();
    const copiedTriage = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedTriage).toContain('It failed and then passed on the same commit 1 time on main and 0 times on feature branches.');
    expect(copiedTriage).toContain('(main, passed on a later attempt)');
    await expect(triage).toBeVisible();

    // Nothing above sent a request: the strips and the prompts were in the page.
    expect(requests).toEqual([]);
    expect(await table.locator('.table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(onAPhone);
    expect(await noSideways()).toBe(true);

    // Most in total puts the test whose flake is newest first when both have one.
    await choose(page, 'Order', 'most in total first', /[?&]sort=all(&|$)/);
    await expect(table.locator('tr[data-opens] td.first')).toHaveText([/^›a thought is kept/, /^›a dismissed item leaves the lists/]);
  });

  /**
   * The costs seed and three merged pull requests: 9001 and 9002 are the ones the seed priced, at $6.00 and $3.00; 9003 has no cost.
   * 9001 and 9003 had one round of Test, 9002 a red one then a green one, so its CI rounds are twice as long. 9001's round also ran E2E as four shards, 40 minutes of running in the 5 the round held.
   * None carries its local kinds. 9001 and 9002 also carry the timeline an opened row draws under its outline. 9001: its coding starts half an hour before its round's push, with five seconds of test run ten minutes in, and the round's two jobs, the second a re-run. 9002: its two rounds pushed a quarter of an hour apart, a Test job in each; 9003 has none.
   * Their times are hours before `now`, which is the moment the walk runs unless it is given another.
   * Returns the pull requests it stored, for a walk that reads what it seeded.
   */
  async function seedCycleTime(api: APIRequestContext, now = Date.now()) { // clock-ok: the page reads the Worker's own clock, which the walk cannot inject
    expect((await api.post(`${monitor}/__e2e/seed`, { data: SEED })).ok()).toBe(true);
    const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const check = (name: string, minutes: number, over: Record<string, unknown> = {}) => ({
      name,
      attempt: 1,
      heldMs: minutes * 60_000,
      last: true,
      failure: null,
      flukeMs: null,
      queuedMs: null,
      runningMs: minutes * 60_000,
      detailNotRecorded: false,
      noFileFailed: false,
      failedSteps: [],
      failedFiles: [],
      ...over,
    });
    const pushed = Date.parse(hoursAgo(30));
    const round = (checks: unknown[], red: boolean, over: Record<string, unknown> = {}) => ({ sha: 'b'.repeat(40), pushedAt: new Date(pushed).toISOString(), endedAt: hoursAgo(29), ms: 300_000, red, commits: 1, queueNotRecorded: false, checks, ...over });
    const pull = (number: number, title: string, hours: number, rounds: unknown[], extra: Record<string, unknown> = {}) => ({
      number,
      title,
      url: `https://github.com/o/r/pull/${number}`,
      mergedAt: hoursAgo(hours),
      base: 'main',
      head: null,
      landing: false,
      size: { additions: 30, deletions: 10, files: 3, commits: 2, mainMerges: 0 },
      start: { at: hoursAgo(hours + 1), from: 'session-record' },
      recorded: true,
      codingMs: 600_000,
      localMs: 300_000,
      ciMs: 300_000 * rounds.length,
      waitingToMergeMs: 60_000,
      awayMs: 0,
      totalMs: 3_600_000,
      localReviews: { count: 2, ms: 300_000, byKind: null },
      localRuns: { test: null, browser: null },
      runnerMs: 0,
      cancelled: { superseded: { runs: 0, ms: 0 }, other: { runs: 0, ms: 0 } },
      rounds,
      ...extra,
    });
    // 9001's round, pushed 30 hours ago: its coding starts 30 minutes before the push and a test run of five seconds, too short to see, ran ten minutes in; the jobs are a Test and a re-run of E2E (F3), which stands above the line, clear of the round's name.
    const lane = (name: string, from: number, seconds: number, over: Record<string, unknown> = {}) => ({
      name,
      attempt: 1,
      rerun: false,
      outcome: 'pass',
      startedAt: new Date(pushed + from * 1000).toISOString(),
      endedAt: new Date(pushed + (from + seconds) * 1000).toISOString(),
      offsetMs: from * 1000,
      ms: seconds * 1000,
      leadMs: 0,
      queuedMs: 0,
      ...over,
    });
    const timeline = {
      lanes: [[lane('Test', 20, 280), lane('E2E (F3)', 60, 240, { rerun: true, attempt: 2 })]],
      reviewSlices: [],
      runSlices: [{ kind: 'test', gap: 0, at: new Date(pushed - 20 * 60_000).toISOString(), ms: 5_000 }],
    };
    const pulls = [
      pull(9001, 'Add a filter panel', 20, [round([check('E2E (F3)', 5, { runningMs: 40 * 60_000 }), check('Test', 5)], false)], { start: { at: new Date(pushed - 30 * 60_000).toISOString(), from: 'session-record' }, timeline }),
      pull(9002, 'Save a Teams message', 5, [round([check('Test', 5, { failure: 'red', failedSteps: ['Run the tests'] })], true, { endedAt: new Date(pushed + 300_000).toISOString() }), round([check('Test', 5)], false, { pushedAt: new Date(pushed + 900_000).toISOString(), endedAt: new Date(pushed + 1_200_000).toISOString() })], {
        start: { at: new Date(pushed - 20 * 60_000).toISOString(), from: 'session-record' },
        timeline: { lanes: [[lane('Lint', 0, 290), lane('Test', 20, 100, { outcome: 'fail' })], [lane('Test', 10, 280)]], reviewSlices: [], runSlices: [] },
      }),
      pull(9003, 'Tidy the inbox', 70, [round([check('Test', 5)], false)]),
    ];
    expect((await api.post(`${monitor}/__e2e/seed-cycle-time`, { data: { pulls } })).ok()).toBe(true);
    return pulls;
  }

  test('Cycle time opens from the top bar, its sentence and the Rounds filter narrow it with the cost beside each pull request, each size offers no Size filter, Where the time went is one outline that fits a desk and a phone, the filters sit in one row on a desk, and a phone scrolls the wide table inside its panel', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCycleTime(api);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    // From the costs page, the top bar's own tab opens it on each day, with the tiles an overview has.
    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Cycle time' }).click();
    await expect(page.getByText('Show cycle time for')).toBeVisible();
    await expect(choice(page, 'Rows')).toHaveValue('day');
    await expect(choice(page, 'Merged')).toHaveValue('all');
    await expect(page.locator('.tile')).toHaveCount(4);
    const where = page.getByRole('region', { name: /^Where the .* went$/ });
    await expect(where).toBeVisible();

    // The filters share one row on a desk; the page never scrolls sideways.
    const tops = await page.locator('.only select').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    expect(tops).toHaveLength(2);
    if (!onAPhone) expect(new Set(tops).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Rounds: had a red round, chosen while the rows are days, is kept when each pull request is chosen: only the pull request that had one.
    await choose(page, 'Rounds', 'Had a red round', /[?&]outcome=red(&|$)/);
    await choose(page, 'Rows', 'each pull request', /[?&]group=pr(&|$)/);
    await expect(page).toHaveURL(/[?&]outcome=red(&|$)/);
    await expect(page.locator('.tile')).toHaveCount(0);
    const table = page.getByRole('region', { name: 'By pull request' });
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText('#9002 Save a Teams message');

    // Every pull request again: a row each with the cost the Monitor holds, which opens its Sessions.
    await choose(page, 'Rounds', 'Every pull request', /[?&]outcome=(&|$)/);
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ })).toContainText('$6.00');
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ }).getByRole('link', { name: 'Sessions' })).toHaveAttribute('href', '/pr/9001');
    await expect(table.getByRole('row', { name: /#9003 Tidy the inbox/ })).not.toContainText('$');
    await expect(table.getByRole('row')).toHaveCount(4);
    // No column per phase: the table fits its panel on a desk and scrolls inside it on a phone.
    await expect(table.getByRole('columnheader', { name: 'Local checks' })).toHaveCount(0);
    const wide = page.locator('.well.table');
    expect(await wide.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(onAPhone);

    // Each size lists every size and offers no Size filter, which would repeat the rows.
    await choose(page, 'Rows', 'each size', /[?&]group=size(&|$)/);
    await expect(choice(page, 'Size')).toHaveCount(0);
    await expect(choice(page, 'Rounds')).toBeVisible();

    // There is no Split by, and an old link carrying one opens the one view.
    await expect(page.getByRole('group', { name: 'Split by' })).toHaveCount(0);
    await page.goto(`${monitor}/cycle-time?group=pr&outcome=red&split=harness`);
    await expect(table.getByRole('columnheader', { name: 'Split', exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Security review' })).toHaveCount(0);

    // Over time: the outline is a row a phase as time waited, with its parts as time spent beneath, on one line each with a name, a bar, its time and its share.
    await page.goto(`${monitor}/cycle-time`);
    const rows = where.locator('.o-row');
    await expect(rows.locator('.nm')).toHaveText(['Writing', 'Local checks 15m spent', 'Not split by kind', 'CI rounds 1h 00m spent side by side', 'E2E (F3)', 'Test', 'Waiting to merge']);
    await expect(rows.locator('.am')).toHaveText(['30m', '15m waited', '15m spent', '20m waited', '40m spent', '20m spent', '3m']);
    const laidOut = await rows.evaluateAll((all) =>
      all.map((row) => {
        const [name, bar, minutes, share] = ['.nm', '.tr', '.am', '.sh'].map((c) => row.querySelector(c)!.getBoundingClientRect());
        return { name: [name!.top, name!.height], bar: [bar!.top, bar!.height], minutes: [minutes!.top, minutes!.height], share: [share!.top, share!.height], left: [name!.left, bar!.left, minutes!.left, share!.left] };
      }),
    );
    const centre = ([top, height]: number[]) => top! + height! / 2;
    for (const r of laidOut) {
      if (!onAPhone) {
        // On a desk the four sit on one line, in the order name, bar, minutes, share.
        expect(Math.abs(centre(r.name) - centre(r.bar))).toBeLessThan(2);
        expect(Math.abs(centre(r.name) - centre(r.minutes))).toBeLessThan(2);
        expect(Math.abs(centre(r.name) - centre(r.share))).toBeLessThan(2);
        expect(r.left).toEqual([...r.left].sort((x, y) => x - y));
      } else {
        // On a phone the name, minutes and share share a line and the bar runs beneath, inside the panel.
        expect(Math.abs(centre(r.name) - centre(r.minutes))).toBeLessThan(2);
        expect(r.bar[0]!).toBeGreaterThan(r.name[0]!);
      }
    }
    expect(await where.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // A part's bar starts where its phase's bar starts and a dashed line marks where the phase's wait ended; E2E's four shards ran longer than CI rounds waited, so its bar runs past the line and stays inside the panel.
    await expect(where.locator('.edge')).toHaveCount(3);
    const e2e = await where.locator('.o-row', { hasText: 'E2E (F3)' }).evaluate((li) => {
      const [track, bar, edge] = ['.tr', '.b', '.edge'].map((c) => li.querySelector(c)!.getBoundingClientRect());
      return { track: track!.right, bar: [bar!.left, bar!.right], edge: edge!.left };
    });
    const ci = await where.locator('.o-row', { hasText: 'CI rounds' }).evaluate((li) => li.querySelector('.b')!.getBoundingClientRect().left);
    expect(Math.abs(e2e.bar[0]! - ci)).toBeLessThan(1);
    expect(e2e.bar[1]!).toBeGreaterThan(e2e.edge + 1);
    expect(e2e.bar[1]!).toBeLessThanOrEqual(e2e.track + 1);
  });

  test("a Cycle time row opens to its own outline from its chevron or anywhere on it outside its links, and closes with a second click, with no request, several at once, from the keyboard, and fitting a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCycleTime(api);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.goto(`${monitor}/cycle-time?group=pr`);
    await page.waitForLoadState('load');
    const table = page.getByRole('region', { name: 'By pull request' });
    const row = (number: number) => table.locator('tr[data-figures]', { hasText: `#${number}` });
    const strips = table.locator('tr.detail');
    const stripOf = (number: number) => row(number).locator('xpath=following-sibling::tr[1][contains(@class, "detail")]');
    const opening = (number: number) => row(number).getByRole('button', { name: new RegExp(`^(Open|Close) #${number} `) });
    const requests: string[] = [];
    // The timeline an opened row loads under its outline is the next walk's; the outline itself asks for nothing.
    page.on('request', (r) => {
      if (!r.url().includes('/cycle-time/timeline')) requests.push(r.url());
    });

    // The chevron: a closed row's strip is not in the page, then it is that row's own outline, beneath it, with the row tinted.
    await expect(opening(9001)).toHaveAttribute('aria-expanded', 'false');
    await expect(strips).toHaveCount(0);
    await opening(9001).click();
    await expect(opening(9001)).toHaveAttribute('aria-expanded', 'true');
    await expect(opening(9001)).toHaveAccessibleName('Close #9001 Add a filter panel');
    await expect(row(9001)).toHaveClass(/\bopen\b/);
    await expect(strips).toBeVisible();
    await expect(strips.locator('.o-row .nm')).toHaveText(['Writing', 'Local checks 5m spent', 'Not split by kind', 'CI rounds 45m spent side by side', 'E2E (F3)', 'Test', 'Waiting to merge']);
    await expect(strips.locator('.o-row .am')).toHaveText(['10m', '5m waited', '5m spent', '5m waited', '40m spent', '5m spent', '1m']);
    await expect(strips.locator('.o-row .sh')).toHaveText(['48%', '24%', '100%', '24%', '89%', '11%', '5%']);
    await expect(strips.locator('.o-row .edge')).toHaveCount(3);
    expect(await row(9001).evaluate((tr) => tr.nextElementSibling?.classList.contains('detail'))).toBe(true);
    if (!onAPhone) {
      // On a desk each row of the strip keeps a name, a bar, its minutes and its share on one line.
      const box = await strips.locator('.o-row').first().evaluate((li) => ['.nm', '.tr', '.am', '.sh'].map((c) => Math.round(li.querySelector(c)!.getBoundingClientRect().top + li.querySelector(c)!.getBoundingClientRect().height / 2)));
      expect(Math.max(...box) - Math.min(...box)).toBeLessThan(2);
    }

    // Anywhere else on the row closes it, and the same again opens it.
    await row(9001).locator('.split-cell').click();
    await expect(strips).toBeHidden();
    await expect(opening(9001)).toHaveAttribute('aria-expanded', 'false');
    await expect(row(9001)).not.toHaveClass(/\bopen\b/);
    await row(9001).locator('.split-cell').click();
    await expect(strips).toBeVisible();

    // Two rows open at once, each with its own figures: 9002's two rounds of Test are twice 9001's one.
    await row(9002).locator('td.total').first().click();
    await expect(strips).toHaveCount(2);
    await expect(stripOf(9001)).toBeVisible();
    await expect(stripOf(9002)).toBeVisible();
    await expect(stripOf(9002).locator('.o-row .am')).toHaveText(['10m', '5m waited', '5m spent', '10m waited', '10m spent', '1m']);
    await expect(stripOf(9001).locator('.o-row .am')).toHaveText(['10m', '5m waited', '5m spent', '5m waited', '40m spent', '5m spent', '1m']);
    expect(await noSideways()).toBe(true);
    if (onAPhone) {
      // On a phone the strip stays inside the panel's width while the wide table scrolls beneath it.
      const [strip, panel] = await Promise.all([stripOf(9001).locator('.strip').boundingBox(), table.locator('.well.table').boundingBox()]);
      expect(strip!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(strip!.x + strip!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
    }

    // Nothing above sent a request: the strips were drawn from what the page already held.
    expect(requests).toEqual([]);

    // A row's links go where they went and neither open nor close it: a click that is stopped before it navigates leaves each row as it was.
    await page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault()));
    await row(9001).getByRole('link', { name: 'Sessions' }).click();
    await row(9002).getByRole('link', { name: /#9002 Save a Teams message/ }).click();
    await expect(strips).toHaveCount(2);
    await expect(stripOf(9001)).toBeVisible();
    await expect(stripOf(9002)).toBeVisible();
    await row(9003).getByRole('link', { name: /#9003 Tidy the inbox/ }).click();
    await expect(opening(9003)).toHaveAttribute('aria-expanded', 'false');
    await expect(strips).toHaveCount(2);

    // Left to itself, a link opens its page: a pull request's Sessions, with the row left closed behind it.
    await page.goto(`${monitor}/cycle-time?group=pr`);
    await table.locator('tr[data-figures]', { hasText: '#9001' }).getByRole('link', { name: 'Sessions' }).click();
    await expect(page).toHaveURL(`${monitor}/pr/9001`);

    // An open row is not kept in the address: a reload draws every row closed.
    await page.goto(`${monitor}/cycle-time?group=pr`);
    await expect(opening(9001)).toHaveAttribute('aria-expanded', 'false');
    await expect(strips).toHaveCount(0);

    // The keyboard: Tab from the last filter passes the table's (i) and reaches the first chevron, and Enter opens and closes it.
    await choice(page, 'Rounds').focus();
    await page.keyboard.press('Tab');
    await expect(table.getByRole('button', { name: 'How to read By pull request' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(table.locator('.chev').first()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(strips).toBeVisible();
    await expect(table.locator('.chev').first()).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Enter');
    await expect(strips).toBeHidden();

    // Over time, Issue and Size open their rows too, and the Check tab has nothing to open.
    for (const [group, region, name] of [
      ['day', 'By day merged', /^Open \d{1,2} \w{3} \d{4}$/],
      ['issue', 'By issue', /^Open (#9000 .+|No issue named)$/],
      ['size', 'By size', /^Open Under 100 lines$/],
    ] as const) {
      await page.goto(`${monitor}/cycle-time?group=${group}`);
      const rows = page.getByRole('region', { name: region });
      await expect(rows.getByRole('button', { name }).first()).toHaveAttribute('aria-expanded', 'false');
      await rows.getByRole('button', { name }).first().click();
      await expect(rows.locator('tr.detail .o-row .nm').first()).toHaveText('Writing');
      expect(await noSideways()).toBe(true);
    }
    await page.goto(`${monitor}/cycle-time?group=check`);
    await expect(page.getByRole('region', { name: 'By check' })).toBeVisible();
    await expect(page.locator('.chev')).toHaveCount(0);
  });

  test("a Cycle time pull request's E2E (F3) and Test lines open what that check selected beneath them, from a click or the keyboard, with one request each and none to close, while no other line or row opens one, fitting a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCycleTime(api);
    // Merged long before the 14 days the Test selection walk counts, so that walk's pull requests stay the only ones it sees.
    const longAgo = new Date(Date.now() - 40 * 86_400_000).toISOString(); // clock-ok: the page reads the Worker's own clock, which the walk cannot inject
    const item = 'apps/api/src/item.ts';
    const index = 'apps/api/src/index.ts';
    const longPath = `apps/api/tests/unit/${'a-folder-with-a-long-name/'.repeat(4)}picked-by-the-client.test.ts`;
    const picked = (path: string, from: string, ...steps: string[]) => ({ path, level: 'unit', status: 'passed', selectedBy: { kind: 'chain', chain: [path, ...steps, from], text: [path, ...steps, from].join(' → ') } });
    const job = (name: 'test' | 'e2e', over: Record<string, unknown>) => ({ job: name, status: 'ran', ranEverything: false, selecting: true, filesRun: 1, filesTotal: 40, prDurationMs: null, mainDurationMs: null, changedFiles: [{ path: item, ignored: false }], packages: [], ...over });
    const selected = {
      number: 9001,
      title: 'Add a filter panel',
      url: 'https://github.com/o/r/pull/9001',
      mergedAt: longAgo,
      misses: [],
      jobs: [
        job('test', {
          filesRun: 6,
          packages: [{ name: 'api', dir: 'apps/api', mode: 'changed', report: 'written', reason: null, filesTotal: 40, files: [...[1, 2, 3, 4, 5].map((n) => picked(`apps/api/tests/unit/item-${n}.test.ts`, item, index)), picked(longPath, 'apps/api/src/client.ts')] }],
        }),
        job('e2e', {
          ranEverything: true,
          selecting: false,
          filesRun: 32,
          filesTotal: 32,
          packages: [{ name: 'e2e', dir: 'tests/e2e', mode: 'full', report: 'written', reason: { rule: 'e2e support, registry or config', path: 'tools/test-explorer/concepts.json' }, filesTotal: 32, files: [] }],
        }),
      ],
    };
    const bars = { windowDays: 14, minPulls: 20, items: [{ id: 'e2e-forced-full', name: 'E2E forced to run every spec', threshold: 0.25, minOver: null, alarmIssue: null }, { id: 'test-forced-full', name: 'Test forced to run everything', threshold: 0.25, minOver: null, alarmIssue: null }, { id: 'misses', name: 'Misses', threshold: 1, minOver: null, alarmIssue: null }, { id: 'most-selected', name: 'A test selected on nearly every pull request', threshold: 0.8, minOver: 10, alarmIssue: null }] };
    expect((await api.post(`${monitor}/__e2e/seed-selection`, { data: { pulls: [selected], bars } })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.goto(`${monitor}/cycle-time?group=pr`);
    await page.waitForLoadState('load');
    const table = page.getByRole('region', { name: 'By pull request' });
    const row = (number: number) => table.locator('tr[data-figures]', { hasText: `#${number}` });
    const strip = (number: number) => row(number).locator('xpath=following-sibling::tr[1][contains(@class, "detail")]');
    const lineOf = (number: number, name: string) => strip(number).getByRole('button', { name, exact: true });
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/selection/check')) requests.push(new URL(r.url()).search);
    });

    // A pull request's strip offers its E2E (F3) and Test lines to open and no other, opening the row asks for nothing.
    await row(9001).getByRole('button', { name: /^Open #9001 / }).click();
    await expect(strip(9001)).toBeVisible();
    await expect(strip(9001).getByRole('button')).toHaveCount(2);
    await expect(lineOf(9001, 'E2E (F3)')).toHaveAttribute('aria-expanded', 'false');
    await expect(strip(9001).locator('.o-sel')).toHaveCount(0);
    expect(requests).toEqual([]);

    // E2E (F3) ran every spec: the rule and path that forced it, its advice, and the link to the whole selection.
    await lineOf(9001, 'E2E (F3)').click();
    const e2eBox = strip(9001).locator('.o-sel').first();
    await expect(lineOf(9001, 'E2E (F3)')).toHaveAttribute('aria-expanded', 'true');
    await expect(e2eBox).toBeVisible();
    await expect(e2eBox).toContainText('Ran everything: 32 of 32 specs, because');
    await expect(e2eBox).toContainText('e2e support, registry or config: tools/test-explorer/concepts.json');
    await expect(e2eBox).toContainText('shared by every walk, so it forces every spec, and should.');
    await expect(e2eBox).toContainText('What its last CI run selected · Open its whole selection');
    await expect(e2eBox.getByRole('link', { name: 'Open its whole selection' })).toHaveAttribute('href', '/selection?group=pr&job=e2e&pr=9001');
    expect(requests).toEqual(['?pr=9001&job=e2e']);

    // The same line again closes it, and the next click shows it as it was, with no second request.
    await strip(9001).locator('.o-row', { hasText: 'E2E (F3)' }).locator('.tr').click();
    await expect(e2eBox).toBeHidden();
    await expect(lineOf(9001, 'E2E (F3)')).toHaveAttribute('aria-expanded', 'false');
    await lineOf(9001, 'E2E (F3)').click();
    await expect(e2eBox).toBeVisible();
    expect(requests).toEqual(['?pr=9001&job=e2e']);

    // Test, from the keyboard: it selected a subset, grouped by the changed file its chains started from, the largest group opening to its files.
    await lineOf(9001, 'Test').focus();
    await page.keyboard.press('Enter');
    const testBox = strip(9001).locator('.o-sel').nth(1);
    await expect(testBox).toBeVisible();
    await expect(testBox).toContainText('Selected a subset: 6 of 40 test files · api 6 of 40');
    await expect(testBox).toContainText('Reached from 2 starting points');
    const groups = testBox.locator('summary');
    await expect(groups.first()).toContainText('apps/api/src/item.ts → 5 test files · api 5');
    await expect(groups.first()).toContainText(`mostly through ${index} (5 of 5)`);
    await expect(groups.nth(1)).toContainText('apps/api/src/client.ts → 1 test file');
    await expect(testBox.getByText('apps/api/tests/unit/item-1.test.ts')).toBeHidden();
    await groups.first().click();
    await expect(testBox.getByText('apps/api/tests/unit/item-1.test.ts')).toBeVisible();
    await expect(testBox.getByText(`via ${index} → ${item}`).first()).toBeVisible();
    await groups.nth(1).click();
    // A long path wraps inside the box rather than past it, on a desk and on a phone.
    await expect(testBox.getByText(longPath)).toBeVisible();
    expect(await testBox.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await noSideways()).toBe(true);
    if (onAPhone) {
      const [box, panel] = await Promise.all([testBox.boundingBox(), table.locator('.well.table').boundingBox()]);
      expect(box!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
    }
    await expect(testBox.getByRole('link', { name: 'Open its whole selection' })).toHaveAttribute('href', '/selection?group=pr&job=test&pr=9001');
    await lineOf(9001, 'Test').focus();
    await page.keyboard.press('Enter');
    await expect(testBox).toBeHidden();
    expect(requests).toEqual(['?pr=9001&job=e2e', '?pr=9001&job=test']);

    // Its link opens that pull request's whole selection, for that job.
    await e2eBox.getByRole('link', { name: 'Open its whole selection' }).click();
    await expect(page).toHaveURL(/\/selection\?group=pr&job=e2e&pr=9001$/);
    await expect(page.getByRole('region', { name: /#9001 Add a filter panel/ })).toContainText('E2E job');

    // A pull request the selection rows do not hold says so, and links to nothing.
    await page.goto(`${monitor}/cycle-time?group=pr`);
    await row(9003).getByRole('button', { name: /^Open #9003 / }).click();
    await lineOf(9003, 'Test').click();
    await expect(strip(9003).locator('.o-sel')).toHaveText('The Monitor holds no test selection record for this pull request.');

    // A row that is not one pull request opens its strip with the same lines and none of them opens anything: a day, an issue and a size.
    for (const [group, region] of [
      ['day', 'By day merged'],
      ['issue', 'By issue'],
      ['size', 'By size'],
    ] as const) {
      await page.goto(`${monitor}/cycle-time?group=${group}`);
      const rows = page.getByRole('region', { name: region });
      for (const chevron of await rows.locator('.chev').all()) await chevron.click();
      await expect(rows.locator('tr.detail .o-row', { hasText: 'E2E (F3)' })).toHaveCount(1);
      await expect(rows.locator('tr.detail').getByRole('button')).toHaveCount(0);
      await rows.locator('tr.detail .o-row', { hasText: 'E2E (F3)' }).locator('.nm').click();
      await expect(rows.locator('.o-sel')).toHaveCount(0);
    }
    expect(requests).toEqual(['?pr=9001&job=e2e', '?pr=9001&job=test', '?pr=9003&job=test']);
  });

  test("an opened Pull request row draws its outline at once and its timeline under it, which zooms on a click to a Belgian clock-time axis, reads a clicked CI job under it, and closes on a click of the axis, two rows at once each on its own, fitting a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    // Pinned to the last 23:30 in Brussels, so 9001 is pushed at 17:30 and merged at 03:30 of the next day whatever time the walk runs: the dated labels on its axis, and a break ending it, are always there.
    const brussels = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(Date.now()); // clock-ok: the pin is a time before the Worker's own clock, which the seeded pull requests must stay inside
    const minuteOfDay = Number(brussels.find((p) => p.type === 'hour')!.value) * 60 + Number(brussels.find((p) => p.type === 'minute')!.value);
    const lateEvening = Math.floor(Date.now() / 60_000) * 60_000 - ((minuteOfDay - (23 * 60 + 30) + 24 * 60) % (24 * 60)) * 60_000; // clock-ok: as above
    const [seeded] = (await seedCycleTime(api, lateEvening)) as { rounds: { pushedAt: string }[] }[];
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const belgianClock = (ms: number) => new Intl.DateTimeFormat('en-BE', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
    // Its coding starts 30 minutes before the round was pushed, which is where the axis starts.
    const starts = belgianClock(Date.parse(seeded!.rounds[0]!.pushedAt) - 30 * 60_000);
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    // Every label of an axis sits inside it and clear of the others.
    const labelsHaveRoom = (axis: Locator) =>
      axis.evaluate((el) => {
        const edge = el.getBoundingClientRect();
        const boxes = [...el.querySelectorAll('.tl-clocktick')].map((tick) => tick.getBoundingClientRect()).sort((a, b) => a.left - b.left);
        return boxes.every((box, at) => box.left >= edge.left - 0.5 && box.right <= edge.right + 0.5 && (at === 0 || boxes[at - 1]!.right <= box.left));
      });

    await page.goto(`${monitor}/cycle-time?group=pr`);
    await page.waitForLoadState('load');
    const table = page.getByRole('region', { name: 'By pull request' });
    const row = (number: number) => table.locator('tr[data-figures]', { hasText: `#${number}` });
    const strip = (number: number) => row(number).locator('xpath=following-sibling::tr[1][contains(@class, "detail")]');
    const requests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/cycle-time/timeline')) requests.push(new URL(r.url()).search);
    });
    // The page's own load asked for no timeline.
    expect(requests).toEqual([]);

    // Opening the row draws its outline from the row's own figures and asks for its timeline: one request, for that one pull request.
    await row(9001).getByRole('button', { name: /^Open #9001 / }).click();
    const one = strip(9001);
    await expect(one.locator('.o-row .nm').first()).toHaveText('Writing');
    await expect(one.locator('.tl-box .tl-strip')).toBeVisible();
    expect(requests).toEqual(['?pr=9001']);
    // The outline is first and the timeline right under it, with one line of colour key beneath the strip.
    const [outline, timeline] = await Promise.all([one.locator('.outline').boundingBox(), one.locator('.tl-box').boundingBox()]);
    expect(timeline!.y).toBeGreaterThanOrEqual(outline!.y + outline!.height);
    await expect(one.locator('.tl-keyline')).toHaveCount(1);
    await expect(one.locator('.tl-sectionnote')).toHaveCount(0);

    // Closed: the strip on its scale, with its summary under it and no axis; the strip fits the width, and the test run too short to see is 3px wide.
    const zoomed = one.locator('.tl-zoomed');
    const detailBox = one.locator('.tl-detailbox');
    await expect(zoomed).toBeHidden();
    await expect(one.locator('.tl-strip > .tl-clipnote.whenclosed').first()).toHaveText('1 CI Round · 1h 00m to merge');
    expect(await noSideways()).toBe(true);
    expect((await one.locator('.tl-striphit.whenclosed .tl-seg.local.test').boundingBox())!.width).toBeCloseTo(3, 0);

    // A click on the strip zooms it, with the axis in Belgian clock time from where the pull request started, and leaves the row open.
    await one.locator('.tl-striphit.whenclosed').click();
    await expect(zoomed).toBeVisible();
    await expect(row(9001)).toHaveClass(/\bopen\b/);
    await expect(zoomed.locator('.tl-clocktick').first()).toHaveText(starts);
    // The merge is on the next day, so its label carries the date, and it has room beside the break's.
    await expect(zoomed.locator('.tl-clocktick').last()).toHaveText(/^\d+ \w+ \d\d:\d\d$/);
    expect(await labelsHaveRoom(zoomed.locator('.tl-clockaxis'))).toBe(true);
    await expect(detailBox).toContainText('1 CI Round · 1h 00m to merge · click a phase, a CI job or a local run on the strip to read it here.');
    expect(await noSideways()).toBe(true);
    expect((await zoomed.locator('.tl-seg.local.test').boundingBox())!.width).toBeCloseTo(3, 0);
    if (onAPhone) {
      const [inner, panel] = await Promise.all([one.locator('.tl-box').boundingBox(), table.locator('.well.table').boundingBox()]);
      expect(inner!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(inner!.x + inner!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 1);
    }

    // A click on a CI job (the re-run, which stands in the row above the line, clear of the round's name) reads its line and its round under the axis, and the strip stays zoomed.
    await zoomed.locator('.tl-lane.tl-job.rerun').click();
    await expect(detailBox.locator('.tl-detail:visible .tl-dhead')).toHaveText('E2E (F3)');
    await expect(detailBox).toContainText(/started \d\d:\d\d:\d\d, stopped \d\d:\d\d:\d\d · ran 4m 00s · waited 0s for a runner · passed · re-run \(attempt 2\)/);
    await expect(detailBox).toContainText('in CI Round 1 · pushed');
    await expect(zoomed).toBeVisible();

    // A second row open at once draws its own strip: zooming it leaves the first as it was, and a pick on it reads in its own box.
    await row(9002).getByRole('button', { name: /^Open #9002 / }).click();
    const other = strip(9002);
    await expect(other.locator('.tl-box .tl-strip')).toBeVisible();
    expect(requests).toEqual(['?pr=9001', '?pr=9002']);
    await expect(other.locator('.tl-zoomed')).toBeHidden();
    await other.locator('.tl-striphit.whenclosed').click();
    await expect(other.locator('.tl-zoomed')).toBeVisible();
    await other.locator('.tl-zoomed .tl-lane.tl-job.failed').click();
    await expect(other.locator('.tl-detailbox .tl-detail:visible .tl-dhead')).toHaveText('Test');
    await expect(other.locator('.tl-detailbox')).toContainText('failed');
    await expect(detailBox.locator('.tl-detail:visible .tl-dhead')).toHaveText('E2E (F3)');
    expect(await noSideways()).toBe(true);

    // A click on the first strip's axis closes its zoom, and only its own.
    await zoomed.locator('.tl-axishit').click();
    await expect(zoomed).toBeHidden();
    await expect(other.locator('.tl-zoomed')).toBeVisible();
    expect(await noSideways()).toBe(true);

    // A pull request with no stored timeline says so under its outline, with no strip.
    await row(9003).getByRole('button', { name: /^Open #9003 / }).click();
    await expect(strip(9003).locator('.tl-box')).toHaveText('Timeline not recorded.');
    await expect(strip(9003).locator('.tl-strip')).toHaveCount(0);

    // Closing a row and opening it again asks for nothing more.
    await row(9001).getByRole('button', { name: /^Close #9001 / }).click();
    await row(9001).getByRole('button', { name: /^Open #9001 / }).click();
    await expect(one.locator('.tl-box .tl-strip')).toBeVisible();
    expect(requests).toEqual(['?pr=9001', '?pr=9002', '?pr=9003']);

    // A row that is not one pull request opens its outline alone: a day, an issue and a size.
    for (const [group, region] of [
      ['day', 'By day merged'],
      ['issue', 'By issue'],
      ['size', 'By size'],
    ] as const) {
      await page.goto(`${monitor}/cycle-time?group=${group}`);
      const rows = page.getByRole('region', { name: region });
      for (const chevron of await rows.locator('.chev').all()) await chevron.click();
      await expect(rows.locator('tr.detail .o-row').first()).toBeVisible();
      await expect(rows.locator('.tl-box')).toHaveCount(0);
    }
    expect(requests).toEqual(['?pr=9001', '?pr=9002', '?pr=9003']);

    // Its costs page has no timeline: it lists the pull request's cost and sessions alone.
    await page.goto(`${monitor}/pr/9001`);
    await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
    await expect(page.locator('.tl-strip')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Timeline', exact: true })).toHaveCount(0);
  });

  test('an opened Pull request row whose timeline cannot be read says so under its outline and asks again when it is opened again', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCycleTime(api);

    await page.goto(`${monitor}/cycle-time?group=pr`);
    await page.waitForLoadState('load');
    const table = page.getByRole('region', { name: 'By pull request' });
    const row = table.locator('tr[data-figures]', { hasText: '#9001' });
    const strip = row.locator('xpath=following-sibling::tr[1][contains(@class, "detail")]');

    // The request fails: the outline, drawn from the row's own figures, is there and the timeline says it could not be read.
    await page.route('**/cycle-time/timeline*', (route) => route.abort());
    await row.getByRole('button', { name: /^Open #9001 / }).click();
    await expect(strip.locator('.o-row .nm').first()).toHaveText('Writing');
    await expect(strip.locator('.tl-box')).toContainText('Could not read the timeline. Close this row and open it again to try again.');
    await expect(strip.locator('.tl-strip')).toHaveCount(0);

    // Opened again once the Monitor answers, the same row reads it.
    await page.unroute('**/cycle-time/timeline*');
    await row.getByRole('button', { name: /^Close #9001 / }).click();
    await row.getByRole('button', { name: /^Open #9001 / }).click();
    await expect(strip.locator('.tl-box .tl-strip')).toBeVisible();
    await expect(strip.locator('.tl-box')).not.toContainText('Could not read');
  });

  test("an (i) on Cycle time opens its explanation on pointing or a tap, keeps it on a click, and closes it on leaving, a second click, a click elsewhere or Escape, one at a time, with no request, inside the screen's width", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCycleTime(api);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    // The page's timers are ours to run, so that "still open after leaving" is asked after the time it would have closed in, not after a sleep.
    await page.clock.install();
    await page.goto(`${monitor}/cycle-time`);
    await page.waitForLoadState('load');
    const info =(name: string) => page.getByRole('button', { name: `How to read ${name}`, exact: true });
    const where = info('Where the time went');
    const scatter = info('Writing against the harness');
    const whereText = page.locator('#x-where');
    const scatterText = page.locator('#x-scatter');
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    // A desk points and clicks; a phone taps, which the browser answers as a click after the touch.
    const press = (target: typeof where) => (onAPhone ? target.tap() : target.click());
    // Elsewhere is the footer's empty edge: an explanation opens over the panels beside its (i), but never down there.
    const elsewhere = () => (onAPhone ? page.locator('footer').tap({ position: { x: 5, y: 5 } }) : page.locator('footer').click({ position: { x: 5, y: 5 } }));

    // Closed at rest, naming what it opens.
    await expect(whereText).toBeHidden();
    await expect(where).toHaveAttribute('aria-expanded', 'false');

    if (!onAPhone) {
      // Pointing opens it, with its three parts, and leaving closes it.
      await where.hover();
      await expect(whereText).toBeVisible();
      await expect(whereText.locator('dt')).toHaveText(['What it shows', 'How to read it', 'What to look for']);
      await expect(where).toHaveAttribute('aria-expanded', 'true');
      await page.mouse.move(1, 1);
      await expect(whereText).toBeHidden();
    }

    // A click or tap keeps it open after the pointer leaves, and sits within the screen's width.
    await press(where);
    await expect(whereText).toBeVisible();
    await page.mouse.move(1, 1);
    await page.clock.runFor(1000);
    await expect(whereText).toBeVisible();
    const box = (await whereText.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // A second click or tap on it closes it.
    await press(where);
    await expect(whereText).toBeHidden();

    // A click or tap elsewhere closes it, and so does Escape.
    await press(where);
    await expect(whereText).toBeVisible();
    await elsewhere();
    await expect(whereText).toBeHidden();
    await press(where);
    await expect(whereText).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(whereText).toBeHidden();
    await expect(where).toHaveAttribute('aria-expanded', 'false');

    // Opening a second one closes the first. The first may be open over the second's (i), so the second is reached from the keyboard.
    await press(where);
    await expect(whereText).toBeVisible();
    await scatter.focus();
    await page.keyboard.press('Enter');
    await expect(scatterText).toBeVisible();
    await expect(whereText).toBeHidden();
    await elsewhere();
    await expect(scatterText).toBeHidden();

    // From the keyboard: focus and Enter open it, Escape closes it.
    await where.focus();
    await page.keyboard.press('Enter');
    await expect(whereText).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(whereText).toBeHidden();

    // The text was in the page already: nothing above asked for anything.
    expect(requests).toEqual([]);
  });

  test("a Cycle time tile's (i) sits on its label's line, on a desk and on a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    await seedCycleTime(api);

    await page.goto(`${monitor}/cycle-time`);
    const tiles = page.locator('.tile');
    await expect(tiles).toHaveCount(4);

    // For each tile: the lines its label's words are set on, and where its (i) sits against the last of them.
    const check = async () => {
      const laidOut = await tiles.evaluateAll((all) =>
        all.map((tile) => {
          const label = tile.querySelector('.tile-label')!;
          const button = label.querySelector('.info')!.getBoundingClientRect();
          // Every line the label's words (not the button's) are set on.
          const words = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
          const lines: { top: number; bottom: number }[] = [];
          while (words.nextNode()) {
            if (words.currentNode.parentElement!.closest('button')) continue;
            const range = document.createRange();
            range.selectNodeContents(words.currentNode);
            for (const r of range.getClientRects()) if (r.width > 0) lines.push({ top: r.top, bottom: r.bottom });
          }
          const last = lines.reduce((a, b) => (b.top > a.top ? b : a));
          return { name: label.firstChild!.textContent!, button: (button.top + button.bottom) / 2, last, right: button.right, tile: tile.getBoundingClientRect().right };
        }),
      );
      for (const t of laidOut) {
        // The centre of the (i) is within the last line of the label's words, and inside its tile.
        expect(t.button, `${t.name} at ${page.viewportSize()!.width}px`).toBeGreaterThanOrEqual(t.last.top);
        expect(t.button, `${t.name} at ${page.viewportSize()!.width}px`).toBeLessThanOrEqual(t.last.bottom);
        expect(t.right, t.name).toBeLessThanOrEqual(t.tile);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    };
    await check();
    // A phone is any width from a narrow handset up to the project's: a label wraps at some of them and not at others, and its (i) goes with its last word at each.
    if ((page.viewportSize()?.width ?? 0) <= 640) {
      for (let width = 320; width <= 480; width += 8) {
        await page.setViewportSize({ width, height: 800 });
        await check();
      }
    }
  });

  test("Test selection opens from the top bar on each day with a tile for each question, its sentence reaches each rule that forced a full run, a rule's paths and a pull request from them, and each test skipped then failed on main, whose Copy prompt puts that row's prompt on the clipboard, on a desk and a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString(); // clock-ok: the page reads the Worker's own clock, which the walk cannot inject
    const hot = 'apps/api/tests/unit/hot.test.ts';
    const job = (name: 'test' | 'e2e', over: Record<string, unknown>) => ({
      job: name,
      status: 'ran',
      ranEverything: false,
      selecting: true,
      filesRun: 1,
      filesTotal: 40,
      prDurationMs: name === 'test' ? 90_000 : null,
      mainDurationMs: name === 'test' ? 400_000 : null,
      changedFiles: [{ path: 'apps/api/src/b.ts', ignored: false }],
      packages: [],
      ...over,
    });
    const pkg = (name: string, mode: 'full' | 'changed', files: unknown[], reason: { rule: string; path: string | null } | null = null) => ({ name, dir: `apps/${name}`, mode, report: 'written', reason, files });
    const file = (path: string, selectedBy: unknown) => ({ path, level: 'unit', status: 'passed', selectedBy });
    const pull = (number: number, title: string, hours: number, jobs: unknown[], misses: unknown[] = []) => ({ number, title, url: `https://github.com/o/r/pull/${number}`, mergedAt: hoursAgo(hours), jobs, misses });
    const everything = (name: 'test' | 'e2e', rule: string, path: string) =>
      job(name, { ranEverything: true, selecting: false, filesRun: 2, packages: [pkg(name === 'test' ? 'api' : 'e2e', 'full', [file('a.test.ts', { kind: 'full' }), file('b.test.ts', { kind: 'full' })], { rule, path })] });
    const docs = (name: 'test' | 'e2e') => job(name, { status: 'docs-only', selecting: false, filesRun: null, filesTotal: null, prDurationMs: null, mainDurationMs: null });
    const pulls = [
      pull(
        9101,
        'Add a filter panel',
        20,
        [job('test', { packages: [pkg('api', 'changed', [file(hot, { kind: 'chain', chain: [hot, 'apps/api/src/a.ts', 'apps/api/src/b.ts'], text: `${hot} → apps/api/src/a.ts → apps/api/src/b.ts` })])] }), job('e2e', {})],
        [{ job: 'test', path: 'apps/api/tests/unit/flaky.test.ts', level: 'unit', reason: null }],
      ),
      pull(9102, 'Save a Teams message', 5, [everything('test', 'any tsconfig', 'tsconfig.json'), everything('e2e', 'owned by no concept', 'apps/api/src/b.ts')]),
      pull(9103, 'Tidy the docs', 70, [docs('test'), docs('e2e')], [{ job: 'e2e', path: 'tests/e2e/capture.test.ts', level: 'e2e', reason: 'docs only' }]),
    ];
    const bars = {
      windowDays: 14,
      minPulls: 20,
      items: [
        { id: 'e2e-forced-full', name: 'E2E forced to run every spec', threshold: 0.25, minOver: null, alarmIssue: null },
        { id: 'test-forced-full', name: 'Test forced to run everything', threshold: 0.25, minOver: null, alarmIssue: null },
        { id: 'misses', name: 'Misses', threshold: 1, minOver: null, alarmIssue: null },
      ],
    };
    expect((await api.post(`${monitor}/__e2e/seed-selection`, { data: { pulls, bars } })).ok()).toBe(true);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(monitor!).origin });
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const noSidewaysScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    // From the costs page, the top bar's own tab opens it on each day, with a tile for each question, no Only row, and the sentence offering exactly three rows.
    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Test selection' }).click();
    await expect(page.getByText('Show test selection for')).toBeVisible();
    await expect(choice(page, 'Rows')).toHaveValue('day');
    await expect(choice(page, 'Rows').locator('option')).toHaveText(['each day', 'each rule that forced a full run', 'each test skipped, then failed on main']);
    await expect(choice(page, 'Job')).toHaveValue('both');
    await expect(choice(page, 'Period')).toHaveValue('14d');
    await expect(page.locator('.only')).toHaveCount(0);
    await expect(page.locator('.tile')).toHaveCount(2);
    await expect(page.locator('.tile').filter({ hasText: 'Ran less than needed' })).toContainText('2 tests');
    await expect(page.getByRole('region', { name: 'What each job did with 3 pull requests' })).toBeVisible();
    expect(await noSidewaysScroll()).toBe(true);

    // The longest sentence fits the band at this width: every select inside it, the page never scrolling sideways; it is one row of words on a desk and wraps on a phone.
    expect(await page.locator('.sentence select').evaluateAll((all) => all.every((e) => e.getBoundingClientRect().left >= 0 && e.getBoundingClientRect().right <= document.documentElement.clientWidth))).toBe(true);
    const sentenceRows = await page.locator('.sentence select').evaluateAll((all) => new Set(all.map((e) => Math.round(e.getBoundingClientRect().top))).size);
    if (onAPhone) expect(sentenceRows).toBeGreaterThan(1);
    else expect(sentenceRows).toBe(1);

    // The first tile opens each rule that forced a full run; the wide table scrolls inside its panel on a phone.
    await page.locator('.tile').filter({ hasText: 'Ran more than needed' }).getByRole('link', { name: 'Which rules' }).click();
    await expect(page).toHaveURL(/[?&]group=rule(&|$)/);
    await expect(choice(page, 'Rows')).toHaveValue('rule');
    const rules = page.getByRole('region', { name: 'Ran more than needed: what forced a full run' });
    await expect(rules).toBeVisible();
    expect(await rules.locator('.table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(onAPhone);
    expect(await noSidewaysScroll()).toBe(true);

    // A rule opens its paths, and a pull request opens from them: what changed, each package's mode, and what ran.
    await rules.getByRole('link', { name: 'owned by no concept' }).click();
    const paths = page.getByRole('region', { name: /E2E job: owned by no concept/ });
    await expect(paths).toContainText('apps/api/src/b.ts');
    await paths.getByRole('link', { name: '#9102' }).click();
    await expect(page).toHaveURL(/[?&]pr=9102(&|$)/);
    const drill = page.getByRole('region', { name: /#9102 Save a Teams message/ });
    await expect(drill).toContainText('Ran everything: 2 of 40 specs run');
    expect(await noSidewaysScroll()).toBe(true);

    // The period and the job keep that pull request; choosing a row leaves it behind.
    await choose(page, 'Job', 'the E2E job', /[?&]job=e2e(&|$)/);
    await expect(page).toHaveURL(/[?&]pr=9102(&|$)/);
    await expect(drill).not.toContainText('Test job');
    await expect(drill).toContainText('E2E job');

    // Each test skipped, then failed on main: a row each, newest first, the pull request that skipped it and where it ran no tests, each with its own Copy prompt held in the page and not shown.
    await choose(page, 'Job', 'both jobs', /[?&]job=both(&|$)/);
    await choose(page, 'Rows', 'each test skipped, then failed on main', /[?&]group=miss(&|$)/);
    await expect(drill).toHaveCount(0);
    const misses = page.getByRole('region', { name: 'Tests that were skipped, then failed on main' });
    await expect(misses.getByRole('row')).toHaveCount(3);
    const flaky = misses.getByRole('row').filter({ hasText: 'flaky.test.ts' });
    const capture = misses.getByRole('row').filter({ hasText: 'capture.test.ts' });
    await expect(flaky).toContainText('#9101 Add a filter panel');
    await expect(capture).toContainText('it changed only documents, so it ran no tests');
    await expect(flaky.locator('pre')).toBeHidden();
    await expect(flaky.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    expect(await misses.locator('.table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(onAPhone);
    expect(await noSidewaysScroll()).toBe(true);

    // Clicking it puts that row's prompt on the clipboard, says Copied for a moment, and then offers it again.
    await capture.getByRole('button', { name: 'Copy prompt' }).click();
    await expect(capture.getByRole('button')).toHaveText('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('tests/e2e/capture.test.ts (e2e, E2E job) failed on main');
    expect(copied).toContain('#9103 "Tidy the docs"');
    expect(copied).toContain('its change being documentation only');
    expect(copied).not.toContain('flaky.test.ts');
    await expect(capture.getByRole('button')).toHaveText('Copy prompt');

    // The old row's address, each pull request, reads each day.
    await page.goto(`${monitor}/selection?group=pr`);
    await expect(choice(page, 'Rows')).toHaveValue('day');
    await expect(page.locator('.tile')).toHaveCount(2);
  });

  test("Test selection's rules that forced a full run sit in three groups, and Copy prompt on a rule to fix puts its prompt on the clipboard, with no prompt shown, on a desk and a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    // Merged long before the 14 days the Test selection walk counts, so that walk's pull requests stay the only ones it sees; this one reads every pull request held.
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString(); // clock-ok: the page reads the Worker's own clock, which the walk cannot inject
    const job = (name: 'test' | 'e2e', over: Record<string, unknown>) => ({ job: name, status: 'ran', ranEverything: false, selecting: true, filesRun: 1, filesTotal: 40, prDurationMs: null, mainDurationMs: null, changedFiles: [{ path: 'apps/api/src/b.ts', ignored: false }], packages: [], ...over });
    const everySpec = (rule: string, path: string) =>
      job('e2e', { ranEverything: true, selecting: false, filesRun: 32, filesTotal: 32, packages: [{ name: 'e2e', dir: 'tests/e2e', mode: 'full', report: 'written', reason: { rule, path }, filesTotal: 32, files: [] }] });
    const pull = (number: number, title: string, days: number, e2e: unknown) => ({ number, title, url: `https://github.com/o/r/pull/${number}`, mergedAt: daysAgo(days), jobs: [job('test', {}), e2e], misses: [] });
    const pulls = [
      pull(9201, 'Add a settings page', 45, everySpec('spec with no area', 'tests/e2e/settings.test.ts')),
      pull(9202, 'Update the lockfile', 46, everySpec('lockfile', 'pnpm-lock.yaml')),
    ];
    const bars = { windowDays: 14, minPulls: 20, items: [{ id: 'e2e-forced-full', name: 'E2E forced to run every spec', threshold: 0.25, minOver: null, alarmIssue: null }, { id: 'test-forced-full', name: 'Test forced to run everything', threshold: 0.25, minOver: null, alarmIssue: null }, { id: 'misses', name: 'Misses', threshold: 1, minOver: null, alarmIssue: null }, { id: 'most-selected', name: 'A test selected on nearly every pull request', threshold: 0.8, minOver: 10, alarmIssue: null }] };
    expect((await api.post(`${monitor}/__e2e/seed-selection`, { data: { pulls, bars } })).ok()).toBe(true);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(monitor!).origin });
    const noSideways = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.goto(`${monitor}/selection?group=rule&period=all`);
    const rules = page.getByRole('region', { name: 'Ran more than needed: what forced a full run' });
    await expect(rules).toBeVisible();

    // The rule to fix sits under its own heading, above the expected one, and only it offers Copy prompt; the prompt is in the page and not shown.
    const ruleRow = (name: string) => rules.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
    const toFix = ruleRow('spec with no area');
    const expected = ruleRow('lockfile');
    const top = async (target: Locator) => (await target.boundingBox())!.y;
    const order = [rules.locator('tr.tier th', { hasText: 'Rules to fix' }), toFix, rules.locator('tr.tier th', { hasText: 'Expected: they force a full run by design' }), expected];
    const tops = [];
    for (const each of order) tops.push(await top(each));
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    await expect(toFix.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    await expect(expected.getByRole('button')).toHaveCount(0);
    await expect(toFix.locator('pre')).toBeHidden();
    expect(await noSideways()).toBe(true);

    // Clicking it puts the prompt on the clipboard, says Copied for a moment, and then offers it again.
    await toFix.getByRole('button', { name: 'Copy prompt' }).click();
    await expect(toFix.getByRole('button')).toHaveText('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('forced by the rule "spec with no area" in scripts/lib/e2e-selection.mjs');
    expect(copied).toContain('- tests/e2e/settings.test.ts: 1 pull request (#9201)');
    expect(copied).toContain('Scope the fix with /scoping before building it.');
    await expect(toFix.getByRole('button')).toHaveText('Copy prompt');
  });

  test('Test coverage opens from the top bar, drills through the Area filter, each gap offers neither tiles nor a Level filter, the four filters sit in one row on a desk and two to a row on a phone, a phone scrolls the tree inside its panel, and picking a pull request in the sentence shows its own tests with the rows and filters kept and the open panel closed', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const rule = (concept: string, statement: string, level: string, file: string, line: number) => ({ concept, statement, level, file, line, cases: [], todoCases: [] });
    const area = (key: string, rules: ReturnType<typeof rule>[], children: unknown[] = []) => ({
      key,
      label: key,
      counts: { L1: rules.filter((r) => r.level === 'L1').length, F3: rules.filter((r) => r.level === 'F3').length, Contract: null },
      rules,
      branchesNothingTakes: null,
      children,
    });
    const tree = {
      commit: 'abc1234',
      commitUrl: null,
      generatedAt: '2026-10-24T03:00:00.000Z',
      coverageAvailable: false,
      availableLevels: { L3: false },
      warnings: [],
      tree: [
        area('Workspaces', [], [
          area('Inbox', [rule('Inbox', 'A dismissed item leaves the lists', 'L1', 'apps/api/tests/unit/triage.test.ts', 10), rule('Inbox', 'Capturing works in a browser', 'F3', 'tests/e2e/capture.test.ts', 10)], [
            area('Capture', [rule('Capture', 'A captured thought lands in the inbox', 'F3', 'tests/e2e/capture.test.ts', 40), rule('Capture', 'A capture made offline arrives once', 'F3', 'tests/e2e/capture.test.ts', 70)]),
          ]),
        ]),
        area('Offline', [rule('Offline', 'A change replayed after reconnecting is applied once', 'L1', 'apps/web/tests/unit/offline.test.ts', 5)]),
      ],
    };
    expect((await api.post(`${monitor}/__e2e/seed-tests`, { data: { tree } })).ok()).toBe(true);
    // An open pull request's own tests, at its own commit, with an area main does not have.
    const ofPullRequest = { ...tree, commit: 'def5678', tree: [area('Sharing', [rule('Sharing', 'A shared workspace shows its owner', 'L1', 'apps/api/tests/unit/sharing.test.ts', 4)])] };
    expect((await api.post(`${monitor}/__e2e/seed-tests`, { data: { tree: ofPullRequest, snapshot: 'pr-9201' } })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const noSidewaysScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    // From the costs page, the top bar's own tab opens it on each concept area, with the tiles an overview has.
    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Test coverage', exact: true }).click();
    await expect(choice(page, 'Rows')).toHaveValue('area');
    await expect(choice(page, 'Count by')).toHaveValue('level');
    await expect(page.locator('.tile')).toHaveCount(5);

    // The four filters share one row on a desk and sit two to a row on a phone; the page never scrolls sideways, and the tree scrolls inside its panel on a phone.
    const tops = await page.locator('.only select').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    expect(tops).toHaveLength(4);
    expect(Math.max(...[...new Set(tops)].map((top) => tops.filter((t) => t === top).length))).toBe(onAPhone ? 2 : 4);
    expect(await noSidewaysScroll()).toBe(true);
    if (onAPhone) expect(await page.getByRole('region', { name: 'Every area' }).locator('.table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    // Drill into Inbox through the Area filter: the tree starts at it, and the breadcrumb names the area above.
    await choose(page, 'Area', 'Inbox', /[?&]node=Inbox(&|$)/);
    await expect(page.getByRole('navigation', { name: 'Area' })).toHaveText('All areas›Workspaces›Inbox');
    await expect(page.getByRole('region', { name: 'Inbox, area by area' })).toBeVisible();
    expect(await noSidewaysScroll()).toBe(true);

    // Each gap has no tiles, no Level filter and no Count by, and its files read unknown on a snapshot without coverage.
    await choose(page, 'Rows', 'each gap', /[?&]group=gaps(&|$)/);
    await expect(page.locator('.tile')).toHaveCount(0);
    await expect(page.getByRole('region', { name: /^Files to test next/ })).toContainText('Unknown, not none');
    await expect(choice(page, 'Level')).toHaveCount(0);
    await expect(choice(page, 'Count by')).toHaveCount(0);

    // Back on each concept area, main's, with a panel open and a Package filter: picking the pull request shows its own tree at its own commit, without Inbox, which it does not have, the rows and the filter kept, and the panel closed.
    await choose(page, 'Rows', 'each concept area', /[?&]group=area(&|$)/);
    await choose(page, 'Package', 'apps/api', /[?&]package=api(&|$)/);
    await page.goto(`${page.url()}&tests=Inbox%7E%7E`);
    await expect(page.locator('#pane').getByRole('heading', { level: 2 })).toContainText('Inbox');
    const picker = choice(page, 'Tests of');
    await expect(picker).toHaveValue('');
    await picker.selectOption({ label: '#9201' });
    await expect(page).toHaveURL(/[?&]pr=9201(&|$)/);
    expect(new URL(page.url()).searchParams.has('tests')).toBe(false);
    await expect(choice(page, 'Package')).toHaveValue('api');
    await expect(choice(page, 'Rows')).toHaveValue('area');
    await expect(page.locator('.stamp')).toContainText('at def5678');
    const every = page.getByRole('region', { name: 'Every area' });
    await expect(every.getByRole('link', { name: 'Sharing', exact: true })).toBeVisible();
    await expect(every.getByRole('link', { name: 'Inbox', exact: true })).toHaveCount(0);
    expect(await noSidewaysScroll()).toBe(true);
  });

  test("Test coverage opens an area's tests in a panel beside the table that changes alone: a count far down leaves the table where it is and starts the panel at its top, its tabs and Back follow the address, a case's source loads when it is opened, a failed fetch loads the address in full, and the table fits beside the panel from 1,300px, below which the panel sits above the table and a click scrolls it into view", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const names = Array.from({ length: 24 }, (_, i) => `Area ${String(i + 1).padStart(2, '0')}`);
    const unit = (name: string) => `apps/api/tests/unit/${name.toLowerCase().replace(' ', '-')}.test.ts`;
    const rule = (name: string, statement: string, level: string, file: string, line: number) => ({
      concept: name,
      statement,
      level,
      file,
      line,
      cases: [{ text: `${statement}, in one case`, file, line: line + 2 }],
      todoCases: [],
    });
    const area = (name: string, i: number) => ({
      key: name,
      label: name,
      counts: { L1: 1, F3: 1, Contract: null },
      rules: [rule(name, `${name} holds`, 'L1', unit(name), 10), rule(name, `${name} works in a browser`, 'F3', 'tests/e2e/capture.test.ts', 10 + i * 30)],
      statements: [{ file: `apps/api/src/${name.toLowerCase().replace(' ', '-')}.ts`, total: 100, covered: 30 + i * 2, uncovered: ['10-60'] }],
      branchesNothingTakes: [{ file: `apps/api/src/${name.toLowerCase().replace(' ', '-')}.ts`, line: 7 }],
      children: [],
    });
    const tree = {
      commit: 'abc1234',
      commitUrl: 'https://github.com/o/r/commit/abc1234',
      generatedAt: '2026-10-24T03:00:00.000Z',
      coverageAvailable: true,
      availableLevels: { L3: false },
      warnings: [],
      tree: [{ key: 'Workspaces', label: 'Workspaces', counts: { L1: 0, F3: 0, Contract: null }, rules: [], statements: [], branchesNothingTakes: [], children: names.map(area) }],
    };
    // Area 20's rule has its source stored, around line 10; the case two lines below it has none.
    const around = [{ line: 9, text: '  // above' }, { line: 10, text: "  describe('Area 20 holds', () => {" }, { line: 11, text: '  // below' }];
    expect((await api.post(`${monitor}/__e2e/seed-tests`, { data: { tree, areas: { 'Area 20': { [`${unit('Area 20')}:10`]: around } } } })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
    const noSidewaysScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    const table = page.getByRole('region', { name: 'Every area' });
    const pane = page.locator('#pane');
    const boxOf = async (target: ReturnType<Page['locator']>) => (await target.boundingBox())!;
    const sources: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/tests/source') sources.push(r.url());
    });

    // A desk opens it at 1,333px: Workspaces' count of every rule inside it opens beside the table, the table fitting without scrolling sideways. A phone has the panel under the table.
    if (!onAPhone) await page.setViewportSize({ width: 1333, height: 800 });
    await page.goto(`${monitor}/tests`);
    await expect(pane).toContainText('Pick an area, or any count');
    await table.getByRole('row', { name: /^Workspaces/ }).locator('td').nth(8).getByRole('link').click();
    await expect(pane.getByRole('heading', { level: 2 })).toContainText('Workspaces');
    await expect(pane.locator('.pane-rule')).toHaveCount(48);
    const asideBox = await boxOf(pane);
    const tableBox = await boxOf(table.locator('.table'));
    if (onAPhone) expect(asideBox.y + asideBox.height).toBeLessThanOrEqual(tableBox.y + 1);
    else {
      expect(asideBox.x).toBeGreaterThanOrEqual(tableBox.x + tableBox.width - 1);
      expect(asideBox.y).toBeLessThan(tableBox.y + tableBox.height);
      expect(await table.locator('.table').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    expect(await noSidewaysScroll()).toBe(true);

    // A count far down the table: on a desk the page does not move; stacked above the table, the panel is scrolled into view. Either way it shows that count's rules from its top, though the panel before it was scrolled.
    const heading = pane.getByRole('heading', { level: 2 });
    const far = table.getByRole('row', { name: /^Area 20/ });
    await far.scrollIntoViewIfNeeded();
    await pane.locator('.pane-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
    const before = await scrollY();
    expect(before).toBeGreaterThan(0);
    await far.locator('td').nth(6).getByRole('link').click();
    await expect(page).toHaveURL(/[?&]tests=Area\+20%7EF3%7E(&|$)/);
    await expect(pane.getByRole('heading', { level: 2 })).toContainText('Area 20');
    await expect(pane.locator('.pane-rule')).toHaveCount(1);
    if (onAPhone) await expect(heading).toBeInViewport();
    else expect(await scrollY()).toBe(before);
    expect(await pane.locator('.pane-body').evaluate((el) => el.scrollTop)).toBe(0);
    await expect(far).toHaveClass(/selected/);

    // Its Files tab: the table does not move on a desk, the stacked panel stays in view, and the address names the tab.
    await pane.getByRole('link', { name: /^Files/ }).click();
    await expect(page).toHaveURL(/[?&]pane=files(&|$)/);
    await expect(pane.locator('.pane-files li')).toHaveCount(1);
    await expect(pane.locator('.pane-files')).toContainText('apps/api/src/area-20.ts');
    if (onAPhone) await expect(heading).toBeInViewport();
    else expect(await scrollY()).toBe(before);

    // Back returns the previous panel, the table where it was.
    await page.goBack();
    await expect(page).not.toHaveURL(/pane=files/);
    await expect(pane.getByRole('link', { name: /^Rules/ })).toHaveAttribute('aria-current', 'page');
    await expect(pane.locator('.pane-rule')).toHaveCount(1);
    if (onAPhone) await expect(heading).toBeInViewport();
    else expect(await scrollY()).toBe(before);

    // The area's name opens every rule of it, and a case's place opens the source around it, read once, when it is opened.
    await far.getByRole('link', { name: 'Area 20', exact: true }).click();
    await expect(pane.locator('.pane-rule')).toHaveCount(2);
    expect(sources).toEqual([]);
    const place = pane.locator('details.code').first();
    await place.locator('summary').press('Enter');
    await expect(place.locator('pre .hit')).toContainText("describe('Area 20 holds'");
    expect(sources).toHaveLength(1);
    expect(sources[0]).toContain('area=Area%2020');
    // Opening it moves nothing on a desk.
    if (!onAPhone) expect(await scrollY()).toBe(before);

    // A fetch that fails loads the address in full.
    await page.route(/\/tests\?tests=Area\+21/, (route) => route.abort(), { times: 1 });
    await table.getByRole('row', { name: /^Area 21/ }).getByRole('link', { name: 'Area 21', exact: true }).click();
    await expect(page).toHaveURL(/[?&]tests=Area\+21%7E%7E(&|$)/);
    await expect(pane.getByRole('heading', { level: 2 })).toContainText('Area 21');

    // Below 1,300px the panel is above the table on a desk too, a count far down brings it into view, and the page still does not scroll sideways.
    if (!onAPhone) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${monitor}/tests`);
      const lower = table.getByRole('row', { name: /^Area 22/ });
      await lower.scrollIntoViewIfNeeded();
      await lower.locator('td').nth(6).getByRole('link').click();
      await expect(heading).toContainText('Area 22');
      await expect(heading).toBeInViewport();
      const stacked = await boxOf(pane);
      const below = await boxOf(table.locator('.table'));
      expect(stacked.y + stacked.height).toBeLessThanOrEqual(below.y + 1);
      expect(await noSidewaysScroll()).toBe(true);

      // Closing it, with nothing to show, does not scroll the page.
      const open = await scrollY();
      await pane.getByRole('link', { name: 'Close the panel' }).click();
      await expect(pane).toBeHidden();
      const furthest = await page.evaluate(() => Math.round(document.documentElement.scrollHeight - window.innerHeight));
      expect(await scrollY()).toBe(Math.min(open, furthest));
    }
  });

  test("Test coverage copies a prompt to the clipboard from Gaps' picked files, offered once one is picked, or from an area's spark icon, which opens nothing, moves nothing and shows without pointing on a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    // Seven files under 80%: Panels owns parts 1 to 4, Layouts 5 to 7; part 1 has the most statements no test runs.
    const files = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i).map((n) => ({ file: `apps/web/src/part-${n}.ts`, total: 100, covered: n * 10, uncovered: [`${n}-${n + 40}`] }));
    const area = (key: string, statements: unknown[], children: unknown[] = []) => ({
      key,
      label: key,
      counts: { L1: 1, F3: 0, Contract: null },
      rules: [{ concept: key, statement: `${key} holds`, level: 'L1', file: `apps/web/tests/unit/${key.toLowerCase()}.test.ts`, line: 10, cases: [], todoCases: [] }],
      statements,
      branchesNothingTakes: [],
      children,
    });
    const tree = {
      commit: 'abc1234',
      commitUrl: 'https://github.com/o/r/commit/abc1234',
      generatedAt: '2026-10-24T03:00:00.000Z',
      coverageAvailable: true,
      availableLevels: { L3: false },
      warnings: [],
      tree: [area('Dashboards', [], [area('Panels', files(1, 4)), area('Layouts', files(5, 7))])],
    };
    expect((await api.post(`${monitor}/__e2e/seed-tests`, { data: { tree } })).ok()).toBe(true);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(monitor!).origin });
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    // Gaps with nothing picked offers no copy; Pick the top 5 counts them on the button, and Copy puts a prompt naming those five on the clipboard.
    await page.goto(`${monitor}/tests?group=gaps`);
    const copy = page.locator('#gap-copy');
    await expect(copy).toHaveText('Copy prompt');
    await expect(copy).toBeDisabled();
    await page.getByRole('button', { name: 'Pick the top 5' }).click();
    await expect(copy).toHaveText('Copy prompt for 5 files');
    await expect(page.locator('input.pick:checked')).toHaveCount(5);
    await copy.click();
    await expect(page.locator('#gap-status')).toHaveText('Copied. Paste it into a new Claude Code session.');
    const picked = (await clipboard()).split(/\r?\n/).filter((l) => l.startsWith('- apps/'));
    expect(picked).toEqual([1, 2, 3, 4, 5].map((n) => `- apps/web/src/part-${n}.ts (${n * 10}% of statements run; area: ${n <= 4 ? 'Panels' : 'Layouts'}): lines ${n}-${n + 40}`));

    // On Concept area with Panels' panel open, its row's spark shows without pointing; another row's shows only on a phone, where nothing points.
    await page.goto(`${monitor}/tests?tests=Panels%7E%7E`);
    const table = page.getByRole('region', { name: 'Every area' });
    const pane = page.locator('#pane');
    const spark = (name: string) => table.getByRole('button', { name: `Suggest tests for ${name}` });
    const opacity = (target: Locator) => target.evaluate((el) => getComputedStyle(el).opacity);
    expect(await opacity(spark('Panels'))).toBe('1');
    expect(await opacity(spark('Layouts'))).toBe(onAPhone ? '1' : '0');

    // The spark puts Panels' analysis prompt on the clipboard and says so, while the address, the panel, the table and the page stay where they were.
    await spark('Panels').scrollIntoViewIfNeeded();
    const before = { url: page.url(), y: await page.evaluate(() => Math.round(window.scrollY)), pane: await pane.boundingBox(), table: await table.boundingBox() };
    await spark('Panels').click();
    await expect(spark('Panels')).toHaveClass(/done/);
    await expect(page.locator('#ask-said')).toHaveText('Copied the prompt for Panels. Paste it into a new Claude Code session.');
    const asked = await clipboard();
    expect(asked).toMatch(/^Analyse the test coverage of the "Panels" area of Cockpit \(Dashboards › Panels\), and suggest the tests worth adding\./);
    expect(asked).toContain('  - apps/web/src/part-1.ts (10% run, 90 of 100 statements not run): lines 1-41');
    expect({ url: page.url(), y: await page.evaluate(() => Math.round(window.scrollY)), pane: await pane.boundingBox(), table: await table.boundingBox() }).toEqual(before);
    await expect(pane.getByRole('heading', { level: 2 })).toContainText('Panels');
  });

  test('the page is drawn in Inter, which the Monitor serves itself', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    expect((await api.post(`${monitor}/__e2e/seed`, { data: SEED })).ok()).toBe(true);
    const fonts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'font') fonts.push(new URL(request.url()).origin);
    });

    await page.goto(`${monitor}/`);

    await expect.poll(() => page.evaluate(() => document.fonts.check("15px 'Inter Variable'") && [...document.fonts].some((f) => f.family.includes('Inter') && f.status === 'loaded'))).toBe(true);
    expect(fonts).toEqual([new URL(monitor!).origin]);
  });

  test("from the costs page, Cockpit's Claude calls opens, choosing each feature drops a Feature filter and recolours, and choosing each pull request keeps CI: the pull requests with their links, the filters in a row on a desk and two to a row on a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    expect((await api.post(`${monitor}/__e2e/seed`, { data: SEED })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: /Cockpit.s Claude calls/ }).click();
    await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: /Cockpit.s Claude calls/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('img', { name: /^Cost per day/ })).toBeVisible();
    await expect(choice(page, 'Rows')).toHaveValue('day');
    await expect(choice(page, 'Colours')).toHaveValue('environment');

    // Coloured by feature, with the Feature filter set and Environment: CI chosen after it.
    await choose(page, 'Colours', 'feature', /[?&]split=feature(&|$)/);
    await choose(page, 'Feature', 'Clean up a note', /[?&]feature=clean-up-a-note(&|$)/);
    await choose(page, 'Environment', 'CI', /[?&]environment=ci(&|$)/);

    // Each feature lists every feature: the Feature filter is gone, coloured by feature falls back to environment and is offered but disabled, and CI is kept.
    await choose(page, 'Rows', 'each feature', /[?&]group=feature(&|$)/);
    await expect(choice(page, 'Feature')).toHaveCount(0);
    await expect(choice(page, 'Colours')).toHaveValue('environment');
    await expect(choice(page, 'Colours').locator('option[value="feature"]')).toBeDisabled();
    await expect(choice(page, 'Environment')).toHaveValue('ci');

    // Each pull request keeps CI: a row a pull request with the contract runs on it.
    await choose(page, 'Rows', 'each pull request', /[?&]group=pr(&|$)/);
    await expect(choice(page, 'Environment')).toHaveValue('ci');

    const table = page.getByRole('region', { name: 'Calls by pull request' });
    const filed = table.getByRole('row', { name: /#9001 Add a filter panel/ });
    await expect(filed).toContainText('2 contract runs');
    await expect(filed).toContainText('$0.75');
    await expect(filed.getByRole('link', { name: /#9001 Add a filter panel/ })).toHaveAttribute('href', /github\.com\/.+\/pull\/9001$/);
    await expect(filed.getByRole('link', { name: 'Sessions' })).toHaveAttribute('href', '/pr/9001');
    await expect(table.getByRole('row', { name: /#9002 Save a Teams message/ })).toContainText('1 contract run');
    await expect(table.getByRole('row', { name: /Nightly and by-hand runs on main/ })).toContainText('$0.10');
    await expect(table.getByRole('row', { name: /No pull request/ })).toHaveCount(0);

    // The three filters: one row on a desk, two to a row on a phone, and the page never scrolls sideways.
    const fields = await page.locator('.only select').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    const perRow = [...new Set(fields)].map((top) => fields.filter((t) => t === top).length);
    expect(fields).toHaveLength(3);
    expect(perRow).toEqual(onAPhone ? [2, 1] : [3]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Sessions leads to the Monitor's own page for the pull request.
    await filed.getByRole('link', { name: 'Sessions' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /#9001 Add a filter panel/ })).toBeVisible();
  });

  test('pointing at or focusing a line of a per-day chart, or its key, keeps that line at full strength and fades the others, and the total never fades', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    expect((await api.post(`${monitor}/__e2e/seed`, { data: SEED })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    await page.goto(`${monitor}/`);

    // Three phases cost something in the seed: Building, After push and CI reviews, and the total.
    const chart = page.getByRole('region', { name: 'Cost per day' });
    const line = (key: string) => chart.locator(`.lines > g[data-line="${key}"]`);
    const keyOf = (name: string) => chart.locator('.legend .key', { hasText: name });
    const opacities = () => Promise.all(['building', 'after-push', 'ci-reviews', 'total'].map((key) => line(key).evaluate((g) => getComputedStyle(g).opacity)));
    const FADED = '0.15';
    // A desk points; a phone has no pointer to leave on a key, so it taps, which also focuses it.
    const pointAt = (target: ReturnType<typeof keyOf>) => (onAPhone ? target.tap() : target.hover());
    const moveOff = async () => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await (onAPhone ? page.locator('body').tap({ position: { x: 1, y: 1 } }) : page.mouse.move(1, 1));
    };

    // Nothing is picked out at rest.
    await expect.poll(opacities).toEqual(['1', '1', '1', '1']);

    // A key picks its line out: the others fade, and the total, drawn dashed, does not.
    await pointAt(keyOf('After push'));
    await expect.poll(opacities).toEqual([FADED, '1', FADED, '1']);

    // Moving off the chart brings every line back.
    await moveOff();
    await expect.poll(opacities).toEqual(['1', '1', '1', '1']);

    // On a desk the line itself picks too, by its point on the day it cost something (every line sits on the baseline the days before).
    if (!onAPhone) {
      await line('ci-reviews').locator('circle').last().hover();
      await expect.poll(opacities).toEqual([FADED, FADED, '1', '1']);
      await moveOff();
      await expect.poll(opacities).toEqual(['1', '1', '1', '1']);
    }

    // The keyboard reaches the keys in turn, each picks its line out and shows its focus ring.
    await keyOf('Building').focus();
    await page.keyboard.press('Tab');
    await expect(keyOf('After push')).toBeFocused();
    await expect.poll(opacities).toEqual([FADED, '1', FADED, '1']);
    expect(await keyOf('After push').evaluate((key) => getComputedStyle(key).outlineStyle)).not.toBe('none');
    await moveOff();
    await expect.poll(opacities).toEqual(['1', '1', '1', '1']);

    // Tokens per day picks its lines out the same way, and picking in one chart leaves the other whole.
    const tokens = page.getByRole('region', { name: 'Tokens per day' });
    await pointAt(tokens.locator('.legend .key', { hasText: 'Building' }));
    await expect(tokens.locator('.lines > g[data-line="after-push"]')).toHaveCSS('opacity', FADED);
    await expect(tokens.locator('.lines > g[data-line="total"]')).toHaveCSS('opacity', '1');
    await expect(line('after-push')).toHaveCSS('opacity', '1');
  });
});
