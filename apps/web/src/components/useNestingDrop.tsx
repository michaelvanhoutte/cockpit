import { Suspense, lazy, useEffect, useState, type RefObject } from 'react';
import type { Item } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { itemInTheAir, landItem, panelLiftedFrom, parentLiftedFrom, selectionCarried } from '../itemInTheAir';
import { refusesNesting, whereOnARow } from '../nestingAim';
import type { LetGo } from '../rowDrop';
import { pickedNow } from '../selection';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';

/** What a drop comes to once let go, fetched with the first drag that reaches a row's middle half. */
const RowDropOutcome = lazy(() => import('./RowDropOutcome'));
let preparing: Promise<unknown> | null = null;
const prepare = () =>
  (preparing ??= Promise.all([import('./RowDropOutcome'), import('../childrenDrawnAhead')]).catch(() => {}));

/**
 * A row, or a selection, let go on another row's middle half to go inside it
 * ("Drag to nest in Panels and the Inbox", issue 1857): outlined while the
 * pointer is there, one change when let go (`RowDropOutcome`), and Undo for
 * both halves.
 *
 * **The top and bottom quarters of a row are not this** - they keep the gap a
 * list already draws - and neither is a gathered list's, which takes no drop
 * (a Filter's), though a parent's child rows, gathered under it, take one onto
 * a row.
 */
export function useNestingDrop({
  workspaceId,
  panelId,
  heldBy,
  gathered,
  inColumns,
  list,
}: {
  workspaceId: string;
  panelId: string | null;
  heldBy: Item | undefined;
  gathered: boolean;
  inColumns: boolean;
  list: RefObject<HTMLElement | null>;
}) {
  const { data } = useSnapshot(workspaceId);
  /** The row a drop would go inside, outlined while the pointer is on it. */
  const [into, setInto] = useState<string | null>(null);
  /** The last drop let go here, with a count so each is settled afresh. */
  const [letGo, setLetGo] = useState<{ n: number; drop: LetGo } | null>(null);

  // Cleared where the drag ends without a drop, which the list is not told of.
  useEffect(() => {
    if (into === null) return;
    const clear = () => setInto(null);
    document.addEventListener('dragend', clear);
    return () => document.removeEventListener('dragend', clear);
  }, [into]);

  const available = !gathered || heldBy !== undefined;

  /** The row of this list under the pointer, never one of a list unfolded inside it, and where on it. */
  const rowUnder = (event: React.DragEvent) => {
    const row = (event.target as Element | null)?.closest?.<HTMLElement>('[data-item-row]');
    const rows = list.current;
    if (!row || !rows || !rows.contains(row) || !row.dataset.itemId) return null;
    const nested = row.closest('[data-child-rows]');
    if (nested && rows.contains(nested)) return null;
    return { id: row.dataset.itemId, at: whereOnARow(row.getBoundingClientRect(), event.clientX, event.clientY, inColumns) };
  };

  /** Said on `dragover`: true when the pointer is on a row's middle half, which this list then answers alone. */
  const over = (event: React.DragEvent): boolean => {
    if (!available) return false;
    const under = rowUnder(event);
    if (!under || under.at !== 'inside') {
      if (into !== null) setInto(null);
      return false;
    }
    void prepare();
    const selection = selectionCarried();
    const one = itemInTheAir();
    // Onto itself or anything inside it, the pointer says no: no `preventDefault`, and the list underneath told nothing.
    if (refusesNesting(selection ? selection.ids : one ? [one] : [], under.id, data?.children ?? [])) {
      event.stopPropagation();
      if (into !== null) setInto(null);
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (into !== under.id) setInto(under.id);
    return true;
  };

  const leave = () => setInto(null);

  /** Said on `drop`: true when it was a drop onto a row's middle half, which is then settled whole. */
  const drop = (event: React.DragEvent): boolean => {
    if (!available) return false;
    const under = rowUnder(event);
    if (!under || under.at !== 'inside') return false;
    const itemId = event.dataTransfer.getData(ITEM_BEING_DRAGGED);
    if (!itemId) return false;
    setInto(null);
    // Read before the drop ends the drag: what is still picked when let go, not what was picked up.
    const selection = selectionCarried();
    const carrying = selection?.ids.includes(itemId) ? selection : null;
    const picked = carrying ? pickedNow(carrying.scope) : null;
    const drop: LetGo = {
      carried: carrying ? carrying.ids.filter((id) => picked!.has(id)) : [itemId],
      scope: carrying?.scope ?? null,
      target: under.id,
      from: { parentId: parentLiftedFrom(itemId), panelId: panelLiftedFrom(itemId) },
      keys: { move: event.shiftKey, add: event.ctrlKey || event.altKey },
      list: { panelId, heldBy: heldBy?.id ?? null },
    };
    landItem();
    setLetGo((was) => ({ n: (was?.n ?? 0) + 1, drop }));
    return true;
  };

  // A chunk that cannot load is said by the boundary, as for any question fetched on demand.
  const outcome = letGo ? (
    <WhateverTheQuestionDoes onFailure={() => setLetGo(null)}>
      <Suspense fallback={null}>
        <RowDropOutcome key={letGo.n} workspaceId={workspaceId} letGo={letGo.drop} />
      </Suspense>
    </WhateverTheQuestionDoes>
  ) : null;

  return { into, over, drop, leave, outcome };
}
