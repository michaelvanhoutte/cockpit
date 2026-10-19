import { panelTakesItems, filingsThatFile } from '@cockpit/shared';
import type { Filing, Panel } from '@cockpit/shared';

/**
 * The Item form's *On panels* field ("List and change an Item's Panels in its
 * form, in place of Shown on", issue 1106). Calculations only: the form holds the
 * snapshot and the edits, and sends the commands.
 */

/** One Panel an Item is filed on, or is to be. */
export interface PanelOn {
  panelId: string;
  name: string;
}

/** What the form has changed and not yet sent: the Panels to file on, and to take off. */
export interface PanelEdits {
  added: PanelOn[];
  removed: string[];
}

export const NO_PANEL_EDITS: PanelEdits = { added: [], removed: [] };

export const hasPanelEdits = (edits: PanelEdits) => edits.added.length > 0 || edits.removed.length > 0;

/**
 * The Panels the Item is filed on, in the order the snapshot holds Panels.
 * **Only Panels that take Items**: a Filter that shows the Item is not a place it
 * is filed, and a filing onto one files nothing (`filingsThatFile`).
 */
export function panelsFiledOn(itemId: string, filings: readonly Filing[], panels: readonly Panel[]): PanelOn[] {
  const mine = new Set(
    filingsThatFile(filings, panels)
      .filter((filing) => filing.itemId === itemId)
      .map((filing) => filing.panelId),
  );
  return panels
    .filter((panel) => panelTakesItems(panel) && mine.has(panel.id))
    .map((panel) => ({ panelId: panel.id, name: panel.name }));
}

/** What the field shows: the Panels held, less those taken off, plus those added. */
export function panelsWithEdits(held: readonly PanelOn[], edits: PanelEdits): PanelOn[] {
  return [
    ...held.filter((one) => !edits.removed.includes(one.panelId)),
    ...edits.added.filter((one) => !held.some((there) => there.panelId === one.panelId)),
  ];
}

/** Filing on a Panel: putting back one taken off cancels that, and one already shown changes nothing. */
export function afterAdding(edits: PanelEdits, held: readonly PanelOn[], one: PanelOn): PanelEdits {
  if (panelsWithEdits(held, edits).some((there) => there.panelId === one.panelId)) return edits;
  return held.some((there) => there.panelId === one.panelId)
    ? { ...edits, removed: edits.removed.filter((id) => id !== one.panelId) }
    : { ...edits, added: [...edits.added, one] };
}

/** Taking one off: an added one that was never sent just goes, and a held one is to be taken off. */
export function afterRemoving(edits: PanelEdits, held: readonly PanelOn[], panelId: string): PanelEdits {
  if (edits.added.some((one) => one.panelId === panelId)) {
    return { ...edits, added: edits.added.filter((one) => one.panelId !== panelId) };
  }
  return held.some((one) => one.panelId === panelId) && !edits.removed.includes(panelId)
    ? { ...edits, removed: [...edits.removed, panelId] }
    : edits;
}
