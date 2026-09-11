import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  expect,
  test as base,
  type APIRequestContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
// The one number the walk shares with the app: how long a finger has to rest
// before the row is picked out. Read rather than repeated, so a change to the
// gesture cannot leave the walk holding for the old length and passing anyway.
import { HOLD_MS } from '../../../apps/web/src/hold';

/**
 * Shared arrangement for the F3 walks. Not a page-object layer — F3 is
 * deliberately thin (what each level is for, docs/testing-strategy.md §4) and
 * an abstraction over four locators would hide the thing the tests exist to
 * prove.
 *
 * Every run starts from the same place: scripts/e2e-stack.mjs stamps out a
 * fresh register before the stack comes up, and each account's own store is
 * created empty by the first request that opens it. Neither is the storage
 * `pnpm dev` uses. So a run cannot be affected by what was clicked yesterday,
 * and cannot leave anything in the storage being developed against.
 *
 * Every walk now begins by signing in, because nothing but the logon page works
 * until you have. Cookies are per browser context and Playwright gives each
 * test its own, so a walk is never carrying the sign-in of the one before it.
 *
 * **Signing in leaves the application and comes back**, which is the real code
 * flow: the browser is sent to an issuer, chooses a Google account there, and
 * returns with something the Worker checks. The issuer is ours - a stub the
 * stack starts (scripts/lib/stub-issuer.mjs) - because no test run can reach
 * Google, and pointing at it is one line of configuration rather than a way
 * into the application that only tests are supposed to know about.
 *
 * What that does NOT give is isolation *within* a run. All the specs, under
 * both projects, share one stack and one database, so an item captured by the
 * first spec is still there when the second runs. There is no per-test reset
 * to be had cheaply: the only reliable one is restarting the stack, at about
 * nine seconds each. So the rule stands, for a smaller reason than before —
 * EVERY TEST CREATES WHAT IT NEEDS, NAMES IT UNIQUELY, AND ASSERTS ONLY ON
 * THAT. A count ("the inbox has three items") depends on which specs ran
 * first, and would break the day one is added.
 *
 * The way out now exists but is not taken: making a workspace is a capability
 * as of "Create a workspace from a settings page" (issue 30), and a spec that
 * makes its own would get real per-test isolation for free. It costs a
 * workspace and a page load per spec, so it stays available rather than
 * mandatory - and unique titles remain the rule for everything that does not
 * take it.
 */

/**
 * Once the stack is known to be gone, the note saying so.
 *
 * **A file, not a variable, and that is the whole of why this works.**
 * Playwright throws its worker process away and starts a fresh one after every
 * failed test, so module state does not outlive the walk that discovered
 * anything: the first version of this held a `let`, detected the dead stack
 * thirty-four times in one run, and skipped two. The output directory is
 * emptied at the start of each run, so the note cannot be left over from the
 * last one either.
 */
const NOTE = '.the-stack-went-away';

const noteIn = (info: TestInfo) => join(info.project.outputDir, NOTE);

/**
 * Every walk runs under this, which is why the specs import `test` from here
 * rather than from `@playwright/test` — **a new spec that imports it from
 * Playwright directly opts out of this silently**, the same trap as naming a
 * spec `.spec.ts` and having the explorer not count it.
 *
 * What it is for: when the test stack dies mid-run, everything after it fails
 * on a symptom of its own — a connection refused here, an element not found
 * there — and reads like a dozen unrelated bugs. Two E2E jobs died that way on
 * 3 September 2026 (wrangler quitting on a transient it should have survived,
 * cloudflare/workers-sdk#15317) and cost an artifact download and a log read
 * each to tell apart from real breakage.
 *
 * **That one transient is patched out now** (pnpm-workspace.yaml), and this
 * stays: the six runs of 5 September 2026 that pinned it down lost Vite three
 * times to the same contention, so a half of the stack going away happens for
 * more than one reason.
 *
 * **It never turns a red run green.** The stack going away is a failure worth
 * seeing — it may be the application that has become unstable — so the walk
 * that discovers it still fails, and skipping only begins afterwards. That
 * ordering is what makes a green run impossible here: nothing is skipped until
 * something has already failed.
 */
export const test = base.extend<{ againstALiveStack: void }>({
  againstALiveStack: [
    async ({ request }, use, testInfo) => {
      const note = noteIn(testInfo);
      // Not "is the stack up?" before every walk: that is a request per walk to
      // answer a question whose answer is yes all but once in a suite's life.
      // The cheap version asks only once something has already gone wrong.
      if (existsSync(note)) test.skip(true, readFileSync(note, 'utf8'));

      await use();

      if (testInfo.status === testInfo.expectedStatus || existsSync(note)) return;
      if (await answering(request)) return;

      const gone =
        'the test stack exited during this run, so this walk was not run against a live server ' +
        '— read the [test api] and [test web] output above for why it went';
      mkdirSync(dirname(note), { recursive: true });
      writeFileSync(note, gone);
      // Printed as well as written, because the reason a walk was skipped never
      // reaches the terminal and this is the one line that explains the rest of
      // the run. Once, by the walk that found out.
      console.error(`\n${gone}\n`);
      testInfo.annotations.push({ type: 'stack', description: gone });
    },
    { auto: true },
  ],
});

