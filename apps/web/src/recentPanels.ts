/**
 * The panels most recently filed into, per workspace, so filing repeatedly into
 * the same one is one tap ("Panels hold the items filed into them, and the
 * Inbox holds the rest", issue 36).
 *
 * **Remembered in the browser, not in the database**, for the reason the last
 * visited view is (see lastVisited.ts): which dashboard you last filed into on
 * a phone is not the one you were filing into at a desk, and storing it would
 * be a write, an invalidation and a push on every move for something no other
 * device benefits from.
 *
 * The storage is handed in rather than reached for, so the deciding is provable
 * without a browser and a private window is a picker with no recent list rather
 * than one that throws.
 */

/**
 * Three, which is what the picker shows above the tree.
 *
 * Not a scrolling history: the point is that the panel you want is one of the
 * two or three you have been using, and a longer list is a second thing to read
 * rather than a shortcut past reading.
 */
export const RECENT_PANELS_KEPT = 3;

const KEY = 'cockpit.recent-panels.';

/**
 * The list with this panel at its head - most recent first, no duplicates,
 * capped.
 *
 * Pure, and the whole decision. Filing into a panel already in the list moves
 * it to the front rather than adding it again, which is what keeps three
 * entries three *panels*.
 */
export function withMostRecent(
  remembered: readonly string[],
  panelId: string,
): string[] {
  return [panelId, ...remembered.filter((id) => id !== panelId)].slice(0, RECENT_PANELS_KEPT);
}

/**
 * What was remembered for one workspace, oldest entries dropped.
 *
 * Anything that is not a list of strings answers "nothing remembered": the
 * value is a browser's, so it can be half-written, from an older version, or
 * hand-edited, and none of those is worth failing a picker over.
 */
export function recentPanelsIn(store: Storage | undefined, workspaceId: string): string[] {
  try {
    const held: unknown = JSON.parse(store?.getItem(KEY + workspaceId) ?? '[]');
    if (!Array.isArray(held)) return [];
    return held.filter((id): id is string => typeof id === 'string').slice(0, RECENT_PANELS_KEPT);
  } catch {
    return [];
  }
}

export function rememberRecentPanel(
  store: Storage | undefined,
  workspaceId: string,
  panelId: string,
): void {
  try {
    const next = withMostRecent(recentPanelsIn(store, workspaceId), panelId);
    store?.setItem(KEY + workspaceId, JSON.stringify(next));
  } catch {
    // Not remembering is a smaller thing than failing to file.
  }
}

/**
 * Forgets every workspace's recent panels.
 *
 * Signing out has to leave nothing of the person behind, and where they file
 * things is about them. Written as "remove the keys that are ours" rather than
 * `clear()`, because the storage is the origin's.
 */
export function forgetEveryRecentPanel(store: Storage | undefined): void {
  try {
    if (!store) return;
    const ours: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key?.startsWith(KEY)) ours.push(key);
    }
    for (const key of ours) store.removeItem(key);
  } catch {
    // A browser that refuses storage remembered nothing to forget.
  }
}
