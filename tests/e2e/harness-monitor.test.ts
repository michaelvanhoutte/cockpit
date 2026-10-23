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

const SEED = {
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