/**
 * Whether the stack still answers. Anything but a plain yes counts as gone —
 * a refused connection throws, and a Worker answering something other than 200
 * is not a stack a walk can be run against either.
 *
 * Asked twice before it is believed. The contention that makes the Worker die
 * in the first place is the same contention that makes a request slow: on the
 * jobs this was written for, ordinary calls were taking over a second and a
 * half. One slow answer here would declare a live stack dead, skip the rest of
 * the run, and print a sentence that is not true — which is worse than the
 * confusion it exists to remove. A stack that has really gone refuses the
 * connection at once, so the second ask costs nothing in the case that matters.
 */
async function answering(request: APIRequestContext): Promise<boolean> {
  for (let ask = 0; ask < 2; ask += 1) {
    try {
      if ((await request.get('/health', { timeout: 5_000 })).ok()) return true;
    } catch {
      // Refused, or too slow to be worth waiting for. Ask once more.
    }
    if (ask === 0) await new Promise((wait) => setTimeout(wait, 1_000));
  }
  return false;
}

export { expect };

/**
 * Presses a control the way the device under test would. This is not a
 * nicety: Playwright's `click()` dispatches mouse events even on a project
 * with `hasTouch`, so a suite that only clicks proves nothing about touch
 * however many phone projects it runs under, and a control reachable only by
 * mouse would pass everywhere. `tap()` dispatches the real touchstart and
 * touchend, and refuses to run without `hasTouch` — hence the gate rather
 * than using it everywhere.
 */
export async function press(locator: Locator, isMobile: boolean): Promise<void> {
  if (isMobile) await locator.tap();
  else await locator.click();
}

/** A title no other run — or branch — will have produced. */
export function uniqueTitle(label: string): string {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * A person nobody has added yet: a name and the address they will sign in with.
 *
 * **The register is not rebuilt between the two projects.** The stack rebuilds
 * its storage once per run and then serves `desktop` and `phone` from it, so a
 * walk that *adds* somebody meets its own leftovers on the second project - the
 * row already there, already signed in. `uniqueTitle` is the same answer for
 * item titles; this is it for people, whose address the register keeps unique.
 */
export function somebodyNew(label: string): { name: string; address: string } {
  const tag = crypto.randomUUID().slice(0, 8);
  return { name: `${label} ${tag}`, address: `${label.toLowerCase()}.${tag}@example.com` };
}

/**
 * The two people the register is seeded with (apps/api/seed.sql). Each owns an
 * account of their own, and they share nothing.
 */
/**
 * The workspace an account starts with (apps/api/src/accounts/changes.ts). The
 * one workspace a walk can name without making it first, and no walk deletes
 * it: every spec in a run shares one database, so taking it would take the
 * other specs' workspace with it.
 */
export const STARTING_WORKSPACE = 'Workspace 1';

export const MICHAEL = 'Michael';
export const ADA = 'Ada';

/**
 * Signs in by choosing a name, which is the only way into the app.
 *
 * Used as arrangement by every walk about something else - the walk about
 * signing in itself asserts its way through these steps rather than calling
 * this, because a helper that both arranges and asserts is a helper that can
 * make its own test vacuous.
 */
export async function signIn(page: Page, name: string, isMobile: boolean): Promise<void> {
  await signInWithoutSkipping(page, name, isMobile);
  await pastOnboarding(page, isMobile);
}

/**
 * The onboarding question, answered the way somebody who wants the app would,
 * where it was asked at all - and the dashboard afterwards either way.
 *
 * **Conditional, and that is not order-dependence sneaking back in:** whether
 * an account has been started on depends on what else has run - the tier
 * shares one database - and having been through the question is remembered in
 * the browser, which Playwright gives every walk fresh. So the honest thing is
 * to answer the question when it is asked and notice nothing when it is not.
 *
 * **Shared by every way into the app, not only `signIn`.** Continuing as a
 * guest can land here too - the guest account may never have been opened on
 * before - and the caller is expected to have already waited for one of the
 * two landings, the way `signInWithoutSkipping` does for this one.
 */
export async function pastOnboarding(page: Page, isMobile: boolean): Promise<void> {
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible()) await press(skip, isMobile);
  await expect(dashboardBar(page)).toBeVisible();
}

/**
 * The sign-in, stopping at whichever screen it lands on, for the one walk whose
 * subject is what an account nobody has started on is shown. Everything else
 * wants `signIn`, which goes on into the app.
 *
 * **It waits for one of the two landings before answering.** Pressing the
 * account and returning leaves the caller on the issuer, mid-redirect, and
 * whatever it asserts next is asked of a page the app has not drawn - which is
 * a walk that fails saying it could not find a heading rather than that it
 * never arrived. `or` is one wait with one timeout, where two raced against
 * each other would settle on the first to *time out* as readily as on the first
 * to appear.
 */
