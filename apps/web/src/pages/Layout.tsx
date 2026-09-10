import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADMIN, DEFAULT_WORKSPACE_THEME, isPaletteTheme, themeOf, uuidv7 } from '@cockpit/shared';
import { NotSignedIn, signOut } from '../api/client';
import { meQuery, refusalFrom, snapshotQuery, useCommand, workspacesQuery } from '../api/queries';
import { useServerEvents } from '../api/useServerEvents';
import { DashboardBar } from '../components/DashboardBar';
import { InboxHeading, InboxPanel } from '../components/InboxPanel';
import { ItemForm } from '../components/ItemForm';
import { LoadFailure } from '../components/LoadFailure';
import { ManageTypes } from '../components/ManageTypes';
import { MenuContent, MenuTrigger, menuItemClass } from '../components/Menu';
import { NameQuestion } from '../components/NameQuestion';
import { RoutingSummaryWindow } from '../components/RoutingSummaryWindow';
import { WorkspaceTabs, stripTabClass } from '../components/WorkspaceTabs';
import { WHAT_A_WORKSPACE_IS } from '../whatThingsAre';
import { OpensItemForms } from '../itemForm';
import { litForChrome } from '../chrome';
import { browserStore } from '../lastVisited';
import { clampInboxWidth, readInboxWidth, writeInboxWidth } from '../inboxWidth';
import { useMeasuredWidth, useScreenWidth } from '../panels/useScreenWidth';
import { useRoomForTheInbox } from '../roomForTheInbox';

/** The default theme in the shape a workspace carries it. */
const DEFAULT_WORKSPACE_THEME_COLORS = {
  color: DEFAULT_WORKSPACE_THEME.tint,
  bar: DEFAULT_WORKSPACE_THEME.bar,
  ground: DEFAULT_WORKSPACE_THEME.ground,
  header: DEFAULT_WORKSPACE_THEME.header,
};

/**
 * The id of the Inbox's heading, which is in the band while the column it names
 * is in the page below. Fixed rather than generated, because the two are in
 * different components and only one of them can own a `useId`.
 */
const INBOX_HEADING = 'the-inbox';

/** The four colors of a workspace, which is all the shell reads off one. */
type Painted = typeof DEFAULT_WORKSPACE_THEME_COLORS;

/**
 * What to paint a workspace in: its own four colors where they are a theme the
 * palette actually has, and otherwise the theme its tint belongs to.
 *
 * **The fallback is not decoration.** A workspace stores its surfaces resolved
 * rather than as a theme name, so a copy of one held from before the palette
 * changed carries the surfaces of the old palette - and the app paints from the
 * stored copy before the read behind it lands, which offline is a while. Under
 * the near-black chrome the text on it is a fixed light set, so those old pale
 * surfaces are not merely the wrong shade: they are a bar whose own text cannot
 * be read on it. Falling back to the tint's theme closes that window, and
 * closes the same hole for a workspace wearing a tint the palette never had.
 *
 * The tint itself is never overridden. It is the one color a person already
 * recognises in the tabs, and it is what the fallback is looked up by.
 */
function paint(workspace: Painted | undefined): Painted {
  if (!workspace) return DEFAULT_WORKSPACE_THEME_COLORS;
  const { color, bar, ground, header } = workspace;
  if (isPaletteTheme({ tint: color, bar, ground, header })) return workspace;
  const theme = themeOf(color);
  return { color, bar: theme.bar, ground: theme.ground, header: theme.header };
}

/**
 * The app shell: workspace tabs on top (the workspace color identity from the
 * functional definition's container hierarchy), the active workspace below.
 *
 * **The Inbox is part of the shell, not part of a page** ("Show the Inbox
 * beside the dashboards instead of as a tab", issue 117). Inside a workspace,
 * and where there is room for it, it is a column down the left of every screen
 * - the dashboards and the Inbox's own alike - because it is the thing
 * everything else flows out of rather than one more view to switch to.
 * Capture is the one screen under the shell that is in no workspace, so it
 * has no column: there is no Inbox to show.
 */
/**
 * The shell, and the one thing that wraps it: every row drawn below here can
 * ask for an Item's form, which is a change of address (`itemForm.tsx`).
 */
export function Layout() {
  return (
    <OpensItemForms>
      <TheShell />
    </OpensItemForms>
  );
}

