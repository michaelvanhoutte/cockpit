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
}

/**
 * A name as matching compares it: case folded as every name in Cockpit is,
 * `&` read as `and`, and runs of whitespace as one space, so "admin and money"
 * names *Admin & money*. Nothing else is loosened.
 */
export function matchKey(name: string): string {
  return foldName(name.replace(/&/g, ' and ').replace(/\s+/g, ' '));
}

/**
 * The Panels these names file an Item on: for each name, the one Panel of
 * Items in the Workspace it matches. A name matching none, or Panels on two
 * Dashboards, files nothing. A Filter and a Panel of text are never matched.
 * Each Panel once, in the order of the names.
 */
export function panelsNamedBy(names: readonly string[], panels: readonly NamedTarget[]): string[] {
  const takers = panels.filter((panel) => panelTakesItems(panel));
  const chosen: string[] = [];
  for (const name of names) {
    const key = matchKey(name);
    const matching = takers.filter((panel) => matchKey(panel.name) === key);
    if (matching.length !== 1) continue;
    const panelId = matching[0]!.id;
    if (!chosen.includes(panelId)) chosen.push(panelId);
  }
  return chosen;
}

/**
 * The names reported now that were not among those recorded before, or none
 * where nothing was recorded: a first report is the baseline, and files
 * nothing. Compared as matching compares them, so a name only re-cased is
 * not new.
 */
export function namesNewSince(recorded: readonly string[] | null, reported: readonly string[]): string[] {
  if (recorded === null) return [];
  const before = new Set(recorded.map(matchKey));
  return reported.filter((name) => !before.has(matchKey(name)));
}

/** The names as a link keeps them: trimmed, the empty ones dropped, each once. */
export function namesToRecord(reported: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of reported) {
    const name = raw.trim();
    if (!name || seen.has(matchKey(name))) continue;
    seen.add(matchKey(name));
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
