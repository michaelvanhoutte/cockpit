import { panelTakesItems } from '@cockpit/shared';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import type { PanelOpening } from './captureOpener';
import { CAPTURE_PANEL, CAPTURE_WORKSPACE } from './captureAddressWords';

/**
 * Capture opened from an address ("Read a Panel from an app allowed only to
 * read, and open Capture from its address", issue 1445): `/capture?workspace=<id>`
 * and, for a Panel of items, `&panel=<id>`. What an installed widget's **+** opens,
 * and so **a contract that stays**: an address already on somebody's home screen
 * has to go on opening Capture where it said.
 *
 * It does what a Panel's own **+** does - *Where* is that Workspace, *File on*
 * that Panel, and Capture closes to the Panel's Dashboard once one note is
 * kept - by arriving as the same navigation state (`captureState.ts`), so
 * nothing about the form is told twice.
 *
 * | Address names | Capture opens with |
 * |---|---|
 * | a Workspace and a Panel of items there | *Where* that Workspace, *File on* the Panel |
 * | a Workspace alone, as from a Filter panel | *Where* that Workspace, *File on* empty |
 * | a Workspace and a Panel since deleted, or no Panel of items | *Where* that Workspace, *File on* empty |
 * | a Workspace this account does not have | nothing: Capture opens as a typed `/capture` does |
 *
 * **What the address cannot name is dropped, never refused**: a widget outlives
 * the Panel it was placed for, and Capture is still where its person wanted to
 * write the note.
 */

export { CAPTURE_PANEL, CAPTURE_WORKSPACE };

/** The id a search holds under `name`, or null where it holds none that is text. */
export function addressedBy(search: Record<string, unknown>, name: string): string | null {
  const held = search[name];
  return typeof held === 'string' && held !== '' ? held : null;
}

/** What the address says, before any of it is checked against what the account holds. */
export function addressNames(search: Record<string, unknown>): { workspaceId: string | null; panelId: string | null } {
  return { workspaceId: addressedBy(search, CAPTURE_WORKSPACE), panelId: addressedBy(search, CAPTURE_PANEL) };
}

/**
 * What the address opens Capture with, once checked against the account's
 * Workspaces and the named Workspace's own Panels - `snapshot` is undefined
 * where that read is not to hand, which leaves *File on* empty and the
 * Workspace as named.
 */
export function captureOpenedBy(
  search: Record<string, unknown>,
  workspaces: readonly { id: string }[],
  snapshot: Pick<WorkspaceSnapshot, 'panels'> | undefined,
): { captureFrom: string; captureOn?: PanelOpening } | null {
  const { workspaceId, panelId } = addressNames(search);
  if (!workspaceId || !workspaces.some((workspace) => workspace.id === workspaceId)) return null;
  const panel = panelId ? snapshot?.panels.find((one) => one.id === panelId && panelTakesItems(one)) : undefined;
  if (!panel) return { captureFrom: workspaceId };
  return {
    captureFrom: workspaceId,
    captureOn: { panelId: panel.id, name: panel.name, workspaceId, dashboardId: panel.dashboardId },
  };
}