function TheShell() {
  useServerEvents();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useQuery(workspacesQuery);
  const params = useParams({ strict: false });
  /**
   * Whether the Capture page is the page you are on, which is the only thing
   * that may fill its tab.
   *
   * Asked of the address rather than of `params`: Capture is the one screen
   * under the shell that is in no workspace, so there is nothing in `params` to
   * read it off. The page and anything under it, rather than that one string,
   * so a child route added later does not empty the tab while its own page is
   * on screen.
   */
  const onCapture = useRouterState({
    select: (state) => {
      const { pathname } = state.location;
      return pathname === '/capture' || pathname.startsWith('/capture/');
    },
  });
  const roomForTheInbox = useRoomForTheInbox();

  /**
   * How wide the Inbox column is drawn - the chosen preference, and the drag
   * in progress where there is one ("Let the Inbox column be resized
   * horizontally", issue 331).
   *
   * **Read once, from a lazy initializer, rather than an effect.** An effect
   * would paint the automatic width first and jump to the stored one a frame
   * later, which is exactly the flash `roomForTheInbox` itself exists to
   * avoid for the column's presence.
   */
  const [inboxWidth, setInboxWidth] = useState<number | null>(() =>
    readInboxWidth(browserStore()),
  );
  /**
   * The drag's own live number, kept apart from `inboxWidth` so an
   * interrupted drag - the browser taking the gesture back, or Escape - has
   * nothing committed to undo: it just stops updating and `inboxWidth` was
   * never touched.
   */
  const [dragPreview, setDragPreview] = useState<number | null>(null);
  /**
   * `startWidth` and `startX` never change once a drag is picked up: `latest`
   * is always `startWidth` clamped by however far `clientX` has moved from
   * `startX`, recomputed from those two fixed points on every move rather
   * than carried forward from the previous one.
   *
   * **Tried carrying it forward first, and that was the bug** (found in
   * review): clamping an accumulating total is not invertible - overshoot the
   * ceiling and bring the pointer back to exactly where the drag began, and
   * the clamped total does not come back to exactly `startWidth` with it, so
   * a round trip that visibly changed nothing still committed a different
   * number. Recomputing from the two fixed points instead is what a plain
   * `Math.min`/`Math.max` already is everywhere else in this file: `clamp(x)`
   * for the same `x` is always the same answer, so retracing a drag exactly
   * retraces what it showed - at the cost of the handle staying wherever it
   * clamped to until the pointer has retraced the *whole* overshoot, not
   * just enough of it to be back in range. That half is not a bug being
   * accepted here so much as it is every other drag-to-resize in this app,
   * native `resize: both` included (`itemFormSize.ts`): a size a drag pushed
   * past its limit stays at the limit until the pointer earns its way back.
   */
  const resizingFrom = useRef<
    { startWidth: number; startX: number; latest: number; pointerId: number } | null
  >(null);
  const inboxColumnRef = useRef<HTMLElement>(null);
  /**
   * How wide the row the column shares with the dashboard actually is - what
   * the cap in `inboxWidth.ts` is half of. Measured rather than derived, for
   * the reason `useMeasuredWidth`'s own doc comment gives: showing or hiding
   * the Inbox resizes the row without the window moving at all, and writing
   * the shell's own layout a second time in JavaScript is what this avoids.
   * The screen's width stands in until the row has been measured once.
   */
  const [measureRow, rowWidth] = useMeasuredWidth();
  const screenWidth = useScreenWidth();
  const availableRowWidth = rowWidth ?? screenWidth;
  /**
   * The same number, in a ref that is always this render's - read by the
   * drag's own `pointermove` handler below, which is declared once per drag
   * rather than once per render and would otherwise go stale exactly the way
   * a plain `useCallback` closing over `availableRowWidth` did (found in
   * review): a window resized while the pointer was still down left the
   * clamp comparing against the row's width from the moment the drag began.
   */
  const availableRowWidthRef = useRef(availableRowWidth);
  availableRowWidthRef.current = availableRowWidth;

  /** What picking the drag back up to nothing means, shared by every way out of one. */
  const clearInboxDrag = useCallback(() => {
    resizingFrom.current = null;
    setDragPreview(null);
  }, []);

  const takeInboxHandle = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // A second, distinct pointer landing on the handle while the first is
    // still down is not a second drag - `resizingFrom` has one owner, and
    // overwriting it here would leave the first pointer's moves and release
    // computed against this one's baseline instead of its own.
    if (resizingFrom.current) return;
    const column = inboxColumnRef.current;
    if (!column) return;
    event.preventDefault();
    const startWidth = column.getBoundingClientRect().width;
    resizingFrom.current = {
      startWidth,
      startX: event.clientX,
      latest: startWidth,
      pointerId: event.pointerId,
    };
    setDragPreview(startWidth);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Allowed to fail, as the panel resize's own capture is (PanelBoard.tsx):
      // the moves still arrive while the pointer is over the handle, which is
      // nearly all of the gesture.
    }
  }, []);

  /**
   * Let go: what is drawn is what is kept, verbatim.
   *
   * **Nothing is clamped here.** `onMove` below already brings every update
   * inside the floor and the row's current ceiling as it happens - clamping
   * again on release would be the same arithmetic a second time, and reading
   * the row's width to do it is exactly what went stale before (see
   * `availableRowWidthRef` above). A release with no `pointermove` in between
   * - a click, or a drag let go where it started - is the one case `onMove`
   * never touched `latest` at all, still equal to `startWidth`; that is not a
   * choice to pin a number, and must leave the automatic sizing exactly as
   * untouched as never having pressed the handle would have.
   */
  const commitInboxHandle = useCallback(() => {
    const held = resizingFrom.current;
    clearInboxDrag();
    if (!held || held.latest === held.startWidth) return;
    setInboxWidth(held.latest);
    writeInboxWidth(browserStore(), held.latest);
  }, [clearInboxDrag]);

  const resetInboxWidth = useCallback(() => {
    clearInboxDrag();
    setInboxWidth(null);
    writeInboxWidth(browserStore(), null);
  }, [clearInboxDrag]);

  /**
   * The gesture's other two ends, for the reason the panel resize's own are
   * (PanelBoard.tsx): once picked up, the moves and the release have to keep
   * arriving even where the pointer has left the handle - over the dashboard,
   * or off the window - and Escape abandons it the way it abandons the
   * innermost open thing everywhere else in the app.
   *
   * **Every handler here checks the event's own `pointerId` against the one
   * the drag was picked up with**, except Escape, which is a keyboard event
   * and has no pointer of its own (found in review): `resizingFrom`'s own
   * re-entrancy guard above only refuses a *second* `pointerdown` on the
   * handle, but nothing stopped a second pointer's `pointermove` or
   * `pointerup` firing here too - a second touch landing anywhere else on the
   * page while this drag was live would have been read as this drag's own
   * motion or release.
   *
   * Safe to gate the subscription on the boolean alone, unlike a first
   * version of this that gated the same way while `commitInboxHandle` still
   * closed over the row's measured width: every handler wired below is now
   * stable across a drag's whole lifetime, so which one is listening never
   * goes stale between the `pointerdown` that subscribes it and the
   * `pointerup` that fires it.
   */
  const draggingInbox = dragPreview !== null;
  useEffect(() => {
    if (!draggingInbox) return;
    const pointerId = resizingFrom.current?.pointerId;
    const ownsPointer = (event: PointerEvent) => event.pointerId === pointerId;
    const onMove = (event: PointerEvent) => {
      if (!ownsPointer(event)) return;
      const held = resizingFrom.current;
      if (!held) return;
      // From the two fixed points, not the previous move - see `resizingFrom`
      // above for why carrying `latest` forward instead was the bug.
      held.latest = clampInboxWidth(
        held.startWidth + (event.clientX - held.startX),
        availableRowWidthRef.current,
      );
      setDragPreview(held.latest);
    };
    const onUp = (event: PointerEvent) => {
      if (ownsPointer(event)) commitInboxHandle();
    };
    const onCancel = (event: PointerEvent) => {
      if (ownsPointer(event)) clearInboxDrag();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearInboxDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [draggingInbox, commitInboxHandle, clearInboxDrag]);

  /**
   * What the column is drawn at: the drag's own number while one is running,
   * the stored preference otherwise - both brought inside the row's current
   * bounds, and neither is `null` (the automatic sizing) while the other
   * holds a number.
   */
  const resolvedInboxWidth = dragPreview ?? inboxWidth;
  const inboxColumnStyle: React.CSSProperties | undefined =
    resolvedInboxWidth === null
      ? undefined
      : { width: clampInboxWidth(resolvedInboxWidth, availableRowWidth) };
  /**
   * `min-w-70` (280px, the same floor `INBOX_WIDTH_FLOOR` names in
   * inboxWidth.ts) stays in both cases - `clampInboxWidth` already guarantees
   * it once a width is chosen, but it is the only thing enforcing it for the
   * automatic sizing, which never goes near that function at all. `max-w-105`
   * (420px, the automatic sizing's own fixed ceiling) drops once there is a
   * chosen width: `inboxColumnStyle` already carries a ceiling of its own by
   * then, and a manual choice past 420px must not be fought by a class still
   * capping it there.
   */
  const inboxColumnClassName = `min-w-70 shrink-0${resolvedInboxWidth === null ? ' w-1/5 max-w-105' : ''}`;

  /**
   * Whether the account's list of types is open over the workspace, and the
   * control it was opened from - the header's own menu, which has nothing to
   * return the focus to by itself.
   *
   * Over the workspace rather than at an address of its own
   * (`components/ManageWindow.tsx`): the shell has one state, which is being
   * inside a workspace, and a page reached without one made it degrade into a
   * header wearing none of the workspace's colour, control or selected tab.
   */
  const [managing, setManaging] = useState<'types' | 'routingSummary' | null>(null);
  const settingsMenu = useRef<HTMLButtonElement>(null);
  /**
   * That the entry just chosen opens a window, so the menu closing must not
   * pull the focus back onto its own control - it would take it straight off
   * the window that has just opened.
   */
  const opening = useRef(false);

  /**
   * Who is signed in - and, when it comes back refused, that nobody is.
   *
   * **Nothing waits for it.** The screen below paints from the stored copy
   * first and this settles behind it, which is the standing never-block-paint
   * rule (architecture, "Performance budgets and the standing rules"): opening
   * the app on a train should show your work, not a spinner over an
   * unanswerable question. The cost of that is a moment where a sign-in that
   * has gone is not known to have gone, and the moment ends here.
   */
  const { data: me, error: sessionFailure } = useQuery(meQuery);
  const signedOut = sessionFailure instanceof NotSignedIn;

  /**
   * The workspace you are in, failing to be read - said once here for the whole
   * window rather than by each thing reading it.
   *
   * **Three components read this same snapshot** - the Inbox column, the
   * dashboard and the list its dashboards are managed in - and each used to
   * render its own notice, so one failed read put the same words on screen two
   * or three times,
   * in whatever width the box holding them happened to be. It is one read
   * (architecture, "The read model: persisted snapshot, revalidate, push") and
   * so it is one notice, and a screen added later gets it without knowing.
   *
   * Costs no request: it is the same query key those three already subscribe
   * to, so this is another reader of a cache entry rather than another fetch.
   *
   * **Only where there is a stored copy behind it.** With nothing to paint, the
   * route itself could not resolve and the failure screen already has the page
   * (router.tsx, `defaultErrorComponent`); adding this would be the duplicate
   * all over again, one column to its left.
   */
  const workspace = useQuery({
    ...snapshotQuery(params.workspaceId ?? ''),
    enabled: Boolean(params.workspaceId),
  });
  const workspaceUnread = Boolean(workspace.error) && workspace.data !== undefined;

  useEffect(() => {
    if (!signedOut) return;
    void navigate({ to: '/signin' });
  }, [signedOut, navigate]);

  const leave = useMutation({
    mutationFn: signOut,
    // `onSettled`, not `onSuccess`. Somebody who asked to sign out on a shared
    // machine has to end up signed out of *this browser* whether or not the
    // request reached the server - and if it did not, the sign-in it failed to
    // end expires on its own.
    //
    // Emptying what the browser holds is not done here but on the logon page,
    // which is the one screen with none of this mounted to write it back out
    // again; the reason is worth reading there before moving it.
    onSettled: () => navigate({ to: '/signin' }),
  });
  /**
   * The tab you are on, brought into view.
   *
   * The strip scrolls within itself rather than widening the page, so with
   * enough workspaces the one you are on can be outside the visible part of
   * it - and a tab joined to the strip below leaves a notch behind when it
   * scrolls away, which reads as broken rather than as cut off.
   *
   * **A callback ref rather than an effect on the workspace id.** The id
   * settles from the address before the workspace list has arrived, so an
   * effect keyed on it runs while there are no tabs at all and finds a null
   * ref; the tabs then appear and nothing scrolls. This fires when the node
   * itself mounts, which is the moment there is something to scroll to. The
   * browser found that: the tab was cut off at the edge of the strip with
   * seven workspaces, and every unit test passed, because jsdom has no
   * `scrollIntoView` to call in the first place.
   *
   * **And again once the font has landed.** Inter is loaded rather than
   * assumed, so between first paint and the swap every tab is measured in the
   * fallback face and then gets wider. A scroll computed before that lands
   * short by exactly however much the strip grew - fifty-one pixels, with
   * seven workspaces, which left the tab clipped at the edge in precisely the
   * way this exists to prevent. The first call is what makes it right when the
   * font is already cached; the second is what makes it right the first time.
   *
   * Both are optional-called and the promise is guarded: this is a
   * real-viewport behaviour, covered end to end, and neither `scrollIntoView`
   * nor `document.fonts` exists in jsdom.
   */
  const bringIntoView = useCallback((tab: HTMLAnchorElement) => {
    // Still the tab you are on when the font finally lands. Without this the
    // second pass scrolls to whichever tab was current when it was registered:
    // switch workspace inside that window - a few hundred milliseconds, and
    // the stored copy paints instantly - and the strip jumps back to the tab
    // you just left. The cleanup runs when this stops being the current tab,
    // which is exactly when the pending pass should stop meaning anything.
    let current = true;
    const bring = () => {
      if (current) tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    };
    bring();
    void document.fonts?.ready.then(bring).catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  const active = data?.workspaces.find((w) => w.id === params.workspaceId);
  /**
   * The workspace you are in, painted. Only the three surfaces move - the bar
   * across the top, the strip the dashboard tabs sit on, and the ground behind
   * the panels - plus the tint on the stripe, the dots and the selected tab.
   * Cards, rows, controls and text keep the fixed neutral and accent palette,
   * which is what makes a palette of designed sets enough to keep everything
   * legible - nothing else can be affected by the choice.
   *
   * The three run deepest at the top to lightest at the bottom, and the two tab
   * strips sit at the steps between them: a selected workspace tab is filled
   * with `bar` and meets the strip below it, a selected dashboard tab is filled
   * with `ground` and meets the page. That is what makes the container
   * hierarchy legible as depth rather than as two rows of pills on one fill
   * ("Modernise the app shell", issue 125).
   *
   * The shell carries them rather than `:root`, unlike the prototype: this
   * element covers the viewport, so painting it is enough, and a page that
   * writes to `document.documentElement` has to remember to clean up after
   * itself when there is no workspace to be in at all.
   *
   * With none - the moment before the list has arrived, and the capture screen,
   * which is in no workspace on purpose - it falls back to the default theme
   * rather than to nothing, so the app is never unpainted.
   */
  const theme = paint(active);

  return (
    <div
      className="flex h-dvh flex-col"
      // `--ground` and `--tint` beside the fill, because two things drawn far
      // below here are mixed from them rather than given them: the wells sunk
      // into the sheet (styles.css) and the lit tint a dot wears on the chrome.
      style={
        {
          backgroundColor: theme.ground,
          '--ground': theme.ground,
          '--tint': theme.color,
        } as React.CSSProperties
      }
    >
      {/* The strip the phone's own status bar sits over, painted the chrome's
          own colour so the chrome reaches the physical top edge rather than
          stopping at a letterbox (styles.css, `--edge-top`).

          Nothing is drawn in it, and it is outside the header rather than
          padding inside it, because the workspace's 3px tint stripe is the
          header's top border: padding would leave the stripe at the very top
          of the screen, three pixels of identity under forty-odd pixels of
          status bar. This way the stripe starts where the status bar ends. */}
      <div
        className="shrink-0"
        style={{ backgroundColor: theme.header, height: 'var(--edge-top)' }}
      />
      {/* No bottom border: the strip below ends in the selected dashboard tab,
          which is filled with the ground and has to meet the page without a
          line drawn between them.

          The side insets are here rather than on the row inside, which has the
          bar's own `px-3`: on a phone held sideways the notch eats one end of
          the strip, and the workspace tabs are what would go under it. */}
      <header
        style={{
          backgroundColor: theme.header,
          borderTopColor: theme.color,
          borderTopWidth: 3,
          borderTopStyle: 'solid',
          paddingInline: 'var(--edge-left) var(--edge-right)',
        }}
      >
        {/* Full width, not a centred column: the brand and the workspaces sit
            against the left edge and the menu against the right, so the header
            is a bar across the screen rather than a strip down the middle.

            `items-end` rather than `items-center`, because the tabs are not
            pills floating on the bar any more - they stand on its bottom edge
            so the selected one can run into the strip underneath. */}
        <div className="flex w-full items-end gap-4 px-3 pt-2">
          {/* **Gone on a phone**, where it is the only thing in the bar that
              does nothing. The header holds four things now - the name, the
              workspaces, Capture… and the menu ("Capture something before you
              know which workspace it belongs to", issue 165) - and at 375px
              that left the strip showing one whole tab and a letter of the
              next. The workspaces are what the bar is for, so the wordmark is
              what gives way; the logon page still says whose app this is. */}
          <span className="hidden shrink-0 pb-2 text-lg font-semibold tracking-tight text-chrome-ink sm:block">
            Cockpit
          </span>

          {/* First in the strip, ahead of every workspace, and ruled off from
              them: what it captures belongs to no workspace, so it is not one
              more of them and cannot sit among them ("Capture something before
              you know which workspace it belongs to", issue 165; "Cockpit Shell
              Explorations", artboard 2c). It was a filled button after the tabs,
              which read as a control on the bar rather than as the first place
              you land.

              Outside the Workspaces navigation rather than inside it, for the
              same reason: it is not a workspace, and the strip beside it scrolls
              within itself, which would carry Capture off the screen.

              **A tab now, not a window** ("Capture Page", artboard 2a): it goes
              to a screen of its own (pages/CapturePage.tsx), so the ellipsis
              that meant a window opens has gone with the window.

              **Wherever there is a workspace to have been captured from**,
              rather than only inside one - which is what lets it stay in the
              strip while you are on it. With no workspaces at all there is
              nowhere to capture from, and the address answers that by sending
              you to the page that makes one (router.tsx).

              **The same box a workspace tab has**, which is why both take it
              from `stripTabClass`. The header is an `items-end` row, so its
              height is whatever its tallest child is: six pixels of extra
              padding here pushed the whole page down by six.

              **Filled only while you are on it**, which is every other tab's
              rule and was not this one's: it wore the lifted tint at all times,
              so on startup - which is inside a workspace - the loudest tab in
              the strip named a page nobody was on. What says it is not a
              workspace is the rule beside it and the dot it does not have. */}
          {(data?.workspaces.length ?? 0) > 0 && (
            <>
              <Link
                to="/capture"
                className={`${stripTabClass(onCapture)} self-end px-4`}
                style={
                  onCapture
                    ? ({
                        backgroundColor: theme.bar,
                        '--tab-mark': litForChrome(theme.color),
                      } as React.CSSProperties)
                    : undefined
                }
              >
                Capture
              </Link>
              <span
                aria-hidden="true"
                className="mx-2 mb-2 h-5 w-px shrink-0 self-end bg-white/15"
              />
            </>
          )}
          {/* Scrolls within itself rather than widening the page. Until
              workspaces could be made, three of them fit any screen and this
              was a plain row; the fourth one pushed a 480px phone to 571px and
              took the whole page sideways with it.

              The scrollbar itself is hidden, the way a tab strip's is
              everywhere: drag, trackpad and keyboard focus all still move it,
              and the full list is in the window the menu opens, so the
              bar would cost a permanent grey slab under the tabs to say
              something the tabs already show by being cut off. */}
          {/* Named, because it is not the only bar of links in this header: the
              dashboards of the workspace you are in sit under it, and two
              unnamed navigations are two identical landmarks to choose between.
              The name is what says which is which, and it is what the walks
              reach for when they ask what order the workspaces are in. */}
          {/* The tabs and everything that can be done to one are the strip's
              own (components/WorkspaceTabs.tsx). The shell keeps what is about
              the shell: which workspace is open, what it is painted in, and
              the `+` that makes another. */}
          <WorkspaceTabs bar={theme.bar} bringIntoView={bringIntoView}>
            <AddWorkspace />
          </WorkspaceTabs>

          {/* The same control as every other menu in the app (components/
              Menu.tsx). It used to be a bordered pill, given that weight
              because three faint characters did not read as a control - which
              an icon with a hover and a focus state does without inventing a
              second look for the one menu in the header. */}
          <DropdownMenu.Root>
            <MenuTrigger label="Settings" onChrome ref={settingsMenu} />
            <MenuContent
              onCloseAutoFocus={(event) => {
                const claimed = opening.current;
                opening.current = false;
                if (claimed) event.preventDefault();
              }}
            >
              {/* An entry rather than a link: it opens a window over the
                  workspace instead of replacing it, so managing the types is a
                  detour and not a journey - and there is no address to come
                  back from.

                  **The workspaces are not here.** They were, beside this, and
                  the list they opened is gone: a workspace is changed on its
                  own tab, which is a press away rather than two
                  (components/WorkspaceTabs.tsx). The types keep a window
                  because they have no tab - they belong to the account and are
                  chosen while capturing, not switched between ("Manage the
                  types, and put them in the order you want", issue 156). */}
              <DropdownMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  opening.current = true;
                  setManaging('types');
                }}
              >
                Manage types
              </DropdownMenu.Item>
              {/* Workspace-scoped, unlike Manage types above - the decision
                  history a nightly job summarizes belongs to one Workspace
                  (`docs/routing-learning.md` §13 decision 1), so this is
                  offered only while one is open ("Show what the system
                  learned, in a sentence you can correct", issue 301). */}
              {params.workspaceId && (
                <DropdownMenu.Item
                  className={menuItemClass}
                  onSelect={() => {
                    opening.current = true;
                    setManaging('routingSummary');
                  }}
                >
                  What Cockpit has learned
                </DropdownMenu.Item>
              )}
              {/* A link rather than an entry that opens a window, and the only
                  one here: the admin pages are about the environment rather
                  than this account, so there is no workspace to keep behind
                  them and an address of their own is what a screen has ("See
                  who can sign in, on a page only an admin can open", issue
                  230).

                  **Offered to an admin only, and that is a courtesy rather
                  than the guard.** What refuses an ordinary user is the server
                  (auth/admin.ts); hiding the entry just keeps a door in front
                  of them that only ever says no. */}
              {me?.user.role === ADMIN && (
                <DropdownMenu.Item asChild className={menuItemClass}>
                  <Link to="/admin">Admin</Link>
                </DropdownMenu.Item>
              )}
              {/* Who you are, and the way out. Both in the menu rather than on
                  the bar: the tabs are the thing you use all day and the header
                  is already full on a phone, while this is read once when you
                  wonder whose Cockpit you are looking at. */}
              <DropdownMenu.Separator className="my-1 h-px bg-black/10" />
              <DropdownMenu.Label className="px-2 py-1 text-xs text-ink-faint">
                {me ? `Signed in as ${me.user.name}` : 'Signed in'}
              </DropdownMenu.Label>
              <DropdownMenu.Item onSelect={() => leave.mutate()} className={menuItemClass}>
                Sign out
              </DropdownMenu.Item>
            </MenuContent>
          </DropdownMenu.Root>
        </div>
      </header>
      {/* The band, under the workspace tabs and on the same color, so the tab
          and this strip are one surface. Full width, because that is what the
          selected workspace tab joins onto and because the band belongs to the
          workspace rather than to either column under it.

          **The dashboard tabs inside it start where the dashboard starts.**
          They used to run from the left edge, which put them above the Inbox -
          and the Inbox is the workspace's, identical on every dashboard, so
          tabs sitting over it said they governed something they do not. What
          holds that space open is now the Inbox's own name and count, joined to
          the column below it exactly as a selected tab is joined to the sheet
          ("Cockpit Shell Explorations", artboard 2c): the band is a row of
          headings, and the Inbox is the leftmost of them. With no room for the
          Inbox there is no column to head, and the screen it opens instead
          carries its name itself (pages/WorkspacePage.tsx).

          **Drawn at every address under the shell, and empty where there is
          nothing to put in it.** Capture is deliberately in no workspace
          ("Capture something before you know which workspace it belongs to",
          issue 165), so it has no dashboards to tab between and no Inbox to
          head - and a band left out there would take forty pixels off the
          chrome between two addresses of the same app, which is what its
          minimum height is for ("Stop the capture page wearing the settings
          pages' chrome", pull request 191). Managing the account is not an
          address at all any more but a window over whatever you were on
          (components/ManageWindow.tsx), which is what took away the shell's
          other workspace-less state. */}
      <div
        // As tall as a menu control standing on it - `pt-1` above one of the
        // 36px triggers, with its own `mb-1` under it - which is what the
        // dashboards' side comes to on its own. Said here so an address with
        // nothing to draw in the band comes to the same thing.
        className="flex min-h-11 w-full items-end"
        // Inset the same way the header above it is, so the Inbox's heading
        // still lines up with the column it heads and the first dashboard tab
        // does not go under a sideways phone's notch.
        style={{
          backgroundColor: theme.bar,
          paddingInline: 'var(--edge-left) var(--edge-right)',
        }}
      >
        {params.workspaceId && (
          <>
            {roomForTheInbox && (
              <div
                className={`ml-1 ${inboxColumnClassName} bg-[color-mix(in_srgb,var(--ground)_90%,var(--tint))] px-4 pt-2 pb-1.5`}
                style={inboxColumnStyle}
              >
                <InboxHeading workspaceId={params.workspaceId} id={INBOX_HEADING} />
              </div>
            )}
            <DashboardBar
              workspaceId={params.workspaceId}
              tint={theme.color}
              ground={theme.ground}
              openDashboardId={params.dashboardId ?? null}
            />
          </>
        )}
      </div>
      {/* Left-aligned and full width, matching the header: pages get the whole
          screen instead of a centred column with empty gutters either side.

          Two columns where there is room for two ("Show the Inbox beside the
          dashboards instead of as a tab", issue 117). Each scrolls on its own,
          which is the point of the split: a long Inbox never pushes the
          dashboard off the screen, and a tall dashboard never scrolls the
          Inbox away. */}
      {/* Above the columns and across both, because it is about the workspace
          they are both showing rather than about either of them. */}
      {workspaceUnread && (
        // The seam's own width, plus whatever the screen's sides take. Said
        // here rather than inherited, because this sits above `main` and so is
        // outside the one place the columns get it from - and written as
        // Tailwind's own step, so it cannot drift from the `p-1` below it.
        <div
          className="pt-1"
          style={{
            paddingInline:
              'calc(var(--spacing) + var(--edge-left)) calc(var(--spacing) + var(--edge-right))',
          }}
        >
          <LoadFailure error={workspace.error} onRetry={() => void workspace.refetch()} />
        </div>
      )}
      {/* One sheet, in the workspace's ground, with the columns' own hollows the
          only thing breaking it up ("Cockpit Shell Explorations", artboard 2c).
          Four pixels of padding rather than twelve and twenty: the panels are
          not cards floating with air around them any more, so the space between
          them is a seam rather than a margin, and what it used to buy - room for
          each card's shadow - is not needed by a surface that has none.

          The side insets widen that seam rather than replacing it, and they are
          said once here for both columns so neither is asked whether it is the
          one against the edge - which changes with the width, since below 768px
          there is only one. The sheet itself still runs to the screen's edge. */}
      <main
        ref={measureRow}
        className="flex w-full min-h-0 flex-1 gap-1 p-1"
        style={{
          paddingInline:
            'calc(var(--spacing) + var(--edge-left)) calc(var(--spacing) + var(--edge-right))',
        }}
      >
        {params.workspaceId && roomForTheInbox && (
          <>
            <aside
              ref={inboxColumnRef}
              // Named by the heading up in the band rather than by a label of
              // its own, so the name a person reads and the name a screen
              // reader announces are the same string in one place.
              aria-labelledby={INBOX_HEADING}
              // A fifth of the width by default, with a floor and a ceiling:
              // 20% of a 1280px screen is 256px, which an item row cannot
              // hold, and 20% of a very wide one is more Inbox than anybody
              // asked for. `inboxColumnStyle` carries the same floor and a
              // dragged ceiling once there is a chosen width (inboxWidth.ts).
              // The bottom inset is padding on the scroller rather than on the
              // sheet: padding on the sheet would end the well above the home
              // indicator and leave a dead strip there, where this lets the well
              // run to the screen's edge, the list scroll through it, and the
              // last row still stop clear of it.
              className={`well-inbox ${inboxColumnClassName} overflow-y-auto pb-[var(--edge-bottom)]`}
              style={inboxColumnStyle}
            >
              <InboxPanel workspaceId={params.workspaceId} />
            </aside>
            {/* The line between the Inbox and the dashboard, and the one place
                the column is actually resized from - the band above only
                mirrors whatever width this settles on ("Let the Inbox column
                be resized horizontally", issue 331).

                Reaches four pixels either side the way the panel row's own
                divider does (`ColumnLine`, PanelBoard.tsx), so a hand has more
                than its own couple of pixels to aim at without widening the
                row itself. `touch-none` keeps a finger's drag from scrolling
                the page instead of moving the handle - the Inbox column
                itself is deliberately left free to scroll under a finger, so
                only this line gives that up.

                Keyboard operation of the resize itself is out of scope here -
                Escape still abandons a drag already picked up, for the reason
                given above where that is wired in. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Drag to resize the Inbox, double-click to reset its width"
              onPointerDown={takeInboxHandle}
              onDoubleClick={resetInboxWidth}
              // `w-2` rather than the bare zero-width box the panel row's own
              // divider gets away with (`ColumnLine`, PanelBoard.tsx): that one
              // sits in a CSS grid track that supplies its width for it, where
              // this sits in a flex row with nothing to borrow from - and a
              // genuinely zero-width element is one Playwright's own click
              // actionability (found in testing) as well as a real pointer
              // refuses to call visible at all.
              className="group relative z-10 w-2 shrink-0 cursor-col-resize touch-none"
            >
              <div className="absolute inset-y-0 -left-1 -right-1" />
              <div className="absolute inset-y-2 left-1/2 w-[2px] -translate-x-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover:opacity-60 group-active:opacity-100" />
            </div>
          </>
        )}
        {/* Same bottom inset as the Inbox column, for the same reason.

            Every address under the shell gets the sheet now. The two that
            wanted a column of prose width instead were the settings pages, and
            they are windows over the workspace rather than addresses
            (components/ManageWindow.tsx) - so the shell no longer has to ask
            which kind of page this is. */}
        <div className="min-w-0 flex-1 overflow-y-auto pb-[var(--edge-bottom)]">
          <Outlet />
        </div>
      </main>

      {/* The account's list of types, over the workspace rather than instead
          of it. Here rather than in a page, because there is no page: the
          shell is the one thing that is always drawn inside a workspace. */}
      <ManageTypes
        open={managing === 'types'}
        onClose={() => setManaging(null)}
        returnFocusTo={settingsMenu.current}
      />

      {/* The current Workspace's own filing-pattern summary and correction
          ("Show what the system learned, in a sentence you can correct",
          issue 301) - over the workspace for the same reason Manage types
          is, and only ever opened while one is open, so `params.workspaceId`
          is never absent when this is asked for. */}
      {params.workspaceId && (
        <RoutingSummaryWindow
          workspaceId={params.workspaceId}
          open={managing === 'routingSummary'}
          onClose={() => setManaging(null)}
          returnFocusTo={settingsMenu.current}
        />
      )}

      {/* The Item's form, drawn over whatever the address below resolves to and
          opened by that same address (`itemForm.tsx`). Here rather than in the
          lists, because there is one form open at a time. */}
      <ItemForm />
    </div>
  );
}

/**
 * The `+` at the end of the workspace tabs, and the dialog it opens.
 *
 * **Adding a workspace was reachable only through the header's menu**, two
 * presses in, on the deliberate grounds that you make three or four workspaces
 * in a lifetime and a control for that does not earn a place on the chrome.
 * What changed is that the same dialog now says *what a workspace is*, and an
 * account arrives holding one - so the explanation sat behind a door nobody new
 * would open, which is the one case that reasoning did not cover. It is also
 * the asymmetry that made workspaces feel hidden: the dashboards have a `+` on
 * the strip below this one, and the panels one at its right.
 *
 * **The rest of what can be done to one is on the tab itself**, exactly as it
 * is for dashboards: adding is a one-gesture thing you do from the strip the
 * new tab will appear on, and renaming, recolouring, moving and deleting are
 * the tab's own menu (components/WorkspaceTabs.tsx).
 */
function AddWorkspace() {
  const [naming, setNaming] = useState<string | null>(null);
  const command = useCommand();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);

  const add = () => {
    const trimmed = (naming ?? '').trim();
    if (!trimmed) return;
    // Made here rather than inside the payload, so the workspace to open is
    // known before the answer comes back.
    const workspaceId = uuidv7();
    command.mutate(
      {
        name: 'create_workspace',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          // The panel its first dashboard arrives with.
          panelId: uuidv7(),
          name: trimmed,
        },
      },
      {
        onSuccess: async () => {
          setNaming(null);
          // Re-read before going there, for the reason adding a dashboard does
          // (components/DashboardBar.tsx): the workspace route checks the id
          // against the list in hand, and the list in hand is the one from
          // before this workspace existed.
          await queryClient.refetchQueries({ queryKey: ['workspaces'] });
          void navigate({ to: '/w/$workspaceId', params: { workspaceId } });
        },
      },
    );
  };

  return (
    <>
      <button
        type="button"
        ref={button}
        onClick={() => {
          command.reset();
          setNaming('');
        }}
        aria-label="Add a workspace"
        className="mb-1 shrink-0 rounded-md px-2.5 py-1 text-sm text-chrome-ink-faint hover:bg-white/10 hover:text-chrome-ink"
      >
        +
      </button>
      <NameQuestion
        open={naming !== null}
        question="What is the new workspace called?"
        explains={WHAT_A_WORKSPACE_IS}
        fieldLabel="Name of the new workspace"
        placeholder="Work, Personal, a customer…"
        submitLabel="Add"
        name={naming ?? ''}
        onNameChange={setNaming}
        onSubmit={add}
        onCancel={() => setNaming(null)}
        refusal={refusalFrom(command)}
        busy={command.isPending}
        returnFocusTo={button.current}
      />
    </>
  );
}
