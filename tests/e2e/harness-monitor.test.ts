import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
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
  /** A grouping's tab on the band of a page that has them, such as Cockpit's Claude calls. */
  const tabOn = (page: Page) => (name: string) => page.getByRole('navigation', { name: 'Group by' }).getByRole('link', { name, exact: true });
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
    await expect(page.getByText('billed through claude.ai, and is not measured')).toBeVisible();
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

  test('the sentence stays on screen as the page scrolls, on a desk and on a phone, and the page is dark on a dark device', async ({ page, request: api }) => {
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

    // The ground is Cockpit's warm grey, and the selects and ground take their dark values when the device is dark.
    const colours = () => page.evaluate(() => [document.body, document.querySelector('.sentence select')!].map((e) => getComputedStyle(e).backgroundColor));
    expect(await colours()).toEqual(['rgb(226, 226, 223)', 'rgb(255, 255, 255)']);
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await colours()).toEqual(['rgb(35, 36, 42)', 'rgb(20, 21, 25)']);
  });

  test('CI stability opens from the top bar, its tabs and the Workflow filter narrow it, the filters sit in one row on a desk, and a phone scrolls the wide tables inside their panels', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString(); // clock-ok: the page reads the Worker's own clock, which the walk cannot inject
    const run = (id: number, workflow: string, hours: number, failed: { job: string; step: string } | null) => ({
      id,
      workflow,
      path: `.github/workflows/${workflow.toLowerCase()}.yml`,
      status: 'completed',
      conclusion: failed ? 'failure' : 'success',
      outcome: failed ? 'fail' : 'pass',
      headSha: 'c'.repeat(40),
      createdAt: hoursAgo(hours),
      url: `https://github.com/o/r/actions/runs/${id}`,
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
          url: `https://github.com/o/r/actions/runs/${id}/job/1`,
          steps: [{ number: 1, name: failed?.step ?? 'Run the tests', occurrence: 1, conclusion: failed ? 'failure' : 'success', startedAt: hoursAgo(hours), completedAt: hoursAgo(hours), durationMs: 60_000 }],
        },
      ],
    });
    const runs = [
      run(9_001_001, 'CI', 50, null),
      run(9_001_002, 'CI', 40, { job: 'Test', step: 'Run the tests' }),
      run(9_001_003, 'CI', 30, null),
      run(9_001_004, 'Nightly', 5, { job: 'Test explorer', step: 'Build the snapshot' }),
    ];
    expect((await api.post(`${monitor}/__e2e/seed-stability`, { data: { runs } })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    // From the costs page, the top bar's own tab opens it on the Job tab, with the tiles an overview has.
    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'CI stability' }).click();
    const band = page.getByRole('navigation', { name: 'Group by' });
    await expect(band.getByRole('link', { name: 'Job', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(band.getByRole('link')).toHaveText(['Job', 'Workflow', 'Red spells', 'Failures', 'Over time']);
    await expect(page.getByRole('region', { name: 'How every job run ended' })).toBeVisible();
    // While Nightly is red, the line says so on this tab and on the next.
    await expect(page.getByRole('status').filter({ hasText: 'Nightly is red now' })).toContainText('Build the snapshot');

    // The filters share one row on a desk; the page never scrolls sideways, and the wide table scrolls inside its panel.
    const tops = await page.locator('.filters .field').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    expect(tops).toHaveLength(3);
    if (!onAPhone) expect(new Set(tops).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const byJob = page.getByRole('region', { name: 'By job' }).locator('.table');
    expect(await byJob.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(onAPhone);

    // Failures lists where both workflows died; choosing Workflow: CI keeps the tab and leaves only CI's failure.
    await band.getByRole('link', { name: 'Failures' }).click();
    const died = page.getByRole('region', { name: 'Where they died' });
    await expect(died.getByRole('row')).toHaveCount(3);
    await expect(page.getByRole('status').filter({ hasText: 'Nightly is red now' })).toBeVisible();
    await page.getByLabel('Workflow', { exact: true }).selectOption('CI');
    await expect(page).toHaveURL(/[?&]workflow=CI(&|$)/);
    await expect(page).toHaveURL(/[?&]group=failures(&|$)/);
    await expect(band.getByRole('link', { name: 'Failures' })).toHaveAttribute('aria-current', 'page');
    await expect(died.getByRole('row')).toHaveCount(2);
    await expect(died).toContainText('Run the tests');
    await expect(died).not.toContainText('Build the snapshot');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('Cycle time opens from the top bar, its tabs and the Rounds filter narrow it with the cost beside each pull request, Split by Harness re-cuts them, the filters sit in one row on a desk, and a phone scrolls the wide table inside its panel', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    expect((await api.post(`${monitor}/__e2e/seed`, { data: SEED })).ok()).toBe(true);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString(); // clock-ok: the page reads the Worker's own clock, which the walk cannot inject
    const check = (name: string, minutes: number, over: Record<string, unknown> = {}) => ({
      name,
      attempt: 1,
      heldMs: minutes * 60_000,
      last: true,
      failure: null,
      flukeMs: null,
      queuedMs: null,
      detailNotRecorded: false,
      noFileFailed: false,
      failedSteps: [],
      failedFiles: [],
      ...over,
    });
    const round = (checks: unknown[], red: boolean) => ({ sha: 'b'.repeat(40), pushedAt: hoursAgo(30), endedAt: hoursAgo(29), ms: 300_000, red, commits: 1, queueNotRecorded: false, checks });
    // 9001 and 9002 are the pull requests the seed priced, at $6.00 and $3.00; 9003 has no cost.
    const pull = (number: number, title: string, hours: number, rounds: unknown[]) => ({
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
      localReviews: { count: 2, ms: 300_000, byKind: { 'code-review': { count: 1, ms: 180_000 }, 'security-review': { count: 1, ms: 120_000 } } },
      localRuns: { test: null, browser: null },
      runnerMs: 0,
      cancelled: { superseded: { runs: 0, ms: 0 }, other: { runs: 0, ms: 0 } },
      rounds,
    });
    const pulls = [
      pull(9001, 'Add a filter panel', 20, [round([check('Test', 5)], false)]),
      pull(9002, 'Save a Teams message', 5, [round([check('Test', 5, { failure: 'red', failedSteps: ['Run the tests'] })], true), round([check('Test', 5)], false)]),
      pull(9003, 'Tidy the inbox', 70, [round([check('Test', 5)], false)]),
    ];
    expect((await api.post(`${monitor}/__e2e/seed-cycle-time`, { data: { pulls } })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    // From the costs page, the top bar's own tab opens it on Over time, with the tiles an overview has.
    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Cycle time' }).click();
    const band = tabOn(page);
    await expect(page.getByRole('navigation', { name: 'Group by' }).getByRole('link')).toHaveText(['Over time', 'Pull request', 'Issue', 'Size', 'Check']);
    await expect(band('Over time')).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.tile')).toHaveCount(4);
    await expect(page.getByRole('region', { name: /^Where the .* went$/ })).toBeVisible();

    // The filters share one row on a desk; the page never scrolls sideways.
    const tops = await page.locator('.filters .field').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    expect(tops).toHaveLength(4);
    if (!onAPhone) expect(new Set(tops).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Pull request: a row each with the cost the Monitor holds, which opens its Sessions; no tiles here.
    await band('Pull request').click();
    await expect(page.locator('.tile')).toHaveCount(0);
    const table = page.getByRole('region', { name: 'By pull request' });
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ })).toContainText('$6.00');
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ }).getByRole('link', { name: 'Sessions' })).toHaveAttribute('href', '/pr/9001');
    await expect(table.getByRole('row', { name: /#9003 Tidy the inbox/ })).not.toContainText('$');
    await expect(table.getByRole('row')).toHaveCount(4);
    const wide = page.locator('.well.table');
    if (onAPhone) expect(await wide.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    // Rounds: had a red round keeps the tab and the pull request that had one.
    await page.getByLabel('Rounds', { exact: true }).selectOption({ label: 'Had a red round' });
    await expect(page).toHaveURL(/[?&]outcome=red(&|$)/);
    await expect(page).toHaveURL(/[?&]group=pr(&|$)/);
    await expect(band('Pull request')).toHaveAttribute('aria-current', 'page');
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText('#9002 Save a Teams message');

    // Split by Harness re-cuts the same pull requests.
    await page.getByRole('button', { name: 'Harness' }).click();
    await expect(page).toHaveURL(/[?&]split=harness(&|$)/);
    await expect(page.getByRole('button', { name: 'Harness' })).toHaveAttribute('aria-pressed', 'true');
    await expect(table.getByRole('columnheader', { name: 'Security review' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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

  test("from the costs page, Cockpit's Claude calls opens, groups by pull request and narrows to CI: the pull requests with their links, the filters in a row on a desk and two to a row on a phone", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    expect((await api.post(`${monitor}/__e2e/seed`, { data: SEED })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: /Cockpit.s Claude calls/ }).click();
    await expect(page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: /Cockpit.s Claude calls/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('img', { name: /^Cost per day/ })).toBeVisible();

    await tabOn(page)('Pull request').click();
    await page.getByLabel('Environment', { exact: true }).selectOption('ci');
    await expect(page).toHaveURL(/environment=ci/);

    const table = page.getByRole('region', { name: 'Calls by pull request' });
    const filed = table.getByRole('row', { name: /#9001 Add a filter panel/ });
    await expect(filed).toContainText('2 contract runs');
    await expect(filed).toContainText('$0.75');
    await expect(filed.getByRole('link', { name: /#9001 Add a filter panel/ })).toHaveAttribute('href', /github\.com\/.+\/pull\/9001$/);
    await expect(filed.getByRole('link', { name: 'Sessions' })).toHaveAttribute('href', '/pr/9001');
    await expect(table.getByRole('row', { name: /#9002 Save a Teams message/ })).toContainText('1 contract run');
    await expect(table.getByRole('row', { name: /Nightly and by-hand runs on main/ })).toContainText('$0.10');
    await expect(table.getByRole('row', { name: /No pull request/ })).toHaveCount(0);

    // The four filters: one row on a desk, two to a row on a phone, and the page never scrolls sideways.
    const fields = await page.locator('.filters .field:has(select)').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    const perRow = [...new Set(fields)].map((top) => fields.filter((t) => t === top).length);
    expect(fields).toHaveLength(4);
    expect(perRow).toEqual(onAPhone ? [2, 2] : [4]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Sessions leads to the Monitor's own page for the pull request.
    await filed.getByRole('link', { name: 'Sessions' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /#9001 Add a filter panel/ })).toBeVisible();
  });
});