export async function signInWithoutSkipping(
  page: Page,
  name: string,
  isMobile: boolean,
): Promise<void> {
  await page.goto('/signin');
  await press(page.getByRole('link', { name: 'Continue with Google' }), isMobile);
  await press(page.getByRole('link', { name: addressOf(name), exact: true }), isMobile);
  await page
    .getByRole('button', { name: 'Skip' })
    .or(dashboardBar(page))
    .first()
    .waitFor({ state: 'visible' });
}

/**
 * The same journey for somebody the seed does not hold - a person added while
 * the walk was running ("Add a user on the admin page, so a second person no
 * longer needs SQL", issue 231).
 *
 * The issuer offers the seeded addresses as links and any other in a box, which
 * is what this types into: the address is the walk's own, since it just typed it
 * into the page that added them.
 *
 * **It arranges and does not assert**, unlike `signIn` above: whether somebody
 * added a moment ago can actually get in is the claim its walk is making, so
 * waiting for the app here would make that walk prove itself.
 */
export async function signInWith(page: Page, address: string, isMobile: boolean): Promise<void> {
  await page.goto('/signin');
  await press(page.getByRole('link', { name: 'Continue with Google' }), isMobile);
  await page.getByPlaceholder('somebody@example.com').fill(address);
  await press(page.getByRole('button', { name: 'Continue' }), isMobile);
}

/**
 * The Google account each of the seeded people signs in with, as seed.sql gives
 * it to them.
 *
 * The walks are written in names because that is what a person and the rest of
 * the application deal in; the issuer only knows addresses, and this is the one
 * place the two meet.
 */
export function addressOf(name: string): string {
  const address = { [MICHAEL]: 'michael@example.com', [ADA]: 'ada@example.com' }[name];
  if (!address) throw new Error(`no Google account is seeded for ${name}`);
  return address;
}

/**
 * Signs in as the first person and lands in their first workspace: "/" redirects
 * there and, inside it, to the view that workspace was last on (router.tsx).
 * Waits for the bar of dashboards, which is what says a workspace is open and
 * usable.
 */
export async function openFirstWorkspace(page: Page, isMobile: boolean): Promise<void> {
  await signIn(page, MICHAEL, isMobile);
}

/**
 * Deletes a workspace from the window it is managed in, answering the question
 * it asks.
 *
 * Arrangement, not assertion: the walk about *deleting* one asserts its way
 * through these same steps rather than calling this, because a helper that both
 * arranges and asserts is a helper that can make its own test vacuous.
 *
 * It exists because a spec that leaves workspaces behind changes the settings
 * page for every spec after it, in this run and in the other project - the run
 * shares one database. What that used to break was the box for making a
 * workspace: the four the ordering walks left behind pushed it off the bottom
 * of a 480px screen and failed the walk that says it is reachable there. That
 * particular one is gone - the box is above the list now, so where it sits no
 * longer depends on how long the list is - but the ordering walks still put
 * their workspaces back, because what they drag is the last two rows and every
 * row left behind pushes those two further down the page. A spec that makes
 * workspaces it does not need afterwards puts them back.
 */
export async function deleteWorkspace(page: Page, name: string, isMobile: boolean): Promise<void> {
  await chooseTabAction(page, workspaceTab(page, name), 'Delete', isMobile);
  await press(page.getByRole('button', { name: `Yes, delete ${name}` }), isMobile);
  await expect(workspaceTab(page, name)).toHaveCount(0);
}

/**
 * One workspace's tab in the header, and all of them left to right - which is
 * the order the reordering is about ("Reorder workspaces", issue 31), and now
 * also what a workspace is changed on.
 *
 * **By selector rather than by role**, which is not a style choice. A form or
 * a delete question is a modal, so while one is open the browser hides
 * everything behind it from assistive technology and a role query finds
 * nothing in the header at all - correctly, and not at all the same as the
 * tab having gone. These walks are about what is on the screen, and the tabs
 * are on it, behind a dimmed overlay; `toHaveCount(0)` written as a role query
 * would have passed for the wrong reason.
 */
export function workspaceTab(page: Page, name: string): Locator {
  return page.locator('nav[aria-label="Workspaces"] a').filter({ hasText: name });
}

export async function workspaceTabs(page: Page): Promise<string[]> {
  return page.locator('nav[aria-label="Workspaces"] a').allTextContents();
}

