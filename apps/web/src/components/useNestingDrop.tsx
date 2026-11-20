import { Suspense, lazy, useEffect, useState, type RefObject } from 'react';
import type { Item } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import type { LetGo } from '../rowDrop';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';

/** What a drop comes to once let go, fetched with the first drag that reaches a row's middle half. */
const RowDropOutcome = lazy(() => import('./RowDropOutcome'));

let drag: typeof import('../nestingDrag') | null = null;
let loading: Promise<unknown> | null = null;
/** The drag itself, fetched as the first list mounts: until it arrives a row's middle half is the gap it always was. */
export const loadNestingDrag = () =>
  (loading ??= import('../nestingDrag').then(
    (loaded) => {
      drag = loaded;
    },
    () => {
      loading = null;
    },
  ));

/**
 * A row, or a selection, let go on another row's middle half to go inside it
 * ("Drag to nest in Panels and the Inbox", issue 1857): outlined while the
 * pointer is there (`nestingDrag.ts`), one change when let go
 * (`RowDropOutcome`), and Undo for both halves. Kept this thin because the
 * initial bundle carries it.
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

  useEffect(() => {
    void loadNestingDrag();
  }, []);

  // Cleared where the drag ends without a drop, which the list is not told of.
  useEffect(() => {
    if (into === null) return;
    const clear = () => setInto(null);
    document.addEventListener('dragend', clear);
    return () => document.removeEventListener('dragend', clear);
  }, [into]);

  const at = () => ({ list: list.current, inColumns, children: data?.children ?? [] });
  // Read as each event comes, since the drag's code may arrive after the last render.
  const available = () => drag !== null && (!gathered || heldBy !== undefined);

  /** Said on `dragover`: true when the pointer is on a row's middle half, which this list then answers alone. */
  const over = (event: React.DragEvent): boolean => {
    const target = available() ? drag!.overARow(event, at()) : undefined;
    if (target !== into) setInto(target ?? null);
    return target !== undefined;
  };

  /** Said on `drop`: true when it was a drop onto a row's middle half, which is then settled whole. */
  const drop = (event: React.DragEvent): boolean => {
    const dropped = available() ? drag!.dropOnARow(event, { ...at(), panelId, heldBy: heldBy?.id ?? null }) : null;
    if (!dropped) return false;
    setInto(null);
    setLetGo((was) => ({ n: (was?.n ?? 0) + 1, drop: dropped }));
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

  return { into, over, drop, leave: () => setInto(null), outcome };
}
