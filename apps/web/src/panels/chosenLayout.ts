/**
 * Which layout a dashboard is being drawn with, when somebody has said ("Panels
 * on a dashboard, with per-screen-size layouts", issue 33).
 *
 * **Remembered in the browser, not in the database**, for the reason the last
 * view of a workspace is (lastVisited.ts) - and here the reason is the whole
 * feature. Layouts exist because the phone and the 4K screen want different
 * arrangements; storing "I am looking at the wide one" would push that choice
 * onto every other device, which is exactly what the automatic choice is there
 * to avoid.
 *
 * The storage is handed in rather than reached for, so the deciding is provable
 * without a browser and so a private window, or a browser that refuses storage,
 * is a dashboard drawn with the closest layout rather than one that throws.
 */

const KEY = 'cockpit.layout.';

/** The layout chosen by hand for this dashboard, or null for "whichever fits". */
export function chosenFor(store: Storage | undefined, dashboardId: string): string | null {
  try {
    return store?.getItem(KEY + dashboardId) ?? null;
  } catch {
    return null;
  }
}

/** `null` puts the dashboard back on whichever layout fits the screen it is on. */
export function chooseLayout(
  store: Storage | undefined,
  dashboardId: string,
  layoutId: string | null,
): void {
  try {
    if (layoutId === null) store?.removeItem(KEY + dashboardId);
    else store?.setItem(KEY + dashboardId, layoutId);
  } catch {
    // Not remembering is a smaller thing than not drawing the dashboard.
  }
}