/**
 * Switches workspace, and waits until the new one is really the one on screen.
 * **Every walk that changes workspace goes through here**, because pressing the
 * tab and carrying on is a race the fast machine always wins and CI does not.
 *
 * The old workspace stays fully on screen while the router works, so the
 * controls a walk reaches for next - the capture box, the button that adds a
 * dashboard - are the ones belonging to the workspace being left, and act on
 * it. A note settled into the workspace it was captured in ("Stop the browser
 * suite dying mid-run", pull request 184), and a thought was captured into
 * `ws-work` from a screen showing a workspace made seconds earlier, failing
 * the account-boundary walk in CI on a tree that passed everywhere else (pull
 * request 193, commit deed81d). `scripts/lib/e2e-conventions.mjs` is what
 * keeps the next walk from pressing the tab itself.
 *
 * **Shut any management window first.** The tabs are located by selector
 * rather than by role, deliberately (`workspaceTab`), so they are still found
 * behind a modal - where the overlay covers them, and pressing one times out
 * on pointer interception rather than saying the window is in the way.
 *
 * **It waits for the address to get deeper, not to change.** A tab's own
 * address is `/w/<id>`, and the router puts that in the bar before it does any
 * of the work - the run this was written for had `/w/ws-atlas` up a twentieth
 * of a second before the bad press. `/w/<id>` then redirects to the view the
 * workspace was last on, from a `beforeLoad` that awaits the workspace and its
 * dashboards (router.tsx), so a *deeper* address is the page saying it holds
 * this workspace's snapshot - which is the same snapshot the Inbox is drawn
 * from.
 */
export async function switchTo(page: Page, name: string, isMobile: boolean): Promise<void> {
  const tab = workspaceTab(page, name);
  const workspace = await tab.getAttribute('href');
  if (!workspace) throw new Error(`the tab for ${name} has no address to wait for`);
  // Already there, which a walk cannot always know: making a workspace opens
  // it. Pressing the tab you are on opens that tab's menu rather than
  // switching ("Change a workspace or a dashboard on the tab it is", issue
  // 267), so a switch that is not one would leave a menu over the page.
  const where = new URL(page.url()).pathname;
  if (where === workspace || where.startsWith(`${workspace}/`)) return;
  await press(tab, isMobile);
  await page.waitForURL((url) => url.pathname.startsWith(`${workspace}/`));
}

/**
 * Drags one workspace tab onto another's place along the strip.
 *
 * Driven with the mouse, and only under the desktop project: Playwright's
 * touchscreen can tap and nothing else, so a finger drag cannot be expressed
 * here at all - and the app's drag is the pointer's anyway. The way to move a
 * tab with a finger, or a keyboard, is the tab's own Move left / Move right,
 * walked with `press`, which really does tap.
 */
