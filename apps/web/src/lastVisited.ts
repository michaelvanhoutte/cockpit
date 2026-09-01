/**
 * Which view of a workspace you were last on, so that coming back to the
 * workspace brings you back to it ("Add and switch dashboards", issue 32).
 *
 * **Remembered in the browser, not in the database, and that is a decision.**
 * The dashboard you want on your phone is often not the one you left open on
 * the desktop, and storing it would mean a write, an invalidation and a push on
 * every switch for something no other device benefits from.
 *
 * The storage is handed in rather than reached for, so the deciding is provable
 * without a browser and so a private window or a browser that refuses storage
 * is a workspace that opens on its first dashboard rather than one that throws.
 */

/** What a workspace can be showing: its pinned Inbox, or one of its dashboards. */
export type View = { on: 'inbox' } | { on: 'dashboard'; dashboardId: string };

export const INBOX: View = { on: 'inbox' };

const KEY = 'cockpit.last-visited.';

/**
 * Where to open a workspace: what you were last on there if it is still there,
 * and its first dashboard otherwise.
 *
 * Pure, and the whole decision. A dashboard that has since been deleted, a
 * workspace never opened, and a remembered value from a browser that has been
 * cleared all arrive here as "nothing usable", and all three answer the same
 * way.
 *
 * A workspace with no dashboards at all cannot happen - every workspace is
 * created with one - but answering the Inbox rather than throwing is what keeps
 * that a rule of the data instead of a crash if it is ever broken.
 */
export function viewToOpen(
  remembered: string | null,
  dashboards: readonly { id: string }[],
): View {
  if (remembered === 'inbox') return INBOX;
  if (remembered && dashboards.some((d) => d.id === remembered)) {
    return { on: 'dashboard', dashboardId: remembered };
  }
  const first = dashboards[0];
  return first ? { on: 'dashboard', dashboardId: first.id } : INBOX;
}

/** What `viewToOpen` reads back, for one workspace. */
export function rememberedIn(store: Storage | undefined, workspaceId: string): string | null {
  try {
    return store?.getItem(KEY + workspaceId) ?? null;
  } catch {
    // A browser that refuses storage is one that remembers nothing, which is
    // a workspace opening on its first dashboard - not a workspace that fails
    // to open at all.
    return null;
  }
}

export function rememberView(
  store: Storage | undefined,
  workspaceId: string,
  view: View,
): void {
  try {
    store?.setItem(KEY + workspaceId, view.on === 'inbox' ? 'inbox' : view.dashboardId);
  } catch {
    // Nothing to do and nothing to say: not remembering is a smaller thing
    // than failing to switch.
  }
}

/**
 * Forgets every workspace's remembered view.
 *
 * Signing out has to leave nothing of the person behind, and this is the only
 * thing about them the app writes outside the query cache. Written as "remove
 * the keys that are ours" rather than `clear()`, because the storage is the
 * origin's and clearing it would take anything else living there with it.
 */
export function forgetEveryView(store: Storage | undefined): void {
  try {
    if (!store) return;
    const ours: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(KEY)) ours.push(key);
    }
    for (const key of ours) store.removeItem(key);
  } catch {
    // A browser that refuses storage is one that remembered nothing to forget.
  }
}

/** The browser's own storage, where there is one. */
export function browserStore(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
