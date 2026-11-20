import { itemLabel, stillOpen, uuidv7, workspaceIsDecided, childIdsOf, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from './api/queries';
import { refusalFrom } from './api/queries';
import { fetchedChunk, filedOrderOnPanel } from './filing';
import { planDropOntoARow, leavesAnswered, type RowDropPlan } from './nesting';
import type { RowDropWas } from './puttingBack';
import { dashboardOfScope } from './selection';
import type { Undoable } from './undo';
import { unfoldAll } from './unfoldedParents';

/**
 * A drop onto a row's middle half, once let go ("Drag to nest in Panels and the
 * Inbox", issue 1857): the plan it comes to, and the one change it sends with
 * its Undo. Fetched on the first `dragover` that reaches a row's middle half,
 * so the initial bundle carries only where the pointer is (`nestingAim.ts`).
 */

type Planned = Exclude<RowDropPlan, { refused: string }>;

export interface Asking {
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

/** What the drop read while it was still a drop: the browser forgets all of it once the event returns. */
export interface LetGo {
  /** The Items carried and still picked when let go, in the order drawn: the grabbed one alone, or a selection's. */
  carried: readonly string[];
  /** The selection's scope, where a selection was carried. */
  scope: string | null;
  target: string;
  from: { parentId: string | null; panelId: string | null };
  keys: { move: boolean; add: boolean };
  list: { panelId: string | null; heldBy: string | null };
}

export interface RowDropDeps {
  workspaceId: string;
  data: WorkspaceSnapshot | undefined;
  send: (change: CommandArgs) => Promise<unknown>;
  latest: (workspaceId: string) => Promise<WorkspaceSnapshot>;
  offerToUndo: (change: Undoable) => void;
  setRefusal: (refusal: string) => void;
}

const labelIn = (data: WorkspaceSnapshot | undefined, id: string) => {
  const item = data?.items.find((one) => one.id === id);
  return item ? itemLabel(item) : 'that Item';
};

/** What a drop let go on a row comes to: a question to ask, a refusal to say, or nothing to do. */
export function settleRowDrop(d: RowDropDeps, letGo: LetGo): Asking | { refused: string } | null {
  const { data } = d;
  const items = data?.items ?? [];
  // Still open when it is let go, not only when it was picked up.
  const open = new Set(items.filter(stillOpen).map((item) => item.id));
  const carried = letGo.carried.filter((id) => open.has(id));
  if (carried.length === 0) return null;
  const dashboard = letGo.scope !== null ? dashboardOfScope(letGo.scope) : null;
  const rows = data?.children ?? [];
  const filings = data?.filings ?? [];
  const plan = planDropOntoARow({
    carried,
    target: letGo.target,
    rows,
    filings,
    from: letGo.from,
    selectionPanels: letGo.scope !== null
      ? (data?.panels ?? []).filter((panel) => panel.dashboardId === dashboard).map((panel) => panel.id)
      : null,
    list: letGo.list,
    keys: letGo.keys,
  });
  if (!plan) return null;
  if (plan.refused !== undefined) return { refused: plan.refused };
  const byId = new Map(items.map((item) => [item.id, item]));
  const moved = plan.childIds.map((id) => byId.get(id)).filter((item): item is Item => item !== undefined);
  const placesLeft = <K extends 'parentId' | 'panelId'>(key: K) => [
    ...new Set(plan.leaves.flatMap((one) => (one[key] ? [one[key]!] : []))),
  ];
  const itemsLeaving = (key: 'parentId' | 'panelId', place: string) =>
    plan.leaves.filter((one) => one[key] === place).map((one) => one.itemId);
  const nameOfPanel = (id: string) => data?.panels.find((panel) => panel.id === id)?.name ?? 'that Panel';
  return {
    plan,
    target: letGo.target,
    was: {
      target: letGo.target,
      arrived: plan.arrived,
      parents: placesLeft('parentId').map((parentId) => ({
        parentId,
        itemIds: itemsLeaving('parentId', parentId),
        was: childIdsOf(rows, parentId),
      })),
      panels: placesLeft('panelId').map((panelId) => ({
        panelId,
        itemIds: itemsLeaving('panelId', panelId),
        was: filedOrderOnPanel(filings, panelId),
      })),
    },
    title: moved.length === 1 ? itemLabel(moved[0]!) : '',
    several: moved.length > 1 ? moved.length : undefined,
    leaves: [
      ...new Set([...placesLeft('parentId').map((id) => labelIn(data, id)), ...placesLeft('panelId').map(nameOfPanel)]),
    ].join(', '),
    label: labelIn(data, letGo.target),
    decides: moved.some((item) => !workspaceIsDecided(item)),
  };
}

/** The change a drop is, sent, with its Undo; a refusal is said above the rows. */
export function performRowDrop(d: RowDropDeps, asked: Asking, answer: 'move' | 'add'): void {
  const { plan, target, was } = asked;
  const leaves = leavesAnswered(plan, answer);
  const sent = d.send({
    name: 'put_inside',
    payload: {
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: d.workspaceId,
      parentId: target,
      childIds: plan.childIds,
      order: plan.order,
      leaves,
    },
  });
  sent.catch((error: unknown) => d.setRefusal(refusalFrom({ error }) ?? 'That could not be done.'));
  unfoldAll([target]);
  const left: RowDropWas = {
    ...was,
    parents: was.parents.filter((one) => leaves.some((leave) => leave.parentId === one.parentId)),
    panels: was.panels.filter((one) => leaves.some((leave) => leave.panelId === one.panelId)),
  };
  if (!asked.decides) void import('./puttingBack').catch(() => {});
  d.offerToUndo({
    what: `${asked.several ? `${asked.several} items` : `“${asked.title}”`} put inside ${labelIn(d.data, target)}`,
    unlessRefused: sent,
    // Going inside settles an Item that belonged to no Workspace, which taking it out does not undo.
    ...(asked.decides
      ? {}
      : {
          undo: async () =>
            (await fetchedChunk(() => import('./puttingBack'))).putBackFromARowDrop(
              { workspaceId: d.workspaceId, send: d.send, latest: d.latest },
              left,
            ),
        }),
  });
}