export async function dragTabOnto(page: Page, tab: string, onto: string): Promise<void> {
  // Scrolled to before they are measured, and that is not a nicety:
  // `boundingBox` reports a position without scrolling to it, so a tab outside
  // the strip's visible part is measured at a coordinate the mouse cannot be
  // moved to - and the drag then silently moves nothing while every assertion
  // after it is asked of a strip nothing touched. That is how the workspace
  // list's own drag walk once passed while dragging nothing at all.
  await workspaceTab(page, tab).scrollIntoViewIfNeeded();
  await workspaceTab(page, onto).scrollIntoViewIfNeeded();
  const from = await workspaceTab(page, tab).boundingBox();
  const to = await workspaceTab(page, onto).boundingBox();
  if (!from || !to) throw new Error(`cannot drag ${tab} onto ${onto}: one of them is not on screen`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  // In steps, because a drag is a stream of moves: one jump would leave the
  // strip never having been told where the pointer went, and the first few
  // pixels are what tell a press from a drag at all.
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}


/**
 * The bar of views under the workspace tabs: the workspace's dashboards, and
 * the Inbox before them only on a screen too narrow to hold it beside them
 * ("Show the Inbox beside the dashboards instead of as a tab", issue 117).
 */
export function dashboardBar(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Dashboards' });
}

/**
 * One dashboard's tab in that bar, which is what it is renamed and deleted on.
 * By selector rather than by role for the reason `workspaceTab` gives: a form
 * or a question open over the workspace hides the bar behind it from assistive
 * technology, and these walks are about what is on the screen.
 */
export function dashboardTab(page: Page, name: string): Locator {
  return page.locator('nav[aria-label="Dashboards"] a').filter({ hasText: name });
}

/**
 * Opens a dashboard, and does nothing where it is already the one on screen -
 * which is not a nicety: pressing the tab you are on opens that tab's menu
 * rather than switching ("Change a workspace or a dashboard on the tab it is",
 * issue 267), so a walk that pressed it anyway would carry on with a menu over
 * the page. On a phone the Inbox is a screen of its own, so coming back from it
 * really is a switch; on a wide screen the dashboard was never left.
 */
export async function openDashboard(page: Page, name: string, isMobile: boolean): Promise<void> {
  const tab = dashboardTab(page, name);
  // Asked of the element's own class list rather than of the attribute as a
  // string: the tab's classes include the variants that style the current one
  // (`[&.active]:…`), so "does the attribute contain active" is true of every
  // tab there is.
  if (await tab.evaluate((el) => el.classList.contains('active'))) return;
  await press(tab, isMobile);
  await expect(tab).toHaveClass(/(^|\s)active(\s|$)/);
}

/**
 * Opens the first workspace with its Inbox on screen, which is where capture
 * and triage happen.
 *
 * Two shapes, one Inbox ("Show the Inbox beside the dashboards instead of as a
 * tab", issue 117): on the 1280px project it is a column beside whatever the
 * workspace opened on, so it is already there; on the 480px one there is no
 * room for a column, so it is a tab in the bar and has to be switched to. The
 * projects are the two devices, so which one is running is what says which.
 */
export async function openInbox(page: Page, isMobile: boolean): Promise<void> {
  await openFirstWorkspace(page, isMobile);
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
  await expect(captureBox(page)).toBeVisible();
}

/**
 * Makes a workspace from the `+` at the end of the strip, and waits for its
 * tab. Arrangement for every walk that needs a workspace of its own; the walk
 * about *making* one asserts its own way through the question rather than
 * calling this, because a helper that both arranges and asserts is a helper
 * that can make its own test vacuous.
 */
export async function makeWorkspace(page: Page, name: string, isMobile: boolean): Promise<void> {
  await press(page.getByRole('button', { name: 'Add a workspace' }), isMobile);
  await page.getByLabel('Name of the new workspace').fill(name);
  await page.getByLabel('Name of the new workspace').press('Enter');
  await expect(workspaceTab(page, name)).toBeVisible();
}

/**
 * Chooses what to do to a workspace or a dashboard, on the tab it is ("Change
 * a workspace or a dashboard on the tab it is", issue 267).
 *
 * **One gesture per project, and each is the one that input really has.** A
 * mouse right-clicks. A finger cannot, so the phone project presses the tab it
 * is already on - which opens that tab's menu rather than switching to where
 * you already are, and is the way in a touchscreen has without a long press.
 * That is why this switches first on a phone: the walk asks for the menu of a
 * tab, and on a phone the way to a tab's menu goes through being on it.
 */
export async function chooseTabAction(
  page: Page,
  tab: Locator,
  entry: string,
  isMobile: boolean,
): Promise<void> {
  if (isMobile) {
    await tab.tap();
    // A tap on a tab you were not on switches to it, and the menu comes on the
    // next press; on the one you were already on the first press is the menu.
    // Waited for rather than counted straight away, which would race the menu
    // being drawn and tap a second time - closing the one just opened.
    const opened = await page
      .getByRole('menuitem', { name: entry })
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) await tab.tap();
  } else {
    await tab.click({ button: 'right' });
  }
  await press(page.getByRole('menuitem', { name: entry }), isMobile);
}

/**
 * Chooses what to do to one row of a list: its own menu, then the entry ("Ask
 * before deleting in a dialog, from the row's own menu", issue 116). The types
 * window offers its rows the same way, so every walk reaches them the same
 * way; a workspace, a dashboard and a panel open their own menu instead and
 * have `chooseTabAction` and `choosePanelAction`.
 *
 * This is also how a phone edits a row: the double-click that opens the same
 * form with a mouse is a gesture a touchscreen has already spent on zooming.
 */
export async function chooseRowAction(
  page: Page,
  row: string,
  entry: string,
  isMobile: boolean,
): Promise<void> {
  await press(page.getByRole('button', { name: `Actions for ${row}` }), isMobile);
  await press(page.getByRole('menuitem', { name: entry }), isMobile);
}

/**
 * Chooses what to do to a panel, from its own menu, opened on its header
 * rather than a button - the same menu a workspace's or a dashboard's own tab
 * opens (`chooseTabAction`), but without that tab's second way in: a panel has
 * no "already open" state a tap could repurpose, its plain tap being spent on
 * the drag gesture instead. A phone rests a finger on the header and holds it
 * instead, a real touch through CDP for `holdRow`'s own reason: what has to be
 * proved is that the gesture reaches Radix's long-press detection as a
 * `touch` pointer, which a synthetic `contextmenu` event cannot say anything
 * about - and would have said nothing at all about the header's own drag
 * handler once swallowing every touch before Radix ever saw one (found in
 * review; `PanelCard.tsx`'s `onPointerDown` now excludes anything that is not
 * a mouse for exactly this reason).
 */
export async function choosePanelAction(
  page: Page,
  panelName: string,
  entry: string,
  isMobile: boolean,
): Promise<void> {
  const header = page.getByRole('region', { name: panelName }).locator('header');
  if (isMobile) {
    await holdPanelHeader(page, header);
  } else {
    await header.click({ button: 'right' });
  }
  await press(page.getByRole('menuitem', { name: entry }), isMobile);
}

