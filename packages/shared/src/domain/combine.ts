import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH, itemLabel, type Item } from './item.js';
import type { Filing, Panel } from './panel.js';

/**
 * Combine ("Brainstorming: related loose notes can't be brought together",
 * issue 1826): what the dialog works out before it sends one change. Claude's
 * writing of the description comes in a later issue, so until then the texts
 * are stitched from the parts and what the person adds.
 */

/** Cut to `max` characters, never between the halves of one. */
function cutAt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Cut to a Panel's name length, with an ellipsis where it was cut. */
function clipped(text: string): string {
  return text.length <= NAME_MAX_LENGTH ? text : `${cutAt(text, NAME_MAX_LENGTH - 1).trimEnd()}…`;
}

/** The new Item's title: the first Item's, and how many more are with it. */
export function combinedTitle(items: readonly Pick<Item, 'title'>[]): string {
  const first = items[0] ? itemLabel(items[0]) : 'Items';
  return clipped(`Combined: ${first}${items.length > 1 ? ` +${items.length - 1}` : ''}`);
}

/** "“A”, “B” and “C”", for a sentence naming the parts. */
function namedParts(items: readonly Pick<Item, 'title'>[]): string {
  const titles = items.map((item) => `“${itemLabel(item)}”`);
  return titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : (titles[0] ?? '');
}

/** Cut to what a description may hold. */
const withinADescription = (text: string): string => cutAt(text, DESCRIPTION_MAX_LENGTH);

/** What the person typed under "Anything to add?", on one line. */
function addedWords(note: string): string {
  return note.trim().replace(/\s+/g, ' ');
}

/**
 * A Merge's description, stitched: what the person added, then each part under
 * its own title, in the order picked. Never empty, and never past what a
 * description may hold.
 */
export function stitchedDescription(items: readonly Pick<Item, 'title' | 'description'>[], note: string): string {
  const parts = items.map((item) => {
    const words = item.description?.trim();
    return words ? `${itemLabel(item)}\n${words}` : itemLabel(item);
  });
  const added = addedWords(note);
  return withinADescription([...(added ? [added] : []), ...parts].join('\n\n'));
}

/** A new parent's description: which Items it brings together, and what the person added. */
export function parentDescription(items: readonly Pick<Item, 'title'>[], note: string): string {
  const added = addedWords(note);
  return withinADescription(`This brings together ${namedParts(items)}.${added ? ` ${added}` : ''}`);
}

/**
 * The Panel of the open Dashboard the first Item is filed on, or the first one
 * it is filed on anywhere, which a new parent is filed on as a row; none
 * where it came from the Inbox, where the new parent then stays. Filings only: a Filter's Items are filed
 * elsewhere.
 */
export function panelTheFirstIsOn(
  firstId: string | undefined,
  dashboardId: string | null,
  filings: readonly Pick<Filing, 'panelId' | 'itemId'>[],
  panels: readonly Pick<Panel, 'id' | 'dashboardId'>[],
): string | null {
  if (!firstId) return null;
  const onIt = filings.filter((filing) => filing.itemId === firstId).map((filing) => filing.panelId);
  const here = onIt.find((panelId) => panels.some((panel) => panel.id === panelId && panel.dashboardId === dashboardId));
  return here ?? onIt.find((panelId) => panels.some((panel) => panel.id === panelId)) ?? null;
}

/** The Item among these that comes from a source, which a Merge refuses: it is finished at its source, not here. */
export function itemFromASource<T extends Pick<Item, 'source'>>(items: readonly T[]): T | undefined {
  // An app's capture over MCP (`mcp`) has no source it finishes at, so it merges as a note does.
  return items.find((item) => item.source !== 'internal' && item.source !== 'mcp');
}
