import { PANELS_A_NOTE_FILES_ON, panelTakesItems, type PanelKind } from '@cockpit/shared';
import { foldName } from './names.js';

/**
 * Pure handlers for the place a captured note names - its workspace, dashboard
 * and panels ("File a capture on the panels you name, read from the spoken
 * path", issue 1116). The model maps the words onto real names; whether those
 * names point to one place is decided here, never by the model.
 */

/** One live Workspace a capture may reach, with its live Dashboards and their live Panels, by name. */
export interface PlaceTreeWorkspace {
  id: string;
  name: string;
  dashboards: readonly {
    id: string;
    name: string;
    panels: readonly { id: string; name: string; kind: PanelKind }[];
  }[];
}

/** The names the model read from the note's place words; `null` or empty where it read none. */
export interface PlaceNamed {
  workspace: string | null;
  dashboard: string | null;
  panels: readonly string[];
}

/** Where the note goes: the Workspace it settles in, and the Panels it is filed on - each empty where nothing is settled. */
export interface PlaceResolved {
  workspaceId: string | null;
  panelIds: string[];
}

/**
 * Where the names point, among the Workspaces a capture may reach.
 *
 * **Each part said narrows; a name that matches nothing is ignored.** A
 * Workspace named narrows to it, a Dashboard named narrows to the Dashboards of
 * that name, and each Panel is filed on only where exactly one Panel that takes
 * items answers to its name in what is left. A Dashboard is never filed on.
 *
 * **Every Panel filed on is in one Workspace**, since an Item is in one: Panels
 * found in two, with no Workspace said, file nothing.
 *
 * **The Workspace settles** where it was named, or where the Panels filed on
 * are, or where a Dashboard named is in exactly one Workspace.
 */
export function resolveSpokenPath(tree: readonly PlaceTreeWorkspace[], named: PlaceNamed): PlaceResolved {
  const workspaceNamed = named.workspace === null ? [] : sameName(tree, named.workspace);
  const workspaces = workspaceNamed.length === 1 ? workspaceNamed : tree;

  const everyDashboard = workspaces.flatMap((workspace) =>
    workspace.dashboards.map((dashboard) => ({ ...dashboard, workspaceId: workspace.id })),
  );
  const dashboardNamed = named.dashboard === null ? [] : sameName(everyDashboard, named.dashboard);
  const dashboards = dashboardNamed.length > 0 ? dashboardNamed : everyDashboard;

  const filed: { id: string; workspaceId: string }[] = [];
  for (const panelName of new Set(named.panels.map(foldName))) {
    const answering = dashboards.flatMap((dashboard) =>
      dashboard.panels
        .filter((panel) => panelTakesItems(panel) && foldName(panel.name) === panelName)
        .map((panel) => ({ id: panel.id, workspaceId: dashboard.workspaceId })),
    );
    if (answering.length === 1) filed.push(answering[0]!);
  }
  const filedIn = new Set(filed.map((panel) => panel.workspaceId));
  // The first ones said, up to what the filing command takes, so an answer
  // naming more never fails the reading it rides on.
  const panelIds = filedIn.size === 1 ? filed.slice(0, PANELS_A_NOTE_FILES_ON).map((panel) => panel.id) : [];

  const dashboardIn = new Set(dashboardNamed.map((dashboard) => dashboard.workspaceId));
  const workspaceId =
    workspaceNamed.length === 1
      ? workspaceNamed[0]!.id
      : filedIn.size === 1
        ? [...filedIn][0]!
        : dashboardIn.size === 1
          ? [...dashboardIn][0]!
          : null;

  return { workspaceId, panelIds };
}

function sameName<T extends { name: string }>(among: readonly T[], name: string): T[] {
  const folded = foldName(name);
  return among.filter((one) => foldName(one.name) === folded);
}
