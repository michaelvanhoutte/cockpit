import { Suspense, lazy, useEffect, useState, type RefObject } from 'react';
import type { Item } from '@cockpit/shared';
import { useSendCommand, useLatestSnapshot } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { fetchedChunk } from '../filing';
import { itemInTheAir, landItem, panelLiftedFrom, parentLiftedFrom, selectionCarried } from '../itemInTheAir';
import { refusesNesting, whereOnARow } from '../nestingAim';
import type { Asking, RowDropDeps } from '../rowDrop';
import { useUndo } from '../undo';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';

/** Asked once a drop asks it, as the question between Panels is. */
const MoveOrAddQuestion = lazy(() => import('./MoveOrAddQuestion'));

/**
 * What a drop onto a row comes to and the change it sends (`rowDrop.ts`), and
 * the code that draws that change ahead, fetched on the first `dragover` that
 * reaches a row's middle half rather than carried in the initial bundle.
 */
let preparing: Promise<unknown> | null = null;
const prepare = () => (preparing ??= Promise.all([import('../rowDrop'), import('../childrenDrawnAhead')]).catch(() => {}));

/**
 * A row, or a selection, let go on another row's middle half to go inside it
 * ("Drag to nest in Panels and the Inbox", issue 1857): outlined while the
 * pointer is there, one change when let go, and Undo for both halves.
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
  const send = useSendCommand();
  const latest = useLatestSnapshot();
  const offerToUndo = useUndo();
  /** The row a drop would go inside, outlined while the pointer is on it. */
  const [into, setInto] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // Cleared where the drag ends without a drop, which the list is not told of.
  useEffect(() => {
    if (into === null) return;
    const clear = () => setInto(null);
    document.addEventListener('dragend', clear);
    return () => document.removeEventListener('dragend', clear);
  }, [into]);

  const available = !gathered || heldBy !== undefined;
  const deps: RowDropDeps = { workspaceId, data, send, latest, offerToUndo, setRefusal };
  const failed = (error: unknown) => setRefusal(error instanceof Error ? error.message : 'That could not be done.');

  /** The row of this list under the pointer, never one of a list unfolded inside it, and where on it. */
  const rowUnder = (event: React.DragEvent) => {
    const row = (event.target as Element | null)?.closest?.<HTMLElement>('[data-item-row]');
    const rows = list.current;
    if (!row || !rows || !rows.contains(row) || !row.dataset.itemId) return null;
    const nested = row.closest('[data-child-rows]');
    if (nested && rows.contains(nested)) return null;
    return { id: row.dataset.itemId, at: whereOnARow(row.getBoundingClientRect(), event.clientX, event.clientY, inColumns) };
  };

  /** The Items in the air: a selection's, or the one row's. */
  const inTheAir = (): string[] => {
    const selection = selectionCarried();
    if (selection) return [...selection.ids];
    const one = itemInTheAir();
    return one ? [one] : [];
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
    // Onto itself or anything inside it, the pointer says no: no `preventDefault`, and the list underneath told nothing.
    if (refusesNesting(inTheAir(), under.id, data?.children ?? [])) {
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

  const perform = (asked: Asking, answer: 'move' | 'add') => {
    void fetchedChunk(() => import('../rowDrop'))
      .then(({ performRowDrop }) => performRowDrop(deps, asked, answer))
      .catch(failed);
  };

  /** Said on `drop`: true when it was a drop onto a row's middle half, which is then handled whole. */
  const drop = (event: React.DragEvent): boolean => {
    if (!available) return false;
    const under = rowUnder(event);
    if (!under || under.at !== 'inside') return false;
    const itemId = event.dataTransfer.getData(ITEM_BEING_DRAGGED);
    if (!itemId) return false;
    setInto(null);
    setRefusal(null);
    // Read before the drop ends the drag, and before the plan's code is fetched.
    const selection = selectionCarried();
    const letGo = {
      itemId,
      target: under.id,
      from: { parentId: parentLiftedFrom(itemId), panelId: panelLiftedFrom(itemId) },
      carrying: selection?.ids.includes(itemId) ? selection : null,
      keys: { move: event.shiftKey, add: event.ctrlKey || event.altKey },
      list: { panelId, heldBy: heldBy?.id ?? null },
    };
    landItem();
    void fetchedChunk(() => import('../rowDrop'))
      .then(({ settleRowDrop, performRowDrop }) => {
        const settled = settleRowDrop(deps, letGo);
        if (!settled) return;
        if ('refused' in settled) setRefusal(settled.refused);
        else if (settled.plan.answer === 'ask') setAsking(settled);
        else performRowDrop(deps, settled, settled.plan.answer);
      })
      .catch(failed);
    return true;
  };

  const question = asking ? (
    <WhateverTheQuestionDoes onFailure={() => setAsking(null)}>
      <Suspense fallback={null}>
        <MoveOrAddQuestion
          open
          itemTitle={asking.title}
          panelName={asking.label}
          leaves={asking.leaves}
          {...(asking.several ? { several: asking.several } : {})}
          onMove={() => {
            setAsking(null);
            perform(asking, 'move');
          }}
          onAdd={() => {
            setAsking(null);
            perform(asking, 'add');
          }}
          onCancel={() => setAsking(null)}
        />
      </Suspense>
    </WhateverTheQuestionDoes>
  ) : null;

  const notice = refusal ? (
    <p role="alert" className="px-4 py-2 text-sm text-over-ink">
      {refusal}
    </p>
  ) : null;

  return { into, over, drop, leave, question, notice };
}