/**
 * Rests a finger on a panel's header and holds it, the way a thumb opens its
 * menu on a phone ("A long press may open it as well, which is Radix's own
 * doing", `Menu.tsx`).
 *
 * `700` is Radix's own long-press timer (`@radix-ui/react-context-menu`'s
 * `ContextMenuTrigger`), not a number this repo owns or can import the way
 * `holdRow` imports `HOLD_MS` - a version bump could change it silently,
 * which this holds well past rather than guards against.
 */
async function holdPanelHeader(page: Page, header: Locator): Promise<void> {
  // Found in review: `boundingBox` reports a position without scrolling to
  // it, the same gotcha `dragTabOnto` documents - a header below the fold
  // would otherwise be held at a coordinate the finger cannot reach.
  await header.scrollIntoViewIfNeeded();
  const box = await header.boundingBox();
  if (!box) throw new Error('cannot hold the panel header: it is not on screen');
  const at = [
    { x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 8, radiusY: 8, force: 1 },
  ];

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
    await page.waitForTimeout(950);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

/**
 * The colour the page is actually painted in, as the browser computed it - the
 * shell covers the viewport, so this is the ground behind the panels. Read from
 * the computed style rather than the inline one, because what is under test is
 * what a person sees rather than what the attribute says.
 */
export async function groundOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    // The app shell is what the router mounts straight into #root.
    const shell = document.querySelector('#root > div');
    return shell ? getComputedStyle(shell).backgroundColor : '';
  });
}

export function captureBox(page: Page): Locator {
  return page.getByLabel('Capture a note or to-do');
}

/**
 * The workspace's Inbox, holding everything still to deal with.
 *
 * **Two roles, because the Inbox is two things depending on the width.** Where
 * there is room it is a column beside the dashboards, which is complementary
 * content and says so; where there is not, it is the screen a tab opens, which
 * is a region of its own. Both are named by the same heading, so this asks for
 * the name and takes either role.
 */
export function inbox(page: Page): Locator {
  return page
    .getByRole('complementary', { name: 'Inbox' })
    .or(page.getByRole('region', { name: 'Inbox' }));
}

/** The row for one captured title, wherever it currently sits. */
export function itemRow(page: Page, title: string): Locator {
  return page.getByRole('listitem').filter({ hasText: title });
}

/**
 * Captures a thought and waits until it is on screen. Used as arrangement by
 * tests about something else — the capture walk itself asserts its way through
 * the same steps rather than calling this, because a helper that both arranges
 * and asserts is a helper that can make its own test vacuous.
 */
export async function capture(page: Page, title: string, isMobile: boolean): Promise<void> {
  await captureBox(page).fill(title);
  // The Inbox's own button, which captures into the workspace you are in. The
  // header's Capture opens a screen of its own, where where it goes is a
  // question rather than an assumption ("Capture Page", artboard 2a), so this
  // has to say which of the two it means.
  await press(inbox(page).getByRole('button', { name: 'Capture' }), isMobile);
  await expect(itemRow(page, title)).toBeVisible();
}

/**
 * Fails if anything inside the Inbox column spills out of it sideways.
 *
 * A second check rather than a nicety: the column scrolls inside itself, so
 * something too wide for it scrolls *there* and the page stays exactly the
 * width it was - `expectNoSidewaysScroll` is structurally blind to it. That is
 * how the capture box pushed its own button out of the panel and was found by
 * looking rather than by running anything ("Show the Inbox beside the
 * dashboards instead of as a tab", issue 117).
 */
export async function expectNothingSpillsOutOfTheInbox(page: Page): Promise<void> {
  const column = await page.evaluate(() => {
    // Named by the heading up in the dashboard band rather than by a label of
    // its own ("Cockpit Shell Explorations", artboard 2c), so the column is the
    // only `aside` in the shell rather than the one wearing the name.
    const inbox = document.querySelector('main > aside');
    return inbox ? { scrollWidth: inbox.scrollWidth, clientWidth: inbox.clientWidth } : null;
  });
  expect(column, 'there is no Inbox column on this screen to measure').not.toBeNull();
  expect(
    column!.scrollWidth,
    `the Inbox spills out of its column: ${column!.scrollWidth}px of content in ${column!.clientWidth}px`,
  ).toBeLessThanOrEqual(column!.clientWidth);
}

/**
 * What this browser is still holding of whoever was signed in: the query keys
 * in the stored copy of the read model (IndexedDB, written by
 * `apps/web/src/persistence.tsx`) and the keys the app has written to
 * localStorage.
 *
 * Read straight out of the browser rather than off the screen, because that is
 * where the leak this guards against would live: a screen showing nothing of
 * the last person can still be sitting on a stored copy the *next* cold open
 * paints from, a week later. jsdom has no IndexedDB, so nothing below this tier
 * can look.
 */
