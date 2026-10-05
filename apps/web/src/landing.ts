/** Where a bare `/` goes: the one decision, made without a browser or a router. */
export type Landing =
  | { to: 'start' }
  | { to: 'capture' }
  | { to: 'workspace'; workspaceId: string };

/**
 * Where Cockpit opens when the address says nowhere in particular ("Open
 * Cockpit on the Capture page on a phone", issue 644).
 *
 * **A phone opens on Capture, because jotting something down is what it is
 * opened for** (docs/product/inbox.md). Where there is room for the Inbox beside
 * the dashboards it is a desk, and opens on the first workspace as it always
 * has. The width is the Inbox's own (`roomForTheInbox.ts`), so a browser that
 * cannot say answers the phone shape.
 *
 * **An account with no workspaces comes before either** and goes to the screen
 * that makes one: Capture is only for an account that has somewhere to capture
 * from.
 *
 * **Only a bare `/` lands.** A link to a dashboard, the Inbox or a workspace
 * goes where it says, and a workspace that was deleted goes to a surviving one
 * through `survivingWorkspace`, never through here.
 */
export function whereToLand(
  workspaces: readonly { id: string; name: string }[],
  roomForTheInbox: boolean,
): Landing {
  const first = workspaces[0];
  if (!first) return { to: 'start' };
  if (!roomForTheInbox) return { to: 'capture' };
  return { to: 'workspace', workspaceId: first.id };
}

/**
 * Where to go once the workspace you were on is gone: a workspace that is still
 * there, or the screen that makes one. Never Capture - you were deleting a
 * workspace, not asking to jot something down.
 */
export function survivingWorkspace(
  workspaces: readonly { id: string }[],
): { to: 'start' } | { to: 'workspace'; workspaceId: string } {
  const first = workspaces[0];
  return first ? { to: 'workspace', workspaceId: first.id } : { to: 'start' };
}
