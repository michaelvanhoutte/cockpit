import { itemLabel, type WorkspaceSnapshot } from '@cockpit/shared';
import type { BoardBox, BoardCard, BoardLine } from '@cockpit/shared/board';

/**
 * Where a Dashboard's whiteboard draws its boxes and cards ("Brainstorming:
 * give every Dashboard a whiteboard of its own", issue 1829), worked out from
 * the Workspace's read alone. A card or box inside a box is placed relative to
 * that box's top left corner, as the board library nests them too.
 */

export const CARD_W = 220;
export const BOX_HEAD = 40;
export const GRID = 20;
/** The smallest box Draw box makes, so a stray click draws none and a drag a usable one. */
export const MIN_BOX = { w: 160, h: 100 };

export interface Board {
  boxes: BoardBox[];
  cards: BoardCard[];
  /** Its free lines ("Brainstorming: the whiteboard can't show how Items connect", issue 1831). */
  lines: BoardLine[];
}

/** One Dashboard's boxes, parents before what they hold, its cards and its free lines. A box naming a parent not on the board sits on open space. */
export function boardOf(snapshot: WorkspaceSnapshot | undefined, dashboardId: string): Board {
  const all = snapshot?.whiteboards;
  const boxes = (all?.boxes ?? []).filter((box) => box.dashboardId === dashboardId);
  const ids = new Set(boxes.map((box) => box.id));
  const placed = boxes.map((box) => (box.parentBoxId && !ids.has(box.parentBoxId) ? { ...box, parentBoxId: null } : box));
  const depth = (box: BoardBox) => {
    let d = 0;
    for (let at = box.parentBoxId; at && d < placed.length; d += 1) at = placed.find((one) => one.id === at)?.parentBoxId ?? null;
    return d;
  };
  const cards = (all?.cards ?? [])
    .filter((card) => card.dashboardId === dashboardId)
    .map((card) => (card.boxId && !ids.has(card.boxId) ? { ...card, boxId: null } : card));
  const lines = (all?.lines ?? []).filter((line) => line.dashboardId === dashboardId);
  return { boxes: [...placed].sort((a, b) => depth(a) - depth(b)), cards, lines };
}

/** A box's top left corner on the board itself, adding up the boxes it sits in. */
export function originOf(boxes: readonly BoardBox[], boxId: string | null): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let at = boxes.find((box) => box.id === boxId), steps = 0; at && steps <= boxes.length; steps += 1) {
    x += at.x;
    y += at.y;
    const parent = at.parentBoxId;
    at = parent ? boxes.find((box) => box.id === parent) : undefined;
  }
  return { x, y };
}

/** The box and every box inside it, to any depth. */
export function boxesWithin(boxes: readonly BoardBox[], boxId: string): Set<string> {
  const within = new Set([boxId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const box of boxes) {
      if (box.parentBoxId && within.has(box.parentBoxId) && !within.has(box.id)) {
        within.add(box.id);
        grew = true;
      }
    }
  }
  return within;
}

/** Whether something in this box is hidden by it or a box around it being collapsed. */
export function hiddenByCollapse(boxes: readonly BoardBox[], boxId: string | null): boolean {
  for (let at = boxes.find((box) => box.id === boxId), steps = 0; at && steps <= boxes.length; steps += 1) {
    if (at.collapsed) return true;
    const parent = at.parentBoxId;
    at = parent ? boxes.find((box) => box.id === parent) : undefined;
  }
  return false;
}

/**
 * The innermost box a point on the board falls in, leaving out `skip` (a box
 * being moved and what it holds) and anything a collapsed box hides; a
 * collapsed box is only its header.
 */
export function boxAt(boxes: readonly BoardBox[], point: { x: number; y: number }, skip: ReadonlySet<string> = new Set()): BoardBox | null {
  let found: BoardBox | null = null;
  let deepest = -1;
  for (const box of boxes) {
    if (skip.has(box.id) || hiddenByCollapse(boxes, box.parentBoxId)) continue;
    const at = originOf(boxes, box.id);
    const h = box.collapsed ? BOX_HEAD : box.h;
    if (point.x < at.x || point.y < at.y || point.x > at.x + box.w || point.y > at.y + h) continue;
    let depth = 0;
    for (let up = box.parentBoxId; up; up = boxes.find((one) => one.id === up)?.parentBoxId ?? null) depth += 1;
    if (depth > deepest) {
      found = box;
      deepest = depth;
    }
  }
  return found;
}

/** A point on the board, relative to the box it lands in (none: the board's own origin), kept below a box's header. */
export function relativeTo(boxes: readonly BoardBox[], box: BoardBox | null, point: { x: number; y: number }): { x: number; y: number } {
  if (!box) return { x: Math.round(point.x), y: Math.round(point.y) };
  const at = originOf(boxes, box.id);
  return { x: Math.round(Math.max(8, point.x - at.x)), y: Math.round(Math.max(BOX_HEAD, point.y - at.y)) };
}

/**
 * Why an Item cannot be placed on a board, or null where it can: one in the
 * Inbox has to be filed on a Panel or put inside an Item first, so a board
 * never changes the Inbox. The server's own words (`NotPlaceableError`).
 */
export function whyNotPlaceable(snapshot: WorkspaceSnapshot, itemId: string): string | null {
  const item = snapshot.items.find((one) => one.id === itemId);
  if (!item) return null;
  const filedOn = new Set(snapshot.panels.filter((panel) => panel.kind === 'items').map((panel) => panel.id));
  const hasAParent =
    snapshot.filings.some((filing) => filing.itemId === itemId && filedOn.has(filing.panelId)) ||
    (snapshot.children ?? []).some((row) => row.childId === itemId);
  if (hasAParent) return null;
  return `${itemLabel(item)} is in the Inbox. File it on a Panel or put it inside an Item first.`;
}