export async function whatTheBrowserStillHolds(
  page: Page,
): Promise<{ storedQueries: string[]; localKeys: string[] }> {
  return page.evaluate(async () => {
    const stored = await new Promise<unknown>((resolve) => {
      const open = indexedDB.open('keyval-store');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('keyval')) return resolve(undefined);
        const read = db.transaction('keyval').objectStore('keyval').get('cockpit-query-cache-v1');
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => resolve(undefined);
      };
      open.onerror = () => resolve(undefined);
    });
    const queries =
      (stored as { clientState?: { queries?: { queryKey: unknown[] }[] } } | undefined)?.clientState
        ?.queries ?? [];
    return {
      storedQueries: queries.map((q) => JSON.stringify(q.queryKey)),
      localKeys: Object.keys(localStorage),
    };
  });
}

/**
 * Fails if the page scrolls sideways. The check that catches "it renders, but
 * off the edge of the phone" — the failure that is invisible to every test
 * below this tier, because jsdom has no layout engine and reports every width
 * as zero.
 */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const { scrollWidth, clientWidth } = document.documentElement;
    return { scrollWidth, clientWidth };
  });
  expect(
    overflow.scrollWidth,
    `page scrolls sideways: content is ${overflow.scrollWidth}px wide in a ${overflow.clientWidth}px viewport`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

/**
 * Whether the workspace tab you are on is wholly inside the strip that holds
 * it, rather than cut off at one end of it.
 *
 * The strip scrolls within itself instead of widening the page, so with enough
 * workspaces the one you are on can sit outside the part of it you can see -
 * and because the tab you are on is filled and joined to the strip below it, a
 * tab that is half out of view leaves an orphaned notch, which reads as broken
 * rather than as cut off.
 *
 * The current tab is found by being the filled one, which is what "the tab you
 * are on" means here; every other tab is transparent.
 */
export async function tabOnIsWhollyInView(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const strip = document.querySelector('nav[aria-label="Workspaces"]');
    if (!strip) return false;
    const on = [...strip.querySelectorAll('a')].find(
      (tab) => getComputedStyle(tab).backgroundColor !== 'rgba(0, 0, 0, 0)',
    );
    if (!on) return false;
    const held = strip.getBoundingClientRect();
    const tab = on.getBoundingClientRect();
    // A pixel of slack each way: these are fractional at a device pixel ratio
    // that is not a whole number, and being a fifth of a pixel proud of the
    // edge is not being cut off.
    return tab.left >= held.left - 1 && tab.right <= held.right + 1;
  });
}

/**
 * A finger down on a row, across it, and off — a real touch, not a synthetic
 * event.
 *
 * **Driven through CDP because Playwright cannot express a finger drag**: its
 * touchscreen taps and does nothing else, which is the limit recorded on
 * `dragTabOnto` above. `Input.dispatchTouchEvent` puts the touch in at the
 * browser's own input layer, so `touch-action`, the pointer events React sees
 * and the scrolling this gesture has to coexist with are all the real ones.
 * Driving `dispatchEvent` from `page.evaluate` would prove only that a handler
 * is attached, which the level below already does.
 *
 * Moved in steps, because a swipe is a stream of touches: one jump would leave
 * the row never having been told where the finger went.
 *
 * **Do not follow one of these with `press`.** Playwright's own touch input
 * stops landing for the rest of the page's life once a CDP touch has been
 * dispatched to it - measured: after a swipe, `tap()` on a button does nothing
 * while `click()` on the same button works. It is the two input paths
 * disagreeing, not the page: assert what the swipe did and end the walk there.
 * That holds for `whileSwipingRow` below as much as for `swipeRow` — it is the
 * CDP touch that spends the page, not what the gesture went on to mean.
 */
async function touchARowAcross(
  page: Page,
  title: string,
  across: number,
  /**
   * Read the row with the finger still down and put it back where it started
   * before lifting, rather than letting go at the far end.
   *
   * Both halves matter. The check has to run mid-gesture because that is the
   * only moment the row is saying anything; and the finger has to come home
   * afterwards because letting go past the threshold *acts* - so a walk that
   * only wanted to read the band would dismiss the item as it tidied up.
   */
  check?: () => Promise<void>,
): Promise<void> {
  const row = itemRow(page, title);
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (!box) throw new Error(`cannot swipe ${title}: it is not on screen`);
  // Off-centre horizontally, so a swipe that has to travel a long way starts
  // with room to travel in: from the middle, a leftward swipe on a 480px screen
  // has 240px and a rightward one has 240px, which is enough for both.
  const y = box.y + box.height / 2;
  const from = box.x + box.width / 2;

  const cdp = await page.context().newCDPSession(page);
  const touch = (x: number) => [{ x, y, radiusX: 8, radiusY: 8, force: 1 }];
  const moveTo = (x: number) =>
    cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(x) });
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(from) });
    for (let step = 1; step <= 8; step += 1) await moveTo(from + (across * step) / 8);
    if (check) {
      try {
        await check();
      } finally {
        // Home again, so the release below means nothing - and in a `finally`
        // of its own, because a check that threw would otherwise let go at the
        // far end and *act*: a walk that failed reading the band would dismiss
        // the item on its way out, which is the one thing this walk home is
        // here to prevent. Measured with a check made to throw, not reasoned
        // about: without this `finally` the row was gone and the undo bar up.
        for (let step = 7; step >= 0; step -= 1) await moveTo(from + (across * step) / 8);
      }
    }
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }
}

