import { parentIdsOf, stillOpen, type CommandPayload, type WorkspaceSnapshot } from '@cockpit/shared';
import { drawChildrenWith, withItem } from './drawnAhead';

/*
 * The changes to Items held by Items drawn ahead (`ChildrenDrawn` in
 * drawnAhead.ts), fetched by a Workspace holding any such Item rather than
 * carried in the initial bundle, and handed over the moment this is evaluated.
 */

/**
 * Items put inside one ("Brainstorming: an Item can't hold other Items", issue
 * 1825): rows at the end of the parent's order, and its counts grown by those
 * not already inside it, as the server counts them. A parent the copy does not
 * hold is drawn with nothing.
 */
function putInsideAhead(snapshot: WorkspaceSnapshot, put: CommandPayload<'add_children'>): WorkspaceSnapshot {
  if (put.workspaceId !== snapshot.workspace.id) return snapshot;
  const held = snapshot.children ?? [];
  const already = new Set(held.filter((row) => row.parentId === put.parentId).map((row) => row.childId));
  const arriving = put.childIds.filter((id) => !already.has(id));
  if (arriving.length === 0) return snapshot;
  const last = Math.max(-1, ...held.filter((row) => row.parentId === put.parentId).map((row) => row.position));
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const done = arriving.filter((id) => byId.get(id) && !stillOpen(byId.get(id)!)).length;
  const counted = withCounts(snapshot, put.parentId, arriving.length, done);
  return {
    ...counted,
    children: [...held, ...arriving.map((childId, at) => ({ parentId: put.parentId, childId, position: last + 1 + at }))],
  };
}

/**
 * Items dropped onto a row ("Drag to nest in Panels and the Inbox", issue 1857):
 * the parent's rows in the order carried (a child the order leaves out keeps its
 * place), its counts grown by those not inside it already, and each Item gone
 * from the parent or Panel it left, whose counts shrink with it - all at once,
 * as the server applies it.
 */
function putInsideInOrderAhead(snapshot: WorkspaceSnapshot, put: CommandPayload<'put_inside'>): WorkspaceSnapshot {
  if (put.workspaceId !== snapshot.workspace.id) return snapshot;
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const finished = (id: string) => (byId.get(id) ? !stillOpen(byId.get(id)!) : false);
  let rows = snapshot.children ?? [];
  let drawn = snapshot;
  // Out of what they left first, so a parent counted twice is counted right.
  for (const leave of put.leaves) {
    if (leave.parentId === undefined) continue;
    if (!rows.some((row) => row.parentId === leave.parentId && row.childId === leave.itemId)) continue;
    drawn = withCounts(drawn, leave.parentId, -1, finished(leave.itemId) ? -1 : 0);
    rows = rows.filter((row) => !(row.parentId === leave.parentId && row.childId === leave.itemId));
  }
  const already = new Set(rows.filter((row) => row.parentId === put.parentId).map((row) => row.childId));
  const arriving = put.childIds.filter((id) => !already.has(id));
  drawn = withCounts(drawn, put.parentId, arriving.length, arriving.filter(finished).length);
  const inOrder = new Set(put.order);
  const placed = put.order.map((childId, position) => ({ parentId: put.parentId, childId, position }));
  const filings = snapshot.filings.filter(
    (filing) => !put.leaves.some((leave) => leave.panelId === filing.panelId && leave.itemId === filing.itemId),
  );
  return {
    ...drawn,
    filings,
    children: [...rows.filter((row) => row.parentId !== put.parentId || !inOrder.has(row.childId)), ...placed],
  };
}

/** One Item taken out of one parent: its row gone, and the parent's counts shrunk by it. */
function takenOutAhead(snapshot: WorkspaceSnapshot, out: CommandPayload<'remove_child'>): WorkspaceSnapshot {
  if (out.workspaceId !== snapshot.workspace.id) return snapshot;
  const held = snapshot.children ?? [];
  if (!held.some((row) => row.parentId === out.parentId && row.childId === out.childId)) return snapshot;
  const child = snapshot.items.find((item) => item.id === out.childId);
  const counted = withCounts(snapshot, out.parentId, -1, child && !stillOpen(child) ? -1 : 0);
  return { ...counted, children: held.filter((row) => !(row.parentId === out.parentId && row.childId === out.childId)) };
}

/**
 * An Item finished or reopened, and the done count of every Item holding it
 * moved with it, as the server counts it (issue 1825), so "2 of 3 done"
 * changes at the click rather than at the read after.
 */
function doneAhead(snapshot: WorkspaceSnapshot, finished: WorkspaceSnapshot, done: CommandPayload<'set_done'>): WorkspaceSnapshot {
  const was = snapshot.items.find((item) => item.id === done.itemId);
  if (!was || stillOpen(was) !== done.done) return finished;
  return parentIdsOf(snapshot.children ?? [], done.itemId).reduce(
    (drawn, parentId) => withCounts(drawn, parentId, 0, done.done ? 1 : -1),
    finished,
  );
}

/**
 * An Item dismissed: gone from the copy, and from the rows holding it or held
 * by it ("Brainstorming: an Item can't hold other Items", issue 1825), so what
 * it held is back in the Inbox and each parent counts it out, as the server will.
 */
function dismissedAhead(snapshot: WorkspaceSnapshot, itemId: string): WorkspaceSnapshot {
  const gone = snapshot.items.find((item) => item.id === itemId);
  const rows = snapshot.children ?? [];
  const counted = gone
    ? parentIdsOf(rows, itemId).reduce((drawn, parentId) => withCounts(drawn, parentId, -1, stillOpen(gone) ? 0 : -1), snapshot)
    : snapshot;
  return {
    ...counted,
    items: counted.items.filter((item) => item.id !== itemId),
    ...(snapshot.children ? { children: rows.filter((row) => row.parentId !== itemId && row.childId !== itemId) } : {}),
  };
}

/** A parent's two counts moved by these amounts, never below nothing. */
function withCounts(snapshot: WorkspaceSnapshot, parentId: string, count: number, done: number): WorkspaceSnapshot {
  const parent = snapshot.items.find((item) => item.id === parentId);
  if (!parent) return snapshot;
  return withItem(snapshot, parentId, {
    childrenCount: Math.max(0, (parent.childrenCount ?? 0) + count),
    childrenDone: Math.max(0, (parent.childrenDone ?? 0) + done),
  });
}


drawChildrenWith({ put: putInsideAhead, putInsideInOrder: putInsideInOrderAhead, takenOut: takenOutAhead, done: doneAhead, dismissed: dismissedAhead });
