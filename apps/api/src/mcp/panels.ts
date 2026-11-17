import {
  NAME_MAX_LENGTH,
  panelGathers,
  panelPlace,
  panelTakesItems,
  panelsInBoardOrder,
  type ReadableWorkspace,
} from '@cockpit/shared';
import { foldName } from '../domain/names.js';

/**
 * How a connected app names a Panel ("MCP changes and deletes: name Panels in
 * update_item and create_item", issue 1812): by the name `find_items` takes,
 * case folded, within one Workspace, and where several Panels share it as
 * `Dashboard ▸ Panel`, the form the All items tab draws. A decision over the
 * account's Workspaces, Dashboards and Panels as the store lists them, so it is
 * proved at L1 (tests/unit/mcp/panels.test.ts).
 *
 * | Given | Means |
 * |---|---|
 * | `Admin` | the one Panel taking Items called that, in the Workspace in scope |
 * | `Work ▸ Admin` | that Dashboard's Panel (a Workspace's name stands in the same place under *Any workspace*, where it is the first part of three) |
 * | `Home ▸ Work ▸ Admin` | that Workspace's Dashboard's Panel, where every Workspace is in scope |
 *
 * **A name shared is refused, never guessed**, with every match in the form that
 * would have settled it, and so is a name no Panel has or one of a Panel that
 * takes no Items (a Filter or text Panel): each lists the Panels that do.
 */

/** A Panel that takes Items, with where it is. */
export interface PanelChoice {
  id: string;
  name: string;
  dashboard: string;
  workspaceId: string;
  workspace: string;
}

interface Candidate extends PanelChoice {
  kind: 'items' | 'filter' | 'text';
}

/** The longest a given Panel name may be: the three names of `Workspace ▸ Dashboard ▸ Panel` and their separators. */
export const PANEL_GIVEN_MAX_LENGTH = 3 * NAME_MAX_LENGTH + 8;

/** The most Panels a list names, so an account with a great many is not told every one. */
export const MOST_PANELS_LISTED = 100;

const quoted = (name: string) => JSON.stringify(name);

/** Every Panel of the Workspaces in scope, in the order the Dashboards draw them. */
function candidates(catalogue: readonly ReadableWorkspace[], workspaceId: string | null): Candidate[] {
  return catalogue
    .filter((one) => workspaceId === null || one.workspace.id === workspaceId)
    .flatMap((one) => {
      const dashboards = new Map(one.dashboards.map((dashboard) => [dashboard.id, dashboard.name]));
      return panelsInBoardOrder(one).map((panel) => ({
        id: panel.id,
        name: panel.name,
        dashboard: dashboards.get(panel.dashboardId) ?? '',
        workspaceId: one.workspace.id,
        workspace: one.workspace.name,
        kind: panel.kind,
      }));
    });
}

/** The Panels that take Items among those in scope. */
function taking(all: readonly Candidate[]): Candidate[] {
  return all.filter((panel) => panelTakesItems(panel));
}

/**
 * Each Panel's name in a list: bare, or as `Dashboard ▸ Panel` where another
 * Panel of its Workspace goes by the same name, so what is listed is what the
 * call can name.
 */
function labelsOf(panels: readonly Candidate[]): string[] {
  const shared = new Map<string, number>();
  for (const panel of panels) {
    const key = `${panel.workspaceId}\u0000${foldName(panel.name)}`;
    shared.set(key, (shared.get(key) ?? 0) + 1);
  }
  return panels.map((panel) =>
    (shared.get(`${panel.workspaceId}\u0000${foldName(panel.name)}`) ?? 0) > 1
      ? panelPlace(panel.dashboard, panel.name)
      : panel.name,
  );
}

/** The listed Panels as text: `"Admin", "Day to day ▸ Calls"`, and under every Workspace, each Workspace's own. */
function listed(panels: readonly Candidate[], byWorkspace: boolean): string {
  const shown = panels.slice(0, MOST_PANELS_LISTED);
  const labels = labelsOf(panels).slice(0, MOST_PANELS_LISTED);
  const more = panels.length - shown.length;
  const tail = more > 0 ? ` and ${more} more` : '';
  if (!byWorkspace) return labels.map(quoted).join(', ') + tail;
  const groups = new Map<string, string[]>();
  shown.forEach((panel, i) => groups.set(panel.workspace, [...(groups.get(panel.workspace) ?? []), quoted(labels[i]!)]));
  return [...groups].map(([workspace, names]) => `${workspace}: ${names.join(', ')}`).join('; ') + tail;
}

/**
 * Every Workspace's Panels that take Items, for a tool's description: each
 * Workspace with its Panels by name, the shared ones as `Dashboard ▸ Panel`;
 * "none yet" where no Workspace has one.
 */
export function describePanels(catalogue: readonly ReadableWorkspace[]): string {
  const panels = taking(candidates(catalogue, null));
  if (panels.length === 0) return 'none yet';
  const withPanels = new Set(panels.map((panel) => panel.workspaceId));
  const empty = catalogue.filter((one) => !withPanels.has(one.workspace.id)).map((one) => `${one.workspace.name}: none yet`);
  const full = listed(panels, true);
  return [full, ...empty].join('; ');
}

