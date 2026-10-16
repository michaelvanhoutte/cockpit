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
    const panels = (snapshot.panels ?? []).filter(panelTakesItems);
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
