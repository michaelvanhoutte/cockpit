import { type Locator, type Page } from '@playwright/test';
import {
  capture,
  captureBox,
  dashboardBar,
  expect,
  itemRow,
  openFirstWorkspace,
  openInbox,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, the walk that says the app allows for the screen it is on: the page runs
 * edge to edge under a phone's status bar, notch and home indicator
 * (`viewport-fit=cover`, apps/web/index.html), and nothing you can read or
 * press is left underneath any of them (functional definition, "The app fits
 * the screen it is on").
 *
 * **Only a browser can hold this.** It is a claim about where boxes land on a
 * screen, which jsdom has no layout engine to answer - the same reason
 * `expectNoSidewaysScroll` lives at this tier.
 *
 * **The walk declares the insets itself, and that is why they are named.**
 * Nothing makes a browser report a notch: the phone project is a Galaxy A55,
 * which has none, and Chromium cannot be told to emulate one, so `env()` is
 * zero under both projects however the app is written. The app therefore reads
 * four `--edge-*` properties (apps/web/src/styles.css) that default to `env()`
 * and that a test can set, so what is proved here is that every surface
 * meeting an edge really does consume what the screen says it takes. What no
 * test can prove is iOS reporting the right number in the first place; that is
 * what looking at a real handset is for.
 *
 * **Two shapes, because a screen never reports all four at once**: held
 * upright a notch takes the top and the indicator the bottom, turned on its
 * side it takes one end and the indicator shrinks. Declaring all four together
 * would ask the app to survive a screen that does not exist - a 480px-wide
 * phone with 44px gone from each side, which no dialog sized for a phone can
 * fit inside.
 */

/** A notched phone held upright, in the CSS pixels iOS reports for one. */
const UPRIGHT = { top: 47, right: 0, bottom: 34, left: 0 };

/** The same phone turned on its side, where the notch takes an end instead. */
const SIDEWAYS = { top: 0, right: 44, bottom: 21, left: 44 };

type Edges = typeof UPRIGHT;

/** Tells the page what the screen takes, the way a notched device would. */
async function screenWithEdges(page: Page, edges: Edges): Promise<void> {
  await page.evaluate((taken) => {
    for (const [side, px] of Object.entries(taken)) {
      document.documentElement.style.setProperty(`--edge-${side}`, `${px}px`);
    }
  }, edges);
}

/** Where the workspace tabs are, which is the first thing a status bar covers. */
function workspaceTabs(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Workspaces' });
}

/**
 * Fails if any part of something is behind the screen's own furniture.
 *
 * Measured as a rectangle rather than read off the CSS: what is under test is
 * whether a person can see and press the thing, and a padding that is declared
 * but overridden by the box around it passes a check of the stylesheet and
 * fails this one.
 */
async function expectClearOfTheEdges(
  page: Page,
  what: Locator,
  name: string,
  edges: Edges,
): Promise<void> {
  const screen = page.viewportSize();
  if (!screen) throw new Error('this walk needs a viewport to measure against');
  const box = await what.boundingBox();
  expect(box, `${name} is not on screen at all`).not.toBeNull();
  const { x, y, width, height } = box!;
  expect(y, `${name} starts ${Math.round(y)}px down, under the status bar`).toBeGreaterThanOrEqual(
    edges.top,
  );
  expect(x, `${name} starts ${Math.round(x)}px in, under the notch`).toBeGreaterThanOrEqual(
    edges.left,
  );
  expect(
    x + width,
    `${name} ends at ${Math.round(x + width)}px of ${screen.width}px, under the notch`,
  ).toBeLessThanOrEqual(screen.width - edges.right);
  expect(
    y + height,
    `${name} ends at ${Math.round(y + height)}px of ${screen.height}px, under the home indicator`,
  ).toBeLessThanOrEqual(screen.height - edges.bottom);
}

/**
 * Scrolls whatever box holds a row all the way to its end - which is the only
 * place the room kept below a list can be seen, since scrolling a row merely
 * into view stops with it against the bottom of the box.
 *
 * Throws rather than returning quietly when nothing scrolls: a list short
 * enough to fit has no end to be under the home indicator, and an assertion
 * about one would pass while proving nothing.
 */
async function scrollToTheEndOfTheListHolding(page: Page, title: string): Promise<void> {
  await page.evaluate((text) => {
    const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(text));
    if (!row) throw new Error(`there is no row for "${text}" to scroll to`);
    for (let box = row.parentElement; box; box = box.parentElement) {
      const scrolls = /auto|scroll/.test(getComputedStyle(box).overflowY);
      if (scrolls && box.scrollHeight > box.clientHeight) {
        box.scrollTop = box.scrollHeight;
        return;
      }
    }
    throw new Error(`nothing holding "${text}" scrolls, so there is no end of a list to look at`);
  }, title);
}

test.describe('Screen edges', () => {
  test.describe("nothing sits under the phone's status bar, home indicator or notch", () => {
    test('keeps the workspace tabs, the way back and the questions clear of them', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      await screenWithEdges(page, UPRIGHT);

      // The tabs, which are what the header is for and the first thing a
      // status bar covers.
      await expectClearOfTheEdges(page, workspaceTabs(page), 'the workspace tabs', UPRIGHT);

      // The way back, laid over the window at the bottom of the screen, which
      // is exactly where a home indicator is. Pressed rather than left
      // standing, so this walk puts back what it dismissed.
      const thought = uniqueTitle('Under the home indicator');
      await capture(page, thought, isMobile);
      await press(itemRow(page, thought).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Dismiss' }), isMobile);
      const offer = page.getByRole('status');
      await expect(offer).toContainText(thought);
      const undo = offer.getByRole('button', { name: 'Undo' });
      await expectClearOfTheEdges(page, undo, 'the Undo offered after a dismissal', UPRIGHT);
      await press(undo, isMobile);
      await expect(itemRow(page, thought)).toBeVisible();

      // The two questions that can reach an end of the screen: both sit near
      // the top of a phone rather than centred on it, because the keyboard
      // takes the bottom half. Neither is answered - opening one is what puts
      // it on the screen, and this walk is about where it lands.
      await press(dashboardBar(page).getByRole('link', { name: 'Dashboard 1' }), isMobile);
      await press(page.getByRole('button', { name: 'Add a panel' }), isMobile);
      const naming = page.getByRole('dialog', { name: 'What is the new panel called?' });
      await expect(naming).toBeVisible();
      await expectClearOfTheEdges(page, naming, 'the question naming a new panel', UPRIGHT);
      await press(naming.getByRole('button', { name: 'Cancel' }), isMobile);

      await press(dashboardBar(page).getByRole('button', { name: 'Dashboard actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Manage dashboards' }), isMobile);
      const dashboards = page.getByRole('dialog', { name: 'Manage dashboards' });
      await expect(dashboards).toBeVisible();
      await expectClearOfTheEdges(page, dashboards, 'the list of dashboards', UPRIGHT);
      await press(dashboards.getByRole('button', { name: 'Done' }), isMobile);

      // Turned on its side, where the notch takes an end of the screen instead
      // of the top of it. The tabs and the Inbox are what run to the edges.
      await screenWithEdges(page, SIDEWAYS);
      await expectClearOfTheEdges(page, workspaceTabs(page), 'the workspace tabs', SIDEWAYS);
      // Two shapes, one Inbox: a column beside the dashboard where there is
      // room for one, a tab in the bar where there is not. Either way what
      // sits against the left edge under the tabs is what you capture into.
      //
      // The box rather than the Inbox around it, because a list long enough to
      // scroll is taller than the screen on purpose - measuring the panel would
      // ask a scroller to fit, which is a different and wrong claim.
      if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
      await expectClearOfTheEdges(page, captureBox(page), 'the capture box', SIDEWAYS);
    });

    test('puts the end of a list clear of the home indicator', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const last = uniqueTitle('The end of the list');
      const titles = [...Array.from({ length: 5 }, () => uniqueTitle('Down the bottom')), last];
      for (const title of titles) await capture(page, title, isMobile);

      // Short, so the list this walk made is long enough to have an end. The
      // width is left alone: it is what decides whether the Inbox is a column
      // beside the dashboards or a screen of its own, and both are meant to be
      // walked - which project is running is what says which.
      const screen = page.viewportSize()!;
      await page.setViewportSize({ width: screen.width, height: 400 });
      await screenWithEdges(page, UPRIGHT);

      await scrollToTheEndOfTheListHolding(page, last);
      await expectClearOfTheEdges(page, itemRow(page, last), 'the last row of the Inbox', UPRIGHT);
    });

    test('keeps a form that fills the screen inside it', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Open on a short screen');
      await capture(page, thought, isMobile);

      // Short enough that the form's own ceiling is what decides its height
      // rather than the room it needs: a dialog centred on a screen it fills
      // hangs off both ends, which is a different way of being behind the
      // status bar from the two questions pinned near the top.
      const screen = page.viewportSize()!;
      await page.setViewportSize({ width: screen.width, height: 400 });
      await screenWithEdges(page, UPRIGHT);

      await press(itemRow(page, thought).getByRole('button', { name: 'Item actions' }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
      const form = page.getByRole('dialog');
      await expect(form).toBeVisible();
      await expectClearOfTheEdges(page, form, "the form for an item's title", UPRIGHT);
    });
  });

  test.describe("the workspace's colour still runs to the edge of the screen", () => {
    test("paints the band the status bar sits over in the bar's own colour", async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      await screenWithEdges(page, UPRIGHT);

      // Read as a colour at a pixel rather than off a named element: what is
      // asserted is what a person sees at the top of the screen, and which box
      // happens to paint it is exactly the implementation detail this must not
      // be written against. Transparent boxes are looked through, the way the
      // screen does.
      const painted = await page.evaluate(() => {
        const colourAt = (x: number, y: number) => {
          for (let el = document.elementFromPoint(x, y); el; el = el.parentElement) {
            const painting = getComputedStyle(el).backgroundColor;
            if (painting && painting !== 'rgba(0, 0, 0, 0)' && painting !== 'transparent') {
              return painting;
            }
          }
          return 'nothing at all';
        };
        const header = document.querySelector('header');
        return {
          atTheTop: colourAt(Math.floor(window.innerWidth / 2), 4),
          theBar: header ? getComputedStyle(header).backgroundColor : '',
        };
      });
      expect(painted.atTheTop, "the top of the screen is not the header bar's colour").toBe(
        painted.theBar,
      );
    });
  });

  test.describe('a screen with nothing taken out of it is drawn exactly as it was', () => {
    test('moves the tabs down by what the screen declares, and by nothing when it declares none', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);
      // Before anything is declared, which is every desktop and every phone
      // Chromium can be told to be: `env()` is zero, so this is the layout the
      // app has always had.
      const before = await workspaceTabs(page).boundingBox();
      await screenWithEdges(page, UPRIGHT);
      const after = await workspaceTabs(page).boundingBox();

      expect(before, 'there are no workspace tabs to measure').not.toBeNull();
      // Exactly the inset: less leaves something under the status bar, more
      // pads a screen that has nothing to allow for.
      expect(after!.y - before!.y).toBe(UPRIGHT.top);
    });
  });
});