/** Whether there are more Panels than a list names, so an `enum` of them would leave some out and a validating client would refuse a Panel the call accepts. */
export function namesLeftOut(catalogue: readonly ReadableWorkspace[]): boolean {
  return taking(candidates(catalogue, null)).length > MOST_PANELS_LISTED;
}

/**
 * The names a validating client may be allowed for a Panel: each Panel as it is
 * listed, and, where a listed name is shared by Panels of different Workspaces
 * (which only an Item on *Any workspace* can meet), each of those in full as
 * `Workspace ▸ Dashboard ▸ Panel`. Empty with no Panel or with `namesLeftOut`, so a tool leaves the
 * `enum` out rather than state an empty or a partial one.
 */
export function panelNamesAllowed(catalogue: readonly ReadableWorkspace[]): string[] {
  const panels = taking(candidates(catalogue, null));
  if (namesLeftOut(catalogue)) return [];
  const labels = labelsOf(panels);
  const workspacesOf = new Map<string, Set<string>>();
  panels.forEach((panel, i) => {
    const key = foldName(labels[i]!);
    workspacesOf.set(key, (workspacesOf.get(key) ?? new Set()).add(panel.workspaceId));
  });
  const names: string[] = [];
  panels.forEach((panel, i) => {
    names.push(labels[i]!);
    if ((workspacesOf.get(foldName(labels[i]!))?.size ?? 0) > 1) {
      names.push(`${panel.workspace} ▸ ${panelPlace(panel.dashboard, panel.name)}`);
    }
  });
  return [...new Set(names)];
}

export type FoundPanel = { ok: true; panel: PanelChoice } | { ok: false; refusal: string };

const refused = (refusal: string): FoundPanel => ({ ok: false, refusal });

/** The Panels that take Items, said for a refusal, in the Workspace in scope or in every one. */
function whatThereIs(all: readonly Candidate[], scope: { name: string } | null): string {
  const panels = taking(all);
  const where = scope === null ? '' : ` in the workspace ${quoted(scope.name)}`;
  return panels.length
    ? `The Panels${where} that take items are ${listed(panels, scope === null)}.`
    : `There are no Panels${where} that take items yet.`;
}

/**
 * The one Panel `given` names, among the Panels of `workspaceId` or, with null,
 * of every Workspace: an Item that has a Workspace may be filed in its own only,
 * and one on *Any workspace* in any, which then settles it there.
 */
export function findPanel(
  catalogue: readonly ReadableWorkspace[],
  workspaceId: string | null,
  given: string,
): FoundPanel {
  const name = given.trim();
  const all = candidates(catalogue, workspaceId);
  const scope = workspaceId === null ? null : { name: catalogue.find((one) => one.workspace.id === workspaceId)?.workspace.name ?? '' };
  const there = whatThereIs(all, scope);
  if (name === '' || name.length > PANEL_GIVEN_MAX_LENGTH) {
    return refused(`A Panel is named by its name, at most ${PANEL_GIVEN_MAX_LENGTH} characters with its Dashboard and Workspace. ${there}`);
  }

  const bare = all.filter((panel) => foldName(panel.name) === foldName(name));
  let matches = bare;
  let qualified = false;
  if (bare.length === 0 && name.includes('▸')) {
    const parts = name.split('▸').map((part) => part.trim());
    const [workspace, dashboard, panel] = parts.length === 3 ? parts : [undefined, ...parts];
    if (parts.length === 2 || parts.length === 3) {
      qualified = true;
      matches = all.filter(
        (one) =>
          foldName(one.name) === foldName(panel ?? '') &&
          foldName(one.dashboard) === foldName(dashboard ?? '') &&
          (workspace === undefined || foldName(one.workspace) === foldName(workspace)),
      );
    }
  }

  if (matches.length === 0) {
    return refused(`No Panel is called ${quoted(name)}. ${there}`);
  }
  const takers = taking(matches);
  if (takers.length === 0) {
    const kind = panelGathers(matches[0]!) ? 'a Filter panel, which gathers items' : 'a text Panel, which holds none';
    return refused(`${quoted(matches[0]!.name)} is ${kind}, so it takes no items. ${there}`);
  }
  if (takers.length === 1) {
    const { kind: _kind, ...panel } = takers[0]!;
    return { ok: true, panel };
  }

  // Said in the form that would have settled it: the Workspace too where the matches are of several.
  const several = new Set(takers.map((panel) => panel.workspaceId)).size > 1;
  const forms = takers.map((panel) => {
    const place = panelPlace(panel.dashboard, panel.name);
    return several ? `${panel.workspace} ▸ ${place}` : place;
  });
  const asked = qualified && !several
    ? 'Panels of that name sit on one Dashboard, so they cannot be told apart; rename one in Cockpit'
    : `Name one as ${several ? 'Workspace ▸ Dashboard ▸ Panel' : 'Dashboard ▸ Panel'}`;
  return refused(`Several Panels are called ${quoted(name)}: ${forms.join('; ')}. ${asked}.`);
}
