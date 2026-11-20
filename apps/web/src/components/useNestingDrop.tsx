import { Suspense, lazy, useEffect, useState, type RefObject } from 'react';
import { itemLabel, stillOpen, uuidv7, workspaceIsDecided, childIdsOf, type Item } from '@cockpit/shared';
import { refusalFrom, useSendCommand, useLatestSnapshot } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { fetchedChunk, filedOrderOnPanel } from '../filing';
import { itemInTheAir, landItem, panelLiftedFrom, parentLiftedFrom, selectionCarried } from '../itemInTheAir';
import { planDropOntoARow, refusesNesting, whereOnARow, leavesAnswered, type RowDropPlan } from '../nesting';
import type { RowDropWas } from '../puttingBack';
import { dashboardOfScope, pickedNow } from '../selection';
import { useUndo } from '../undo';
import { unfoldAll } from '../unfoldedParents';
import { WhateverTheQuestionDoes } from './WhateverTheQuestionDoes';

/** Asked once a drop asks it, as the question between Panels is. */
const MoveOrAddQuestion = lazy(() => import('./MoveOrAddQuestion'));

/** The code that draws a put-inside ahead, fetched before the first drop that needs it, not carried in the initial bundle. */
let preparing: Promise<unknown> | null = null;
const prepare = () => (preparing ??= import('../childrenDrawnAhead').catch(() => {}));

type Planned = Exclude<RowDropPlan, { refused: string }>;

interface Asking {
  plan: Planned;
  target: string;
  was: RowDropWas;
  /** The title of the one dropped, or how many were. */
  title: string;
  several: number | undefined;
  /** What moving it takes it off, in words. */
  leaves: string;
  label: string;
  decides: boolean;
}

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

  const label = (id: string) => {
    const item = data?.items.find((one) => one.id === id);
    return item ? itemLabel(item) : 'that Item';
  };
  const nameOfPanel = (id: string) => data?.panels.find((panel) => panel.id === id)?.name ?? 'that Panel';

  /** The change a drop is, sent, with its Undo; a refusal is said above the rows. */
  const perform = (asked: Asking, answer: 'move' | 'add') => {
    const { plan, target, was } = asked;
    const leaves = leavesAnswered(plan, answer);
    const sent = send({
      name: 'put_inside',
      payload: {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        parentId: target,
        childIds: plan.childIds,
        order: plan.order,
        leaves,
      },
    });
    sent.catch((error: unknown) => setRefusal(refusalFrom({ error }) ?? 'That could not be done.'));
    unfoldAll([target]);
    const left = (wasOf: RowDropWas): RowDropWas => ({
      ...wasOf,
      parents: wasOf.parents.filter((one) => leaves.some((leave) => leave.parentId === one.parentId)),
      panels: wasOf.panels.filter((one) => leaves.some((leave) => leave.panelId === one.panelId)),
    });
    if (!asked.decides) void import('../puttingBack').catch(() => {});
    offerToUndo({
      what: `${asked.several ? `${asked.several} items` : `“${asked.title}”`} put inside ${label(target)}`,
      unlessRefused: sent,
      // Going inside settles an Item that belonged to no Workspace, which taking it out does not undo.
      ...(asked.decides
        ? {}
        : {
            undo: async () =>
              (await fetchedChunk(() => import('../puttingBack'))).putBackFromARowDrop(
                { workspaceId, send, latest },
                left(was),
              ),
          }),
    });
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
    // Read before the drop ends the drag.
    const from = { parentId: parentLiftedFrom(itemId), panelId: panelLiftedFrom(itemId) };
    const selection = selectionCarried();
    const carrying = selection?.ids.includes(itemId) ? selection : null;
    landItem();
    const items = data?.items ?? [];
    // What is still picked and still open when it is let go, not what was picked up.
    const stillPicked = carrying ? pickedNow(carrying.scope) : null;
    const open = new Set(items.filter(stillOpen).map((item) => item.id));
    const carried = (carrying ? carrying.ids.filter((id) => stillPicked!.has(id)) : [itemId]).filter((id) => open.has(id));
    if (carried.length === 0) return true;
    const dashboard = carrying ? dashboardOfScope(carrying.scope) : null;
    const rows = data?.children ?? [];
    const filings = data?.filings ?? [];
    const plan = planDropOntoARow({
      carried,
      target: under.id,
      rows,
      filings,
      from,
      selectionPanels: carrying ? (data?.panels ?? []).filter((panel) => panel.dashboardId === dashboard).map((panel) => panel.id) : null,
      list: { panelId, heldBy: heldBy?.id ?? null },
      keys: { move: event.shiftKey, add: event.ctrlKey || event.altKey },
    });
    if (!plan) return true;
    if (plan.refused !== undefined) {
      setRefusal(plan.refused);
      return true;
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    const moved = plan.childIds.map((id) => byId.get(id)).filter((item): item is Item => item !== undefined);
    const was: RowDropWas = {
      target: under.id,
      arrived: plan.arrived,
      parents: [...new Set(plan.leaves.flatMap((one) => (one.parentId ? [one.parentId] : [])))].map((parentId) => ({
        parentId,
        itemIds: plan.leaves.filter((one) => one.parentId === parentId).map((one) => one.itemId),
        was: childIdsOf(rows, parentId),
      })),
      panels: [...new Set(plan.leaves.flatMap((one) => (one.panelId ? [one.panelId] : [])))].map((onPanel) => ({
        panelId: onPanel,
        itemIds: plan.leaves.filter((one) => one.panelId === onPanel).map((one) => one.itemId),
        was: filedOrderOnPanel(filings, onPanel),
      })),
    };
    const asked: Asking = {
      plan,
      target: under.id,
      was,
      title: moved.length === 1 ? itemLabel(moved[0]!) : '',
      several: moved.length > 1 ? moved.length : undefined,
      leaves: [
        ...new Set([
          ...plan.leaves.flatMap((one) => (one.parentId ? [label(one.parentId)] : [])),
          ...plan.leaves.flatMap((one) => (one.panelId ? [nameOfPanel(one.panelId)] : [])),
        ]),
      ].join(', '),
      label: label(under.id),
      decides: moved.some((item) => !workspaceIsDecided(item)),
    };
    if (plan.answer === 'ask') setAsking(asked);
    else perform(asked, plan.answer);
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
