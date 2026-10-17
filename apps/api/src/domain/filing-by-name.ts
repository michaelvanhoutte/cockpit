import { panelTakesItems, type PanelKind } from '@cockpit/shared';
import { foldName } from './names.js';

/**
 * Filing what a connection brings in on the Panel named after its label or
 * category ("File Outlook mail on the Panel named after its category", issue
 * 1146). Pure: the store reads the names and the Panels, and this says which
 * Panels they name and which names are new.
 *
 * The connector reports names in the source's own spelling; the host never
 * knows what a label or a category is, only that a person typed these words.
 */

/** A Panel of the connection's Workspace, as loaded: what it is called, what it is made of, and which Dashboard it is on. */
export interface NamedTarget {
  id: string;
  name: string;
  kind: PanelKind;
  dashboardId: string;
  dashboardName: string;
}

/**
 * A name as matching compares it: case folded as every name in Cockpit is,
 * accents dropped, `&` read as `and`, and runs of whitespace as one space, so
 * "admin and money" names *Admin & money* and `prive` names *Privé*. Nothing
 * else is loosened.
 *
 * The accent fold is a rule of matching alone: `foldName` decides whether two
 * names are the same name across the app, and *Privé* and *Prive* stay two.
 */
export function matchKey(name: string): string {
  return nameKey(name.normalize('NFD').replace(/\p{M}/gu, ''));
}

/**
 * A name as a link's recorded names are compared: matching without the accent
 * fold. A name differing from a recorded one by an accent alone is still new,
 * so correcting `Prive` to `Privé` on an Item files it, as it did before
 * matching ignored accents.
 */
function nameKey(name: string): string {
  return foldName(name.replace(/&/g, ' and ').replace(/\s+/g, ' '));
}

/** A matching key with the spaces around its hyphens dropped, which is how a Dashboard and a Panel are joined: `Cubico - Tasks` is `Cubico-Tasks`. */
function tight(key: string): string {
  return key.replace(/\s*-\s*/g, '-');
}

/** The ways a connector's names may read, as its manifest declares them. */
export interface NameForms {
  /** A name may qualify a Panel by the Dashboard it lives on: `Cubico-Tasks`. */
  byDashboard: boolean;
}

/**
 * Why a name filed nothing ("Name each category a check read, and whether it
 * filed or why it skipped", issue 1197): no Panel carries it; Panels of Items
 * carry it (`dashboards` of them hold one); it is the mark the connection
 * follows; it was on the Item before filing was ticked; filing by name is
 * off; or the Item is on the Panel it names already. `pairs`: the name reads
 * as more than one Panel once a Dashboard may qualify it (`panels` of them).
 */
export type SkipWhy = 'no-panel' | 'several' | 'pairs' | 'followed' | 'baseline' | 'off' | 'already-there';

/**
 * What one name did, as a check's line keeps it: filed on `panel` (of
 * `dashboard`), or skipped for `why`. Panel and Dashboard are named as they
 * were when it happened, since the line is a record of that moment.
 */
export interface NameOutcome {
  name: string;
  panel: string | null;
  dashboard: string | null;
  why: SkipWhy | null;
  /** How many Dashboards hold a Panel the name matches, where it matched several. */
  dashboards: number | null;
  /** How many Panels the name matched, where it matched several as Dashboard-qualified. */
  panels: number | null;
}

/**
 * Settles each name against the Workspace's Panels, in order: what it did, and
 * the Panels (each once) the Item is to be added to. `skipAll` is a reason that
 * holds whatever the name matches (filing off, no baseline); `alreadyOn` the
 * Panels the Item is on, which a name is not filed on again.
 */
export function whatNamesDid(
  names: readonly string[],
  panels: readonly NamedTarget[],
  how: { skipAll: 'off' | 'baseline' | null; alreadyOn: ReadonlySet<string>; forms?: NameForms },
): { outcomes: NameOutcome[]; panelIds: string[] } {
  const takers = panels.filter((panel) => panelTakesItems(panel));
  const outcomes: NameOutcome[] = [];
  const panelIds: string[] = [];
  const skipped = (name: string, why: SkipWhy, dashboards: number | null = null, panels: number | null = null): NameOutcome => ({
    name,
    panel: null,
    dashboard: null,
    why,
    dashboards,
    panels,
  });
  for (const name of names) {
    if (how.skipAll) {
      outcomes.push(skipped(name, how.skipAll));
      continue;
    }
    const key = matchKey(name);
    const plain = takers.filter((panel) => matchKey(panel.name) === key);
    // Only the Dashboard a Panel lives on qualifies it, not one that shows it.
    const qualified = how.forms?.byDashboard
      ? takers.filter((panel) => `${tight(matchKey(panel.dashboardName))}-${tight(matchKey(panel.name))}` === tight(key))
      : [];
    const matching = [...new Map([...plain, ...qualified].map((panel) => [panel.id, panel])).values()];
    if (matching.length === 0) {
      outcomes.push(skipped(name, 'no-panel'));
      continue;
    }
    if (matching.length > 1) {
      outcomes.push(
        qualified.length > 0
          ? skipped(name, 'pairs', null, matching.length)
          : skipped(name, 'several', new Set(matching.map((panel) => panel.dashboardId)).size),
      );
      continue;
    }
    const panel = matching[0]!;
    const there = how.alreadyOn.has(panel.id);
    outcomes.push({
      name,
      panel: panel.name,
      dashboard: panel.dashboardName,
      why: there ? 'already-there' : null,
      dashboards: null,
      panels: null,
    });
    if (!there && !panelIds.includes(panel.id)) panelIds.push(panel.id);
  }
  return { outcomes, panelIds };
}

/**
 * The names reported now that were not among those recorded before, or none
 * where nothing was recorded: a first report is the baseline, and files
 * nothing. Compared as matching compares them, so a name only re-cased is
 * not new.
 */
export function namesNewSince(recorded: readonly string[] | null, reported: readonly string[]): string[] {
  if (recorded === null) return [];
  const before = new Set(recorded.map(nameKey));
  return reported.filter((name) => !before.has(nameKey(name)));
}

/** The names as a link keeps them: trimmed, the empty ones dropped, each once. */
export function namesToRecord(reported: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of reported) {
    const name = raw.trim();
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    kept.push(name);
  }
  return kept;
}

/** A link's recorded names, read defensively: anything but an array of strings is no baseline. */
export function recordedNames(stored: string | null): string[] | null {
  if (stored === null) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) && parsed.every((one) => typeof one === 'string') ? parsed : null;
  } catch {
    return null;
  }
}
