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

  test('CI stability opens from the top bar, its sentence and the Workflow filter narrow it, choosing each workflow starts it in its own order with every workflow and no Workflow filter, Open in Actions follows the filter on a desk, and a phone scrolls the wide tables inside their panels', async ({ page, request: api }) => {
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

    // From the costs page, the top bar's own tab opens it on each job, with the tiles an overview has.
    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'CI stability' }).click();
    await expect(page.getByText('Show CI on main for')).toBeVisible();
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

    // Each failure lists where both workflows died, and has no order to choose; choosing Workflow: CI keeps the rows and leaves only CI's failure.
    await choose(page, 'Rows', 'each failure', /[?&]group=failures(&|$)/);
    await expect(choice(page, 'Order')).toHaveCount(0);
    const died = page.getByRole('region', { name: 'Where they died' });
    await expect(died.getByRole('row')).toHaveCount(3);
    await expect(page.getByRole('status').filter({ hasText: 'Nightly is red now' })).toBeVisible();
    await choose(page, 'Workflow', 'CI', /[?&]workflow=CI(&|$)/);
    await expect(page).toHaveURL(/[?&]group=failures(&|$)/);
    await expect(choice(page, 'Rows')).toHaveValue('failures');
    await expect(died.getByRole('row')).toHaveCount(2);
    await expect(died).toContainText('Run the tests');
    await expect(died).not.toContainText('Build the snapshot');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Each job, slowest first, with the Workflow filter still CI; then each workflow starts in its own order and lists every workflow, since a filter to one would repeat the rows.
    await choose(page, 'Rows', 'each job', /[?&]group=job(&|$)/);
    await choose(page, 'Order', 'slowest first', /[?&]sort=slowest(&|$)/);
    await expect(page).toHaveURL(/[?&]workflow=CI(&|$)/);
    await choose(page, 'Rows', 'each workflow', /[?&]group=workflow(&|$)/);
    expect(new URL(page.url()).searchParams.has('sort')).toBe(false);
    await expect(choice(page, 'Order')).toHaveValue('worst');
    await expect(choice(page, 'Workflow')).toHaveCount(0);
    const workflows = page.getByRole('region', { name: 'By workflow' });
    await expect(workflows.getByRole('row')).toHaveCount(3);
    await expect(workflows).toContainText('CI');
    await expect(workflows).toContainText('Nightly');
  });

  /**
   * The costs seed and three merged pull requests: 9001 and 9002 are the ones the seed priced, at $6.00 and $3.00; 9003 has no cost.
   * 9001 and 9003 had one round of Test, 9002 a red one then a green one, so its CI rounds are twice as long. 9001's round also ran E2E as four shards, 40 minutes of running in the 5 the round held.
   * None carries its local kinds.
   */
  async function seedCycleTime(api: APIRequestContext) {
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
      runningMs: minutes * 60_000,
      detailNotRecorded: false,
      noFileFailed: false,
      failedSteps: [],
      failedFiles: [],
      ...over,
    });
    const round = (checks: unknown[], red: boolean) => ({ sha: 'b'.repeat(40), pushedAt: hoursAgo(30), endedAt: hoursAgo(29), ms: 300_000, red, commits: 1, queueNotRecorded: false, checks });
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
      localReviews: { count: 2, ms: 300_000, byKind: null },
      localRuns: { test: null, browser: null },
      runnerMs: 0,
      cancelled: { superseded: { runs: 0, ms: 0 }, other: { runs: 0, ms: 0 } },
      rounds,
    });
    const pulls = [
      pull(9001, 'Add a filter panel', 20, [round([check('E2E (F3)', 5, { runningMs: 40 * 60_000 }), check('Test', 5)], false)]),
      pull(9002, 'Save a Teams message', 5, [round([check('Test', 5, { failure: 'red', failedSteps: ['Run the tests'] })], true), round([check('Test', 5)], false)]),
      pull(9003, 'Tidy the inbox', 70, [round([check('Test', 5)], false)]),
    ];
    expect((await api.post(`${monitor}/__e2e/seed-cycle-time`, { data: { pulls } })).ok()).toBe(true);
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
    page.on('request', (r) => requests.push(r.url()));

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

  test('Test selection opens from the top bar, its sentence and a pull request open what each job ran and why, choosing each package leaves the pull request and keeps the job, the longest sentence fits a desk and a phone, and a phone scrolls the wide table inside its panel', async ({ page, request: api }) => {
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
    const pull = (number: number, title: string, hours: number, jobs: unknown[]) => ({ number, title, url: `https://github.com/o/r/pull/${number}`, mergedAt: hoursAgo(hours), jobs, misses: [] });
    const everything = (name: 'test' | 'e2e', rule: string, path: string) =>
      job(name, { ranEverything: true, selecting: false, filesRun: 2, packages: [pkg(name === 'test' ? 'api' : 'e2e', 'full', [file('a.test.ts', { kind: 'full' }), file('b.test.ts', { kind: 'full' })], { rule, path })] });
    const docs = (name: 'test' | 'e2e') => job(name, { status: 'docs-only', selecting: false, filesRun: null, filesTotal: null, prDurationMs: null, mainDurationMs: null });
    const pulls = [
      pull(9101, 'Add a filter panel', 20, [
        job('test', { packages: [pkg('api', 'changed', [file(hot, { kind: 'chain', chain: [hot, 'apps/api/src/a.ts', 'apps/api/src/b.ts'], text: `${hot} → apps/api/src/a.ts → apps/api/src/b.ts` })])] }),
        job('e2e', {}),
      ]),
      pull(9102, 'Save a Teams message', 5, [everything('test', 'any tsconfig', 'tsconfig.json'), everything('e2e', 'owned by no concept', 'apps/api/src/b.ts')]),
      pull(9103, 'Tidy the docs', 70, [docs('test'), docs('e2e')]),
    ];
    const bars = {
      windowDays: 14,
      minPulls: 20,
      items: [
        { id: 'e2e-forced-full', name: 'E2E forced to run every spec', threshold: 0.25, minOver: null, alarmIssue: null },
        { id: 'test-forced-full', name: 'Test forced to run everything', threshold: 0.25, minOver: null, alarmIssue: null },
        { id: 'misses', name: 'Misses', threshold: 1, minOver: null, alarmIssue: null },
        { id: 'most-selected', name: 'A test selected on nearly every pull request', threshold: 0.8, minOver: 10, alarmIssue: null },
      ],
    };
    expect((await api.post(`${monitor}/__e2e/seed-selection`, { data: { pulls, bars } })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;
    const noSidewaysScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    // From the costs page, the top bar's own tab opens it on each day, with the four bars as tiles and no Only row.
    await page.goto(`${monitor}/`);
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Test selection' }).click();
    await expect(page.getByText('Show test selection for')).toBeVisible();
    await expect(choice(page, 'Rows')).toHaveValue('day');
    await expect(choice(page, 'Job')).toHaveValue('both');
    await expect(choice(page, 'Period')).toHaveValue('14d');
    await expect(page.locator('.only')).toHaveCount(0);
    await expect(page.locator('.tile')).toHaveCount(4);
    await expect(page.getByRole('region', { name: 'What each job did with 3 pull requests' })).toBeVisible();
    expect(await noSidewaysScroll()).toBe(true);

    // Each pull request: no tiles here, a row each, and the select for which pull requests under Only; the wide table scrolls inside its panel.
    await choose(page, 'Rows', 'each pull request', /[?&]group=pr(&|$)/);
    await expect(page.locator('.tile')).toHaveCount(0);
    const table = page.getByRole('region', { name: 'By pull request' });
    await expect(table.getByRole('row')).toHaveCount(4);
    await expect(page.locator('.only select')).toHaveCount(1);
    await expect(choice(page, 'Pull requests')).toBeVisible();
    expect(await table.locator('.table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(onAPhone);

    // Open one: what changed, each package's mode, and the files selected with the chain behind each.
    await table.getByRole('link', { name: /#9101 Add a filter panel/ }).click();
    await expect(page).toHaveURL(/[?&]pr=9101(&|$)/);
    await expect(page.getByLabel('Pull requests', { exact: true })).toHaveCount(0);
    const drill = page.getByRole('region', { name: /#9101 Add a filter panel/ });
    await expect(drill).toContainText('Selected a subset: 1 of 40 test files run');
    await expect(drill).toContainText(hot);
    await expect(drill).toContainText('via apps/api/src/a.ts → apps/api/src/b.ts');
    expect(await noSidewaysScroll()).toBe(true);

    // The E2E job keeps the rows and the pull request, and leaves only the E2E job.
    await choose(page, 'Job', 'the E2E job', /[?&]job=e2e(&|$)/);
    await expect(page).toHaveURL(/[?&]pr=9101(&|$)/);
    await expect(choice(page, 'Job')).toHaveValue('e2e');
    await expect(drill).not.toContainText('Test job');
    await expect(drill).toContainText('E2E job');

    // Each package starts its own rows: the pull request is left behind and the E2E job kept.
    await choose(page, 'Rows', 'each package', /[?&]group=package(&|$)/);
    await expect(choice(page, 'Job')).toHaveValue('e2e');
    await expect(drill).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'By package' })).toBeVisible();

    // The longest sentence, each rule that forced a full run, fits the band at this width: every select inside it, the page never scrolling sideways.
    await choose(page, 'Rows', 'each rule that forced a full run', /[?&]group=rule(&|$)/);
    expect(await page.locator('.sentence select').evaluateAll((all) => all.every((e) => e.getBoundingClientRect().left >= 0 && e.getBoundingClientRect().right <= document.documentElement.clientWidth))).toBe(true);
    // The sentence is one row of words on a desk and wraps on a phone.
    const sentenceRows = await page.locator('.sentence select').evaluateAll((all) => new Set(all.map((e) => Math.round(e.getBoundingClientRect().top))).size);
    if (onAPhone) expect(sentenceRows).toBeGreaterThan(1);
    else expect(sentenceRows).toBe(1);
    expect(await noSidewaysScroll()).toBe(true);

    // The rule opens its paths.
    await page.getByRole('link', { name: 'owned by no concept' }).click();
    await expect(page.getByRole('region', { name: /E2E job: owned by no concept/ })).toContainText('apps/api/src/b.ts');
    expect(await noSidewaysScroll()).toBe(true);
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

  test("Tests opens from the top bar, drills through the tree, opens a count's tests above it with the filters as they were, the four filters sit in one row on a desk and two to a row on a phone, a phone scrolls the tree inside its panel, and picking a pull request in the sentence shows its own tests with the rows and filters kept and the open rule closed", async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const rule = (concept: string, statement: string, level: string, file: string, line: number) => ({ concept, statement, level, file, line, cases: [], todoCases: [] });
    const area = (key: string, rules: ReturnType<typeof rule>[], children: unknown[] = []) => ({
      key,
      label: key,
      counts: { L1: rules.filter((r) => r.level === 'L1').length, F3: rules.filter((r) => r.level === 'F3').length, Contract: null },
      rules,
      filesNothingRuns: [],
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
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Tests', exact: true }).click();
    await expect(choice(page, 'Rows')).toHaveValue('area');
    await expect(choice(page, 'Count by')).toHaveValue('level');
    await expect(page.locator('.tile')).toHaveCount(5);

    // The four filters share one row on a desk and sit two to a row on a phone; the page never scrolls sideways, and the tree scrolls inside its panel on a phone.
    const tops = await page.locator('.only select').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    expect(tops).toHaveLength(4);
    expect(Math.max(...[...new Set(tops)].map((top) => tops.filter((t) => t === top).length))).toBe(onAPhone ? 2 : 4);
    expect(await noSidewaysScroll()).toBe(true);
    if (onAPhone) expect(await page.getByRole('region', { name: 'Every area' }).locator('.table').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    // Open Inbox: the tree starts at it, and the breadcrumb names the area above.
    await page.getByRole('region', { name: 'Every area' }).getByRole('link', { name: 'Inbox', exact: true }).click();
    await expect(page).toHaveURL(/[?&]node=Inbox(&|$)/);
    await expect(page.getByRole('navigation', { name: 'Area' })).toHaveText('All areas›Workspaces›Inbox');
    const drilled = page.getByRole('region', { name: 'Inbox, area by area' });

    // Its F3 count of 3 opens those 3 rules above the tree, under the areas that own them; Level is as it was.
    await drilled.getByRole('link', { name: '1 (3)' }).click();
    await expect(page).toHaveURL(/[?&]tests=Inbox%7EF3%7E(&|#|$)/);
    const opened = page.getByRole('region', { name: /^Tests: 3 rules in Inbox and inside it · F3/ });
    await expect(opened.getByRole('row')).toHaveCount(1 + 2 + 3);
    await expect(opened).toContainText('Workspaces › Inbox › Capture');
    await expect(choice(page, 'Level')).toHaveValue('');
    expect((await opened.boundingBox())!.y).toBeLessThan((await drilled.boundingBox())!.y);
    expect(await noSidewaysScroll()).toBe(true);

    // Each testing level has no tiles, no Level filter that would repeat its rows and no Count by.
    await choose(page, 'Rows', 'each testing level', /[?&]group=level(&|$)/);
    await expect(page.locator('.tile')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'By testing level' })).toBeVisible();
    await expect(choice(page, 'Level')).toHaveCount(0);
    await expect(choice(page, 'Count by')).toHaveCount(0);

    // Back on each concept area, main's, with a rule open and a Package filter: picking the pull request shows its own tree at its own commit, without Inbox, which it does not have, the rows and the filter kept, and the rule closed.
    await choose(page, 'Rows', 'each concept area', /[?&]group=area(&|$)/);
    await choose(page, 'Package', 'apps/api', /[?&]package=api(&|$)/);
    await page.goto(`${page.url()}&rule=${encodeURIComponent('apps/api/tests/unit/triage.test.ts:10')}`);
    await expect(page.getByRole('navigation', { name: 'Area' })).toContainText('Rule');
    const picker = choice(page, 'Tests of');
    await expect(picker).toHaveValue('');
    await picker.selectOption({ label: '#9201' });
    await expect(page).toHaveURL(/[?&]pr=9201(&|$)/);
    expect(new URL(page.url()).searchParams.has('rule')).toBe(false);
    await expect(choice(page, 'Package')).toHaveValue('api');
    await expect(choice(page, 'Rows')).toHaveValue('area');
    await expect(page.locator('.stamp')).toContainText('at def5678');
    const every = page.getByRole('region', { name: 'Every area' });
    await expect(every.getByRole('link', { name: 'Sharing', exact: true })).toBeVisible();
    await expect(every.getByRole('link', { name: 'Inbox', exact: true })).toHaveCount(0);
    expect(await noSidewaysScroll()).toBe(true);
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
