import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './support/app';

/**
 * F3, because the grouping switch and the filters are forms a person uses and
 * the table only regroups when the browser submits them. What each grouping
 * sums, and what each filter keeps, is
 * apps/harness-monitor/tests/integration/costs-grouping.test.ts and
 * costs-filters.test.ts; a pull request's page and the CSV are
 * pull-request-page.test.ts and csv-export.test.ts. This proves the page those figures sit on is
 * reachable, laid out and switchable, on a phone too, and drawn in Cockpit's look
 * (apps/harness-monitor/tests/integration/cockpit-look.test.ts holds its markup).
 *
 * The Harness Monitor is its own Worker with its own database, on its own port
 * (scripts/e2e-stack.mjs), seeded through the suite-only route of
 * apps/harness-monitor/tests/e2e-worker.ts.
 */
const monitor = process.env.E2E_HARNESS_MONITOR_URL;

/** Today, so the seeded requests are inside the page's default last 30 days. */
const at = new Date(Date.now() - 60_000).toISOString();

/** A request costing exactly `dollars` at the seeded rate of $2 per million input tokens. */
const request = (id: string, branch: string, category: string, dollars: number, subagent: Record<string, unknown> | null = null) => ({
  requestId: `e2e-${id}`,
  sessionId: `e2e-session-${branch}`,
  time: at,
  branch,
  category,
  model: 'claude-sonnet-5',
  speed: 'standard',
  inputTokens: dollars * 500_000,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  subagent: subagent !== null,
  ...subagent,
  ranWhere: 'local',
  source: 'hook',
});

const SEED = {
  rows: [
    request('1', 'claude/e2e-filter-panel', 'building', 4),
    request('2', 'claude/e2e-filter-panel', 'after-push', 2),
    request('3', 'claude/e2e-teams-message', 'building', 1),
    request('4', 'claude/e2e-teams-message', 'ci-reviews', 1),
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
  /** A grouping's tab on the band. */
  const tabOn = (page: Page) => (name: string) => page.getByRole('navigation', { name: 'Group by' }).getByRole('link', { name, exact: true });

  test('the costs page opens on Over time, groups by pull request, opens one pull request through Sessions and exports it, regroups by engineer, narrows to a category, and splits by model', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const seeded = await api.post(`${monitor}/__e2e/seed`, { data: SEED });
    expect(seeded.ok()).toBe(true);

    const tab = tabOn(page);
    await page.goto(`${monitor}/`);

    // The bare address is Over time: its tab pressed, the chart drawn, and the table's own column still reads Day.
    await expect(tab('Over time')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('img', { name: /^Cost per day/ })).toBeVisible();
    // The change card names this period and the one before it.
    const change = page.getByRole('region', { name: 'Change on the previous period' });
    await expect(change).toContainText('Last 30 days');
    await expect(change).toContainText('the previous period');
    await expect(page.getByRole('region', { name: 'Cost by day' }).getByRole('columnheader', { name: 'Day' })).toBeVisible();

    // Grouped by pull request, the bar and the not-measured note shown.
    await tab('Pull request').click();
    const table = page.getByRole('region', { name: 'Cost by pull request' });
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ })).toContainText('$6.00');
    await expect(table.getByRole('row', { name: /#9002 Save a Teams message/ })).toContainText('$2.00');
    // What linking read of a pull request: its lines, how long it was open, and its CI rounds.
    await expect(table.getByRole('columnheader', { name: 'Lines' })).toBeVisible();
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ })).toContainText('+120 −30');
    await expect(page.getByRole('heading', { name: /Where the period.s \$8\.00 went/ })).toBeVisible();
    await expect(page.getByRole('img', { name: /Building \$5\.00.*After push \$2\.00.*CI reviews \$1\.00/ })).toBeVisible();
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
    await page.getByRole('link', { name: 'All costs' }).click();
    await expect(tab('Over time')).toHaveAttribute('aria-current', 'page');

    // Switch to engineer: the same dollars, regrouped.
    await tab('Engineer').click();
    const byEngineer = page.getByRole('region', { name: 'Cost by engineer' });
    await expect(byEngineer.getByRole('row', { name: /e2e-alice/ })).toContainText('$6.00');
    await expect(byEngineer.getByRole('row', { name: /e2e-bob/ })).toContainText('$2.00');

    // Filter to one category: the table and the bar both narrow, and the totals change.
    await page.getByLabel('Category').selectOption('after-push');
    await expect(page.getByRole('heading', { name: /Where the period.s \$2\.00 went/ })).toBeVisible();
    await expect(byEngineer.getByRole('row', { name: /e2e-alice/ })).toContainText('$2.00');
    await expect(byEngineer.getByRole('row', { name: /e2e-bob/ })).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'After push $2.00' })).toBeVisible();
    // The grouping chosen before is kept when a filter changes.
    await expect(tab('Engineer')).toHaveAttribute('aria-current', 'page');

    // Split by model: model columns replace the phase columns, in the bar and the table, and the address carries the choice.
    await expect(byEngineer.getByRole('columnheader', { name: 'After push' })).toBeVisible();
    await page.getByRole('button', { name: 'Model', exact: true }).click();
    await expect(byEngineer.getByRole('columnheader', { name: 'claude-sonnet-5' })).toBeVisible();
    await expect(byEngineer.getByRole('columnheader', { name: 'After push' })).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'claude-sonnet-5 $2.00' })).toBeVisible();
    await expect(page).toHaveURL(/[?&]split=model(&|$)/);
    await expect(tab('Engineer')).toHaveAttribute('aria-current', 'page');
  });

  test('the page fits the device: filters in one row on a desk and two to a row on a phone, tab rows that scroll rather than wrap, and a dark ground on a dark device', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    expect((await api.post(`${monitor}/__e2e/seed`, { data: SEED })).ok()).toBe(true);
    const onAPhone = (page.viewportSize()?.width ?? 0) <= 640;

    await page.goto(`${monitor}/?group=pr`);

    // The five filters: one row on a desk, no more than two to a row on a phone.
    const fields = await page.locator('.filters .field:has(select)').evaluateAll((all) => all.map((f) => Math.round(f.getBoundingClientRect().top)));
    const perRow = [...new Set(fields)].map((top) => fields.filter((t) => t === top).length);
    expect(fields).toHaveLength(5);
    expect(onAPhone ? Math.max(...perRow) : perRow).toEqual(onAPhone ? 2 : [5]);
    if (onAPhone) {
      // Two to a row means two equal columns across the page, not two that happen to fit.
      const right = await page.locator('.filters select').nth(1).evaluate((el) => Math.round(el.getBoundingClientRect().right));
      expect(right).toBe(await page.evaluate(() => document.documentElement.clientWidth - 16));
    }

    // The band shows every grouping on one row; it scrolls sideways when they do not fit, and the page never does.
    const tabs = await page.locator('.band-tabs a').evaluateAll((all) => all.map((a) => Math.round(a.getBoundingClientRect().top)));
    expect(tabs).toHaveLength(5);
    expect(new Set(tabs).size).toBe(1);
    expect(await page.locator('.band-tabs').evaluate((el) => getComputedStyle(el).overflowX)).toBe('auto');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // The ground is Cockpit's warm grey, and its dark value when the device is dark.
    const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await ground()).toBe('rgb(226, 226, 223)');
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await ground()).toBe('rgb(35, 36, 42)');
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
});