export const swipeRow = (page: Page, title: string, across: number): Promise<void> =>
  touchARowAcross(page, title, across);

/**
 * The same finger, stopped part-way across with the row still under it, so
 * whatever the row is saying mid-gesture can be read ("Show what a swipe will
 * do before the finger lifts").
 *
 * It leaves nothing behind: the finger goes back to where it started before it
 * lifts, so reading the band is not also a dismissal.
 */
export const whileSwipingRow = (
  page: Page,
  title: string,
  across: number,
  check: () => Promise<void>,
): Promise<void> => touchARowAcross(page, title, across, check);

/**
 * Rests a finger on an item row and holds it still, which is how a selection
 * starts on a phone ("Start a selection with a long press, so a phone can do it
 * too", issue 170).
 *
 * A real touch through CDP, like `swipeRow` above and for the same reason:
 * Playwright's touchscreen can only tap, and what has to be proved here is that
 * the gesture a thumb makes reaches the handler as a `touch` pointer — which a
 * synthetic event cannot say anything about.
 *
 * **It holds longer than the app asks for.** `HOLD_MS` is what the app waits;
 * a walk that waited exactly that long would be racing its own timer, and the
 * one thing worse than a slow test is one that fails for the wrong reason.
 *
 * **`swipeRow`'s warning about following a CDP touch with `press` does not
 * hold here, and the difference is measured rather than assumed.** A swipe
 * dispatches a stream — touchStart, eight moves, touchEnd — and after one of
 * those Playwright's own `tap()` stops landing for the rest of the page's life.
 * This dispatches a start and an end with nothing between, and the walk that
 * uses it goes on to tap its way between the Inbox and a dashboard afterwards.
 * If that ever stops being true the walk fails at the navigation rather than
 * passing quietly, so this is a note for whoever reads the two together, not a
 * risk being carried.
 */
export async function holdRow(page: Page, title: string): Promise<void> {
  const row = itemRow(page, title);
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  if (!box) throw new Error(`cannot hold ${title}: it is not on screen`);
  const at = [
    { x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 8, radiusY: 8, force: 1 },
  ];

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at });
    await page.waitForTimeout(HOLD_MS + 250);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

/**
 * Drags one item row and lets it go over another row, above or below its
 * middle — which is what decides the gap it lands in.
 *
 * **The mouse, under both projects, and that is a limit of the tool rather than
 * a claim about the product**: Playwright's touchscreen cannot express a drag
 * at all (see `dragTabOnto`), and the browser's own drag-and-drop is a mouse
 * gesture anyway — a row is swiped on a phone, not dragged. The phone project
 * still gets the gesture against a 480px layout.
 *
 * Both rows are scrolled to and measured before the mouse moves, for the reason
 * `dragTabOnto` records: `boundingBox` reports a position without scrolling to
 * it, so a row below the fold is measured at a coordinate the mouse cannot
 * reach and the drag silently does nothing.
 */
export async function dragItemOnto(
  page: Page,
  title: string,
  onto: { title: string; half: 'top' | 'bottom' },
): Promise<void> {
  const dragged = itemRow(page, title);
  const target = itemRow(page, onto.title);
  await dragged.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await dragged.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error(`cannot drag ${title} onto ${onto.title}: one is not on screen`);

  // A quarter into the half being aimed at, so the pointer is unambiguously one
  // side of the row's middle. Relative to the target, which is what `dragTo`
  // takes.
  const y = onto.half === 'top' ? to.height / 4 : (to.height * 3) / 4;

  // `dragTo` rather than a stream of mouse moves, and the difference is not
  // cosmetic: the panel drag above works with the mouse because it is measured
  // in mouse events, while this is the browser's own drag-and-drop, which
  // Chromium only enters through the protocol `dragTo` speaks. Driven by hand
  // it produced no drop at all - the row was picked up and nothing arrived.
  await dragged.dragTo(target, { targetPosition: { x: to.width / 2, y } });
}

/**
 * The titles a panel is showing, top to bottom.
 *
 * **Assert on it with `expect.poll`, never on one call of it.** It reads the
 * DOM once, and what a panel shows arrives a moment after the change that moved
 * something into it - the command is sent, the snapshot re-read, and only then
 * is the list redrawn. A bare `expect(await itemsOn(...))` measures the list as
 * it was before any of that and fails while the product is working.
 */
export async function itemsOn(page: Page, panel: string): Promise<string[]> {
  return page
    .getByRole('region', { name: panel })
    .getByRole('listitem')
    .evaluateAll((rows) => rows.map((row) => row.querySelector('span > span')?.textContent ?? ''));
}
