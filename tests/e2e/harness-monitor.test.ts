import { expect, test } from './support/app';

/**
 * F3, because the grouping switch and the filters are forms a person uses and
 * the table only regroups when the browser submits them. What each grouping
 * sums, and what each filter keeps, is
 * apps/harness-monitor/tests/integration/costs-grouping.test.ts and
 * costs-filters.test.ts; this proves the page those figures sit on is
 * reachable, laid out and switchable, on a phone too.
 *
 * The Harness Monitor is its own Worker with its own database, on its own port
 * (scripts/e2e-stack.mjs), seeded through the suite-only route of
 * apps/harness-monitor/tests/e2e-worker.ts.
 */
const monitor = process.env.E2E_HARNESS_MONITOR_URL;

/** Today, so the seeded requests are inside the page's default last 30 days. */
const at = new Date(Date.now() - 60_000).toISOString();

/** A request costing exactly `dollars` at the seeded rate of $2 per million input tokens. */
const request = (id: string, branch: string, category: string, dollars: number) => ({
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
  subagent: false,
  ranWhere: 'local',
  source: 'hook',
});

const SEED = {
  rows: [
    request('1', 'claude/e2e-filter-panel', 'building', 4),
    request('2', 'claude/e2e-filter-panel', 'after-push', 2),
    request('3', 'claude/e2e-teams-message', 'building', 1),
    request('4', 'claude/e2e-teams-message', 'ci-reviews', 1),
  ],
  pullRequests: [
    { branch: 'claude/e2e-filter-panel', number: 9001, title: 'Add a filter panel', state: 'MERGED', mergedAt: '2026-01-02T10:00:00Z', issue: 9000, engineer: 'e2e-alice' },
    { branch: 'claude/e2e-teams-message', number: 9002, title: 'Save a Teams message', state: 'OPEN', mergedAt: null, issue: null, engineer: 'e2e-bob' },
  ],
};

test.describe('Harness Monitor', () => {
  test('the costs page opens grouped by pull request, regroups by engineer, and narrows to a category', async ({ page, request: api }) => {
    test.skip(!monitor, 'the Harness Monitor is started by the local stack only, not by a deployment');
    const seeded = await api.post(`${monitor}/__e2e/seed`, { data: SEED });
    expect(seeded.ok()).toBe(true);

    await page.goto(`${monitor}/`);

    // Grouped by pull request, the bar and the not-measured note shown.
    const table = page.getByRole('region', { name: 'Cost by pull request' });
    await expect(table.getByRole('row', { name: /#9001 Add a filter panel/ })).toContainText('$6.00');
    await expect(table.getByRole('row', { name: /#9002 Save a Teams message/ })).toContainText('$2.00');
    await expect(page.getByRole('heading', { name: /Where the period.s \$8\.00 went/ })).toBeVisible();
    await expect(page.getByRole('img', { name: /Building \$5\.00.*After push \$2\.00.*CI reviews \$1\.00/ })).toBeVisible();
    await expect(page.getByText('are not measured')).toBeVisible();
    await expect(page.getByText('at API list price')).toBeVisible();
    // The page fits the screen; only the table scrolls inside its own box.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Switch to engineer: the same dollars, regrouped.
    await page.getByRole('button', { name: 'Engineer' }).click();
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
    await expect(page.getByRole('button', { name: 'Engineer' })).toHaveAttribute('aria-pressed', 'true');
  });
});
