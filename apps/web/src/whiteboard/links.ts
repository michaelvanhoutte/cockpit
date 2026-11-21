import { FIXED_LINE_KINDS, fixedLineKindId, type ItemLink, type LineKind, type LineStyle } from '@cockpit/shared/board';
import type { Board } from './layout';

/**
 * Which links a whiteboard draws and where each meets a card ("Brainstorming:
 * the whiteboard can't show how Items connect", issue 1831), decided here and
 * pure, for the reason `layout.ts` is: jsdom has no layout engine, so what a
 * test can prove is the arithmetic once the frames are given.
 */

export type Side = 'top' | 'right' | 'bottom' | 'left';
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Attachment {
  side: Side;
  x: number;
  y: number;
}

/**
 * Where a link leaves one frame and meets the other: the middle of each one's
 * side facing the other, its nearest. Across when the two are further apart
 * across than down, for their sizes, and down otherwise.
 */
export function nearestSides(from: Rect, to: Rect): { from: Attachment; to: Attachment } {
  const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const b = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const across = Math.abs(b.x - a.x) / Math.max(1, (from.w + to.w) / 2);
  const down = Math.abs(b.y - a.y) / Math.max(1, (from.h + to.h) / 2);
  const at = (rect: Rect, side: Side): Attachment => {
    const x = side === 'left' ? rect.x : side === 'right' ? rect.x + rect.w : rect.x + rect.w / 2;
    const y = side === 'top' ? rect.y : side === 'bottom' ? rect.y + rect.h : rect.y + rect.h / 2;
    return { side, x, y };
  };
  if (across >= down) {
    return b.x >= a.x ? { from: at(from, 'right'), to: at(to, 'left') } : { from: at(from, 'left'), to: at(to, 'right') };
  }
  return b.y >= a.y ? { from: at(from, 'bottom'), to: at(to, 'top') } : { from: at(from, 'top'), to: at(to, 'bottom') };
}

/** One end of a link on a board: the card it is drawn from, and, for an Item drawn inside its parent's unfolded card, that Item. */
export interface End {
  cardId: string;
  inside: string | null;
}

/** A link this board draws: the card at each end, and the kind it is drawn as. */
export interface DrawnLink {
  link: ItemLink;
  kind: LineKind;
  from: End;
  to: End;
}

/**
 * The links a board draws: those with each end on it, as a card of its own or
 * inside a parent's card unfolded there. One with an end elsewhere is not
 * drawn, and nor is one from a parent's card to an Item inside it. A link of a
 * kind the board does not know is drawn as *Related*.
 */
export function linksOnTheBoard(
  links: readonly ItemLink[],
  kinds: readonly LineKind[],
  board: Pick<Board, 'cards'>,
  unfoldedChildren: (parentItemId: string) => readonly string[],
): DrawnLink[] {
  const cardOf = new Map(board.cards.map((card) => [card.itemId, card.id]));
  const inside = new Map<string, string>();
  for (const card of board.cards) {
    for (const child of unfoldedChildren(card.itemId)) if (!cardOf.has(child) && !inside.has(child)) inside.set(child, card.id);
  }
  const endOf = (itemId: string): End | null => {
    const own = cardOf.get(itemId);
    if (own) return { cardId: own, inside: null };
    const parent = inside.get(itemId);
    return parent ? { cardId: parent, inside: itemId } : null;
  };
  const related = kinds.find((kind) => kind.role === 'related');
  return links.flatMap((link) => {
    const from = endOf(link.fromItemId);
    const to = endOf(link.toItemId);
    if (!from || !to) return [];
    // Both inside one card is two Items drawn apart; a card and what it holds is not.
    if (from.cardId === to.cardId && (from.inside === null || to.inside === null)) return [];
    const kind = kinds.find((one) => one.id === link.kindId) ?? related;
    return kind ? [{ link, kind, from, to }] : [];
  });
}

/** How each style is dashed; *double* is two strokes, drawn apart. */
export const DASHES: Record<LineStyle, string | undefined> = { solid: undefined, dashed: '9 6', dotted: '1.5 5', double: undefined };

/** A swatch as the board paints a line: its ink. */
export const lineInk = (kind: Pick<LineKind, 'colour'>) => `var(--color-cat-${kind.colour})`;

/** The kinds a board offers, before the Workspace's read has any: *Leads to* and *Related*. */
export function kindsOrFixed(workspaceId: string, kinds: readonly LineKind[] | undefined): LineKind[] {
  if (kinds && kinds.length > 0) return [...kinds];
  return (['leads_to', 'related'] as const).map((role) => ({ id: fixedLineKindId(workspaceId, role), ...FIXED_LINE_KINDS[role] }));
}

/** An Item's links as Relations lists them: by kind, *Leads to* and *Comes from* for one with an arrowhead, one list for one without. */
export interface LinkGroup {
  /** The kind and the direction, which no two groups share. */
  key: string;
  heading: string;
  itemIds: string[];
}

export function linksByKind(itemId: string, links: readonly ItemLink[], kinds: readonly LineKind[]): LinkGroup[] {
  const related = kinds.find((kind) => kind.role === 'related');
  const kindOf = (link: ItemLink) => kinds.find((kind) => kind.id === link.kindId) ?? related;
  return kinds.flatMap((kind) => {
    const mine = links.filter((link) => kindOf(link)?.id === kind.id);
    const out = mine.filter((link) => link.fromItemId === itemId).map((link) => link.toItemId);
    const into = mine.filter((link) => link.toItemId === itemId).map((link) => link.fromItemId);
    if (!kind.arrow) {
      const both = [...new Set([...out, ...into])];
      return both.length > 0 ? [{ key: kind.id, heading: kind.name, itemIds: both }] : [];
    }
    const groups: LinkGroup[] = [];
    if (out.length > 0) groups.push({ key: `${kind.id}:out`, heading: kind.name, itemIds: out });
    if (into.length > 0) groups.push({ key: `${kind.id}:in`, heading: kind.role === 'leads_to' ? 'Comes from' : `${kind.name} (from)`, itemIds: into });
    return groups;
  });
}
