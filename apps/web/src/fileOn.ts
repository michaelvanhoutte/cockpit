import { panelTakesItems } from '@cockpit/shared';
import type { Workspace, WorkspaceSnapshot } from '@cockpit/shared';

/**
 * What Capture's *File on* searches ("File a note on Panels from Capture,
 * skipping the Inbox", issue 1101): the Panels of Items of every Dashboard of the
 * chosen Workspace, or of every Workspace under *Any workspace*. Calculations
 * only: the snapshots are read by the component, which hands in what it holds.
 */

/** One Panel *File on* can offer, with where it is. */
export interface FileOnOption {
  panelId: string;
  name: string;
  dashboardName: string;
  workspaceId: string;
  workspaceName: string;
}

/** One Workspace's snapshot as held, or undefined where it is not (yet) readable. */
export interface HeldWorkspace {
  workspace: Workspace;
  snapshot: WorkspaceSnapshot | undefined;
}

/**
 * The Panels on offer, in tab order, then Dashboard order, then the order the
 * snapshot holds Panels in. **Filters and Panels of text are never offered**:
 * nothing is filed into either. `where` is the Workspace chosen, or null for
 * *Any workspace*; `leftOut` names the Workspaces in scope whose snapshot is not
 * held, which is what offline looks like for one never read.
 */
export function panelsToFileOn(
  held: readonly HeldWorkspace[],
  where: string | null,
): { options: FileOnOption[]; leftOut: string[] } {
  const inScope = held.filter((one) => where === null || one.workspace.id === where);
  const options: FileOnOption[] = [];
  const leftOut: string[] = [];
  for (const { workspace, snapshot } of inScope) {
    if (!snapshot) {
      leftOut.push(workspace.name);
      continue;
    }
    const panels = snapshot.panels.filter(panelTakesItems);
    for (const dashboard of snapshot.dashboards) {
      for (const panel of panels) {
        if (panel.dashboardId !== dashboard.id) continue;
        options.push({
          panelId: panel.id,
          name: panel.name,
          dashboardName: dashboard.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        });
      }
    }
  }
  return { options, leftOut };
}

/**
 * What typing narrows the options to: a Panel whose name, Dashboard or
 * Workspace holds what was typed, and not the ones already chosen. Order is kept,
 * so the first is the top match Enter adds.
 */
export function matchingPanels(
  options: readonly FileOnOption[],
  typed: string,
  chosen: readonly string[],
): FileOnOption[] {
  const needle = typed.trim().toLowerCase();
  const has = (text: string) => text.toLowerCase().includes(needle);
  return options.filter(
    (option) =>
      !chosen.includes(option.panelId) &&
      (needle === '' || has(option.name) || has(option.dashboardName) || has(option.workspaceName)),
  );
}

/** Where *+ New panel* would make the Panel, or why it cannot say. */
export type NewPanelOffer =
  | {
      kind: 'make';
      name: string;
      workspaceId: string;
      workspaceName: string;
      dashboardId: string;
      dashboardName: string;
    }
  | { kind: 'ask'; reason: string };

/** Typed between the parts of a path: the ▸ the lists draw, or > that a keyboard has. */
const PATH_SEPARATOR = /\s*[▸>]\s*/;

/**
 * What the last option of the search, **+ New panel “…”**, would do with what
 * is typed ("Make a new Panel from Capture's File on", issue 1103): the text
 * after the last ▸ is the Panel's name, read the way **Move to…**'s + names one.
 * Null while there is no name to make a Panel of.
 *
 * Where it is made is said by the path before the name:
 *
 * | Typed | Made on |
 * |---|---|
 * | `Name` | the Dashboard you are on, in the Workspace chosen, or in the one Capture was opened from under *Any workspace* |
 * | `Dashboard ▸ Name` | that Dashboard of the same Workspace |
 * | `Workspace ▸ Dashboard ▸ Name` | that Dashboard of that Workspace (the Workspace chosen, or any under *Any workspace*) |
 *
 * `onDashboardOf` is the Dashboard you were last on in a Workspace, which is
 * where Capture, being a page of its own, has to read "the one you are on" from
 * (`lastVisited.ts`). Under *Any workspace* a plain name with none to read asks
 * for the whole path rather than guessing.
 */
export function newPanelOffer(
  typed: string,
  held: readonly HeldWorkspace[],
  where: string | null,
  from: string | null,
  onDashboardOf: (workspaceId: string, dashboards: readonly { id: string }[]) => string | null,
): NewPanelOffer | null {
  const parts = typed.trim().split(PATH_SEPARATOR);
  const name = (parts.pop() ?? '').trim();
  if (name === '') return null;
  if (parts.length > 2) return { kind: 'ask', reason: 'Say it as Workspace ▸ Dashboard ▸ Name.' };

  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  // The Workspace: the path's own, else the one chosen, else the one Capture was opened from.
  let target: HeldWorkspace | undefined;
  if (parts.length === 2) {
    const wanted = parts[0]!;
    target = held.find((one) => same(one.workspace.name, wanted));
    if (!target) return { kind: 'ask', reason: `No Workspace called “${wanted}”.` };
    if (where !== null && target.workspace.id !== where) {
      const chosen = held.find((one) => one.workspace.id === where)?.workspace.name ?? 'the chosen Workspace';
      return { kind: 'ask', reason: `Capture is on ${chosen}: leave “${wanted} ▸” off, or choose Any workspace.` };
    }
  } else {
    const id = where ?? from;
    target = held.find((one) => one.workspace.id === id);
  }

  const asksForTheWholePath = { kind: 'ask', reason: 'Say where: Workspace ▸ Dashboard ▸ Name.' } as const;
  if (!target) return asksForTheWholePath;
  const { workspace, snapshot } = target;
  if (!snapshot) return { kind: 'ask', reason: `${workspace.name} is not read yet, so a Panel cannot be made on it.` };

  let dashboard: { id: string; name: string } | undefined;
  if (parts.length === 0) {
    // Under Any workspace the remembered Dashboard has to be a real one; with a Workspace chosen the first stands in.
    const remembered = onDashboardOf(workspace.id, snapshot.dashboards);
    dashboard = snapshot.dashboards.find((one) => one.id === remembered);
    if (!dashboard && where === null) return asksForTheWholePath;
    dashboard ??= snapshot.dashboards[0];
  } else {
    const wanted = parts[parts.length - 1]!;
    dashboard = snapshot.dashboards.find((one) => same(one.name, wanted));
    if (!dashboard) return { kind: 'ask', reason: `No Dashboard called “${wanted}” in ${workspace.name}.` };
  }
  if (!dashboard) return { kind: 'ask', reason: `${workspace.name} has no Dashboard to make it on.` };
  return {
    kind: 'make',
    name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    dashboardId: dashboard.id,
    dashboardName: dashboard.name,
  };
}
