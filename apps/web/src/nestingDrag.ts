import type { ChildRow } from '@cockpit/shared';
import { ITEM_BEING_DRAGGED } from './dropAt';
import { itemInTheAir, landItem, panelLiftedFrom, parentLiftedFrom, selectionCarried } from './itemInTheAir';
import { refusesNesting, whereOnARow } from './nestingAim';
import type { LetGo } from './rowDrop';
import { pickedNow } from './selection';

/**
 * The drag over and the drop onto a row's middle half ("Drag to nest in Panels
 * and the Inbox", issue 1857), fetched as a list mounts rather than carried in
 * the initial bundle (`useNestingDrop`). What the drop then comes to is
 * fetched with the first drag that reaches a row's middle half.
 */

export interface Over {
  list: HTMLElement | null;
  inColumns: boolean;
  children: readonly ChildRow[];
}

let preparing: Promise<unknown> | null = null;
const prepare = () =>
  (preparing ??= Promise.all([import('./components/RowDropOutcome'), import('./childrenDrawnAhead')]).catch(() => {}));

/** The row of this list under the pointer, never one of a list unfolded inside it, and whether it is on its middle half. */
function rowUnder(event: React.DragEvent, at: Over): string | null {
  const row = (event.target as Element | null)?.closest?.<HTMLElement>('[data-item-row]');
  const rows = at.list;
  if (!row || !rows || !rows.contains(row) || !row.dataset.itemId) return null;
  const nested = row.closest('[data-child-rows]');
  if (nested && rows.contains(nested)) return null;
  return whereOnARow(row.getBoundingClientRect(), event.clientX, event.clientY, at.inColumns) === 'inside' ? row.dataset.itemId : null;
}

/**
 * Said on `dragover`: undefined where the pointer is not on a row's middle
 * half, which the list then answers as it always has; otherwise this list
 * answers alone, with the row it would go inside, or null where it may not.
 */
export function overARow(event: React.DragEvent, at: Over): string | null | undefined {
  const target = rowUnder(event, at);
  if (!target) return undefined;
  void prepare();
  event.stopPropagation();
  const selection = selectionCarried();
  const one = itemInTheAir();
  // Onto itself or anything inside it, the pointer says no: no `preventDefault`.
  if (refusesNesting(selection ? selection.ids : one ? [one] : [], target, at.children)) return null;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  return target;
}

/** Said on `drop`: what it read while it was a drop onto a row's middle half, or null where it was not one. */
export function dropOnARow(
  event: React.DragEvent,
  at: Over & { panelId: string | null; heldBy: string | null },
): LetGo | null {
  const target = rowUnder(event, at);
  const itemId = event.dataTransfer.getData(ITEM_BEING_DRAGGED);
  if (!target || !itemId) return null;
  // Read before the drop ends the drag: what is still picked when let go, not what was picked up.
  const selection = selectionCarried();
  const carrying = selection?.ids.includes(itemId) ? selection : null;
  const picked = carrying ? pickedNow(carrying.scope) : null;
  const letGo: LetGo = {
    carried: carrying ? carrying.ids.filter((id) => picked!.has(id)) : [itemId],
    scope: carrying?.scope ?? null,
    target,
    from: { parentId: parentLiftedFrom(itemId), panelId: panelLiftedFrom(itemId) },
    keys: { move: event.shiftKey, add: event.ctrlKey || event.altKey },
    list: { panelId: at.panelId, heldBy: at.heldBy },
  };
  landItem();
  return letGo;
}
