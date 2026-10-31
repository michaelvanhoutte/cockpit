import {
  DEFAULT_ITEM_FORM_PRESENTATION,
  FIRST_DASHBOARD_NAME,
  FOLLOW_UP_DAYS,
  FIRST_PANEL_NAME,
  NO_CONDITIONS,
  dayOf,
  daysOnFrom,
  firstDashboardId,
  itemSchema,
  textsFromCapture,
  nextColor,
  stillOpen,
  themeOf,
  type CommandPayload,
  type Dashboard,
  type Item,
  type Panel,
  type PanelKind,
  type Role,
  type SaveLayoutCommand,
  type Workspace,
  type WorkspaceList,
  type WorkspaceSnapshot,
} from '@cockpit/shared';
import type { CommandArgs } from './api/queries';

/**
 * A change a window makes with a request of its own rather than a command ("Show a
 * connected app or user change the moment you make it", issue 1371): the admin's
 * user changes and disconnecting a connected app. It joins the queue as it is
 * (`enqueue`'s `request`), so the saving sign and the leave-site prompt count it,
 * and the window's own chunk draws it. **An added user's `userId` is one this tab
 * made up** to tell the row apart; the server decides the real one.
 */
export type Requested =
  | { name: 'disconnect_app'; payload: { appId: string } }
  | { name: 'add_user'; payload: { userId: string; name: string; email: string } }
  | { name: 'change_user'; payload: { userId: string; name: string; role: Role } }
  | { name: 'set_user_access'; payload: { userId: string; disabled: boolean } }
  | { name: 'delete_user'; payload: { userId: string } };

/** A change the screen draws: those the queue sends, an upload, which it holds but never sends, and a window's own requests. */
export type Drawn = CommandArgs | { name: 'add_attachment'; payload: CommandPayload<'add_attachment'> } | Requested;

/**
 * What the screen shows of a change the server has not answered yet ("Show an
 * Item or filing change the moment you make it", issue 1329).
 *
 * **The Workspace as the server sent it, with the change applied to a copy.**
 * The copy the tab holds, and the one it saves on the device, are never
 * written to: a read in flight would overwrite the change, and the device
 * would keep it unconfirmed. `changeQueue.ts` decides which changes are still
 * to be drawn; this decides what each one draws.
 *
 * **Only what an Item row, a Panel, the form or the Dashboard bar shows.** What a change also does
 * on the server - ending an Item's open run, withdrawing a proposal, recording
 * where it was filed - arrives with the next read.
 *
 * **A filing is the order it carries, written over the Panel's.** An order is the
 * Panel's whole arrangement afterwards, so drawing it is replacing the Panel's
 * filings with it, bar a finished Item's it leaves out, which the server keeps;
 * what a move takes the Item off is the Panels it names, else every one.
 *
 * **A Dashboard change is drawn as the server will make it** ("Show a Dashboard
 * change the moment you make it", issue 1362): a new one at the end of the bar
 * with the Panel it arrives with, a deleted one gone with its Panels, Layout and
 * filings, and a rename the name rule would refuse drawn all the same until the
 * refusal puts the old name back.
 *
 * **So is a captured note** ("Show a capture in the Inbox the moment you make it",
 * issue 1353): an Inbox row with the note as typed - the priority and due date
 * the strip chose, and none of what Cockpit makes of it - in the Workspace it was
 * captured to, or in every one while it belongs to none. It comes from the outbox
 * (`changeQueue.ts`), never from a change sent by the queue.
 *
 * **So is a Panel change** ("Show a Panel change the moment you make it", issue
 * 1363): a new Panel at the foot of its Dashboard, the settings, filter and sort
 * as saved, a deleted Panel gone with its filings, a moved Panel on the other
 * Dashboard, and an arrangement as the Layout the Dashboard has from then on
 * (which is how a Section is added). **What the server decides is not
 * predicted**: a moved Panel keeps its own name until the rename arrives with the
 * next read.
 *
 * **So is an attachment** ("Keep an attachment's chip drawn from the moment you
 * choose the file, and remove one at once", issue 1367): an uploaded file is a
 * chip on its Item as the server will read it back, and a removed one is gone. An
 * upload is held by the queue once the server has answered it, and never sent by
 * it.
 */
export function drawnAhead(snapshot: WorkspaceSnapshot, change: Drawn): WorkspaceSnapshot {
  switch (change.name) {
    case 'capture_item':
      return capturedAhead(snapshot, change.payload);
    case 'append_to_item':
      return appendedAhead(snapshot, change.payload);
    case 'add_attachment': {
      const { attachmentId: id, itemId, filename, size, contentType, issuedAt: createdAt, workspaceId } = change.payload;
      // Once, whether or not a read begun before the answer already holds it.
      return workspaceId !== snapshot.workspace.id ||
        !snapshot.items.some((item) => item.id === itemId) ||
        snapshot.attachments.some((held) => held.id === id)
        ? snapshot
        : { ...snapshot, attachments: [...snapshot.attachments, { id, tenantId: snapshot.workspace.tenantId, itemId, filename, size, contentType, createdAt }] };
    }
    case 'remove_attachment':
      return change.payload.workspaceId !== snapshot.workspace.id
        ? snapshot
        : { ...snapshot, attachments: snapshot.attachments.filter((held) => held.id !== change.payload.attachmentId) };
    case 'set_done':
      return withItem(snapshot, change.payload.itemId, {
        completedAt: change.payload.done ? change.payload.issuedAt : null,
      });
    case 'set_started':
      return withItem(snapshot, change.payload.itemId, {
        startedAt: change.payload.started ? change.payload.issuedAt : null,
        // To do and In progress both end a wait for a reply ("Set an Item Waiting for reply", issue 1463).
        waitingSince: null,
      });
    case 'wait_for_reply':
      return waitDrawn(snapshot, change.payload);
    case 'set_priority':
      return withItem(snapshot, change.payload.itemId, { priority: change.payload.priority });
    case 'set_due_date':
      return withItem(snapshot, change.payload.itemId, { dueDate: change.payload.dueDate });
    case 'write_recurring_item':
    case 'delete_recurring_item':
      return recurringItemDrawn(snapshot, change);
    case 'set_title':
      return withItem(snapshot, change.payload.itemId, { title: change.payload.title });
    case 'set_description':
      return withItem(snapshot, change.payload.itemId, { description: change.payload.description });
    case 'set_next_action':
      return withItem(snapshot, change.payload.itemId, { nextAction: change.payload.nextAction });
    case 'set_dismissed':
      // The Workspace read holds open Items only, so a dismissed Item is simply absent.
      // Undoing one has no copy to draw it from and waits for the next read.
      return change.payload.dismissed
        ? { ...snapshot, items: snapshot.items.filter((item) => item.id !== change.payload.itemId) }
        : snapshot;
    case 'set_duplicate_settled':
      return pairSettled(snapshot, change.payload);
    case 'move_item_to_panel':
      return filedAhead(snapshot, change.payload, 'move');
    case 'add_item_to_panel':
      return filedAhead(snapshot, change.payload, 'add');
    case 'remove_item_from_panel':
      if (change.payload.workspaceId !== snapshot.workspace.id) return snapshot;
      return {
        ...snapshot,
        filings: snapshot.filings.filter(
          (filing) => !(filing.itemId === change.payload.itemId && filing.panelId === change.payload.panelId),
        ),
      };
    case 'add_dashboard':
      return dashboardAdded(snapshot, change.payload);
    case 'rename_dashboard':
      return onDashboards(snapshot, change.payload.workspaceId, (dashboards) =>
        dashboards.map((one) => (one.id === change.payload.dashboardId ? { ...one, name: change.payload.name } : one)),
      );
    case 'delete_dashboard':
      return dashboardDeleted(snapshot, change.payload);
    case 'reorder_dashboards':
      return onDashboards(snapshot, change.payload.workspaceId, (dashboards) => [
        ...change.payload.dashboardIds.flatMap((id) => dashboards.filter((one) => one.id === id)),
        // One the order never named, arrived since it was drawn: kept on the end rather than taken off the bar.
        ...dashboards.filter((one) => !change.payload.dashboardIds.includes(one.id)),
      ]);
    case 'add_panel':
      return panelAdded(snapshot, change.payload);
    case 'set_panel_settings': {
      const { name, neverPropose, readOnly, format, columns } = change.payload;
      const set = { name, neverPropose, readOnly, format, columns };
      return onPanel(snapshot, change.payload, Object.fromEntries(Object.entries(set).filter(([, value]) => value !== undefined)));
    }
    case 'set_panel_filter':
      return onPanel(snapshot, change.payload, { filter: { rows: change.payload.rows, groupBy: change.payload.groupBy } });
    case 'set_panel_sort':
      return onPanel(snapshot, change.payload, { sort: change.payload.sort });
    case 'move_panel_to_dashboard':
      // Under its own name: the server renames it where the target holds one of that name, and says so with the next read.
      return onPanel(snapshot, change.payload, { dashboardId: change.payload.dashboardId });
    case 'delete_panel':
      return change.payload.workspaceId !== snapshot.workspace.id
        ? snapshot
        : {
            ...snapshot,
            panels: snapshot.panels.filter((panel) => panel.id !== change.payload.panelId),
            filings: snapshot.filings.filter((filing) => filing.panelId !== change.payload.panelId),
          };
    case 'save_layout':
      return layoutSaved(snapshot, change.payload);
    case 'create_workspace':
      // A Workspace arrives with its first Dashboard and that Dashboard's Panel,
      // which `noSnapshotYet` below holds. **Only over a Workspace with no
      // Dashboard**: a read of a real one holds them already, and one the tab
      // deleted since must not come back until the list is read.
      return snapshot.dashboards.length > 0
        ? snapshot
        : dashboardAdded(snapshot, {
            workspaceId: change.payload.workspaceId,
            dashboardId: firstDashboardId(change.payload.workspaceId),
            panelId: change.payload.panelId,
            name: FIRST_DASHBOARD_NAME,
          });
    default:
      return snapshot;
  }
}

/**
 * The Workspace as the tab has it before the server has ever sent it: what the
 * add makes and nothing else ("Open a new Workspace the moment you add it",
 * issue 1366). Held in place of a read that would find nothing, and read for
 * properly once the add is answered. **The first Dashboard and Panel are in the
 * held copy itself**, because the list read that ends drawing the add can land
 * before the Workspace's own read does.
 */
export function noSnapshotYet(added: CommandArgs): WorkspaceSnapshot {
  const { workspaceId } = added.payload;
  return drawnAhead(heldBlank(workspaceId), added);
}

function heldBlank(workspaceId: string): WorkspaceSnapshot {
  return {
    workspace: { id: workspaceId, tenantId: '', name: '', color: '', bar: '', ground: '', header: '' },
    items: [],
    dashboards: [],
    panels: [],
    layouts: [],
    filings: [],
    associations: [],
    attachments: [],
    series: [],
    itemFormPresentation: DEFAULT_ITEM_FORM_PRESENTATION,
    followUpDays: FOLLOW_UP_DAYS,
    duplicates: [],
    agentRuns: [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * A captured note as an Inbox row, named as the server names it from the note
 * (`textsFromCapture`): its words for the title, the note itself as the
 * description where those differ. What Cockpit makes of it later - a better
 * title, the readings - arrives with a read. **In the Workspace it names, or in every
 * one while it belongs to none**, and not at all where the read holds the row.
 */
function capturedAhead(snapshot: WorkspaceSnapshot, note: CommandPayload<'capture_item'>): WorkspaceSnapshot {
  const decided = note.workspaceDecided !== false;
  if ((decided && note.workspaceId !== snapshot.workspace.id) || snapshot.items.some((item) => item.id === note.itemId)) {
    return snapshot;
  }
  const item = {
    // Nothing is read, proposed or settled yet: every field the note does not fill is null.
    ...Object.fromEntries(Object.keys(itemSchema.shape).map((field) => [field, null])),
    id: note.itemId,
    tenantId: snapshot.workspace.tenantId,
    workspaceId: note.workspaceId,
    workspaceDecided: decided,
    capturedMessage: note.message,
    source: 'internal',
    ...(note.title ? { title: note.title, description: note.message } : textsFromCapture(note.message)),
    priority: note.priority ?? null,
    dueDate: note.dueDate ?? null,
    unseen: false,
    createdAt: note.issuedAt,
    updatedAt: note.issuedAt,
  } as Item;
  return { ...snapshot, items: [...snapshot.items, item] };
}

/**
 * A note added to an Item ("Capture append: add to the Item you just captured
 * with an Add to this button", issue 1640): one more addition on its *Details*
 * tab, at the time Capture was pressed, with the priority and due date the strip
 * picked for it, if any. **Wherever the Item is drawn**, and once, whether or not
 * a read already holds it. It comes from the outbox, as a capture does, or from
 * the queue where the outbox could not keep it.
 */
function appendedAhead(snapshot: WorkspaceSnapshot, added: CommandPayload<'append_to_item'>): WorkspaceSnapshot {
  const held = snapshot.additions ?? [];
  if (!snapshot.items.some((item) => item.id === added.itemId) || held.some((one) => one.id === added.additionId)) {
    return snapshot;
  }
  const addition = {
    id: added.additionId,
    tenantId: snapshot.workspace.tenantId,
    itemId: added.itemId,
    message: added.message,
    createdAt: added.issuedAt,
  };
  const picked = {
    ...(added.priority ? { priority: added.priority } : {}),
    ...(added.dueDate ? { dueDate: added.dueDate } : {}),
  };
  return withItem({ ...snapshot, additions: [...held, addition] }, added.itemId, picked);
}

/**
 * A recurring item written or deleted ("Point a copy at its master, and retire the
 * Repeats chip", issue 1450): the series its copies name, as the server will hold
 * it, so each copy's ↻ and *From recurring item* line say it at once - the title
 * and rule written over it, and a deletion as the same series stopped. In whichever
 * Workspace the snapshot is, since a copy can be filed outside its recurring item's.
 * **What the server decides is not predicted**: a *Next on* it refuses goes back with
 * the refusal. A recurring item just made has no copy to draw.
 */
function recurringItemDrawn(
  snapshot: WorkspaceSnapshot,
  change: { name: 'write_recurring_item' | 'delete_recurring_item'; payload: CommandPayload<'write_recurring_item'> | CommandPayload<'delete_recurring_item'> },
): WorkspaceSnapshot {
  const seriesId = change.payload.seriesId;
  if (!snapshot.series.some((one) => one.id === seriesId)) return snapshot;
  const series = snapshot.series.map((one) => {
    if (one.id !== seriesId) return one;
    if (change.name === 'delete_recurring_item') return { ...one, stoppedAt: one.stoppedAt ?? change.payload.issuedAt };
    const { title, repeat, workspaceId } = change.payload as CommandPayload<'write_recurring_item'>;
    return { ...one, ...repeat, title, workspaceId, stoppedAt: null };
  });
  return { ...snapshot, series };
}

/**
 * A wait for a reply as the server will hold it ("Set an Item Waiting for reply,
 * and wait again after chasing", issue 1463): waiting since the change, or since
 * the day it first started waiting, and due `days` after the day the change was
 * made on, on this device's calendar.
 */
function waitDrawn(snapshot: WorkspaceSnapshot, change: CommandPayload<'wait_for_reply'>): WorkspaceSnapshot {
  const item = snapshot.items.find((one) => one.id === change.itemId);
  if (!item) return snapshot;
  return withItem(snapshot, item.id, {
    waitingSince: item.waitingSince ?? change.issuedAt,
    dueDate: daysOnFrom(dayOf(new Date(change.issuedAt)), change.days),
  });
}

/**
 * A pair settled as not a duplicate is gone from the Workspace's pairs, and one
 * taken back is among them again ("Show a *Not a duplicate* the moment you say
 * it, and its Undo", issue 1355) - **only while both Items are still in the copy**,
 * since the server leaves out a pair it could no longer act on. A pair is one
 * whichever Item is named first, so a row flagged against two others has two to
 * settle, and the change names one.
 */
function pairSettled(snapshot: WorkspaceSnapshot, pair: CommandPayload<'set_duplicate_settled'>): WorkspaceSnapshot {
  const { workspaceId, itemId, otherItemId, settled } = pair;
  if (workspaceId !== snapshot.workspace.id) return snapshot;
  const duplicates = snapshot.duplicates.filter(
    (held) => ![[itemId, otherItemId], [otherItemId, itemId]].some(([a, b]) => held.itemId === a && held.otherItemId === b),
  );
  const bothHere = [itemId, otherItemId].every((id) => snapshot.items.some((item) => item.id === id));
  if (settled || !bothHere) return { ...snapshot, duplicates };
  return { ...snapshot, duplicates: [...duplicates, { itemId, otherItemId }] };
}

/** One Panel rewritten, in the Workspace the change names and no other. */
function onPanel(
  snapshot: WorkspaceSnapshot,
  change: { workspaceId: string; panelId: string },
  fields: Partial<Panel>,
): WorkspaceSnapshot {
  if (change.workspaceId !== snapshot.workspace.id) return snapshot;
  return { ...snapshot, panels: snapshot.panels.map((panel) => (panel.id === change.panelId ? { ...panel, ...fields } : panel)) };
}

/**
 * A Panel at the foot of its Dashboard. **Not placed in the Layout**: the board
 * draws a Panel its Layout has never heard of on a row of its own at the foot,
 * which is where the server puts it (`drawnRows`).
 */
function panelAdded(
  snapshot: WorkspaceSnapshot,
  added: { workspaceId: string; dashboardId: string; panelId: string; name: string; kind: PanelKind },
): WorkspaceSnapshot {
  if (added.workspaceId !== snapshot.workspace.id) return snapshot;
  if (snapshot.panels.some((panel) => panel.id === added.panelId)) return snapshot;
  const { tenantId } = snapshot.workspace;
  const { dashboardId, name, kind } = added;
  const panel: Panel = {
    id: added.panelId,
    tenantId,
    dashboardId,
    name,
    kind,
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: kind === 'filter' ? NO_CONDITIONS : null,
    sort: null,
    columns: null,
  };
  return { ...snapshot, panels: [...snapshot.panels, panel] };
}

/** A Dashboard's arrangement as saved: its one Layout, made where it has none. */
function layoutSaved(snapshot: WorkspaceSnapshot, saved: SaveLayoutCommand): WorkspaceSnapshot {
  if (saved.workspaceId !== snapshot.workspace.id) return snapshot;
  const own = snapshot.layouts.find((layout) => layout.dashboardId === saved.dashboardId);
  const layouts = own
    ? snapshot.layouts.map((layout) => (layout === own ? { ...layout, rows: saved.rows } : layout))
    : [...snapshot.layouts, { id: saved.layoutId, tenantId: snapshot.workspace.tenantId, dashboardId: saved.dashboardId, rows: saved.rows }];
  return { ...snapshot, layouts };
}

/** The Workspace's Dashboards rewritten, in the Workspace the change names and no other. */
function onDashboards(
  snapshot: WorkspaceSnapshot,
  workspaceId: string,
  rewrite: (dashboards: Dashboard[]) => Dashboard[],
): WorkspaceSnapshot {
  if (workspaceId !== snapshot.workspace.id) return snapshot;
  return { ...snapshot, dashboards: rewrite(snapshot.dashboards) };
}

/** A Dashboard at the end of the bar, with the one Panel of items every Dashboard arrives with. */
function dashboardAdded(
  snapshot: WorkspaceSnapshot,
  added: { workspaceId: string; dashboardId: string; panelId: string; name: string },
): WorkspaceSnapshot {
  if (added.workspaceId !== snapshot.workspace.id) return snapshot;
  if (snapshot.dashboards.some((one) => one.id === added.dashboardId)) return snapshot;
  const { tenantId } = snapshot.workspace;
  return {
    ...snapshot,
    dashboards: [...snapshot.dashboards, { id: added.dashboardId, tenantId, workspaceId: added.workspaceId, name: added.name }],
    panels: [
      ...snapshot.panels,
      {
        id: added.panelId,
        tenantId,
        dashboardId: added.dashboardId,
        name: FIRST_PANEL_NAME,
        kind: 'items',
        format: 'plain',
        body: '',
        readOnly: false,
        neverPropose: false,
        filter: null,
        sort: null,
        columns: null,
      },
    ],
  };
}

/**
 * A Dashboard gone, and its Panels, Layout and filings with it. **Not the last
 * one**: a Workspace without a Dashboard has no view, so the server refuses that
 * delete and nothing is drawn for it.
 */
function dashboardDeleted(
  snapshot: WorkspaceSnapshot,
  deleted: { workspaceId: string; dashboardId: string },
): WorkspaceSnapshot {
  if (deleted.workspaceId !== snapshot.workspace.id) return snapshot;
  if (snapshot.dashboards.length < 2 || !snapshot.dashboards.some((one) => one.id === deleted.dashboardId)) return snapshot;
  const gone = new Set(snapshot.panels.filter((panel) => panel.dashboardId === deleted.dashboardId).map((panel) => panel.id));
  return {
    ...snapshot,
    dashboards: snapshot.dashboards.filter((one) => one.id !== deleted.dashboardId),
    panels: snapshot.panels.filter((panel) => !gone.has(panel.id)),
    layouts: snapshot.layouts.filter((layout) => layout.dashboardId !== deleted.dashboardId),
    filings: snapshot.filings.filter((filing) => !gone.has(filing.panelId)),
  };
}

/**
 * An Item filed on a Panel, or - with no Panel - back in the Inbox.
 *
 * **Only in the Workspace the filing names**: an Item that belongs to none is
 * drawn in every Workspace's Inbox, and the others catch up with the read.
 */
function filedAhead(
  snapshot: WorkspaceSnapshot,
  filing: { workspaceId: string; itemId: string; panelId: string | null; order: string[]; fromPanelIds?: string[] | undefined },
  how: 'move' | 'add',
): WorkspaceSnapshot {
  if (filing.workspaceId !== snapshot.workspace.id) return snapshot;
  const item = snapshot.items.find((one) => one.id === filing.itemId);
  if (!item) return snapshot;
  const named = filing.panelId === null ? [] : (filing.fromPanelIds ?? []);
  const takenOff = (panelId: string) => how === 'move' && (named.length === 0 || named.includes(panelId));
  // A finished Item the order leaves out keeps its place, as the server keeps one finished more than a day ago
  // ("Open a Workspace without its finished Items", issue 1435): only a copy with the finished read merged in holds one.
  const inTheOrder = new Set(filing.order);
  const finished = new Set(snapshot.items.filter((one) => !stillOpen(one)).map((one) => one.id));
  const keptOnTheTarget = (held: { itemId: string }) => !inTheOrder.has(held.itemId) && finished.has(held.itemId);
  const kept = snapshot.filings.filter(
    (held) =>
      !(held.itemId === filing.itemId && takenOff(held.panelId)) &&
      (filing.panelId === null || held.panelId !== filing.panelId || keptOnTheTarget(held)),
  );
  const landed =
    filing.panelId === null
      ? []
      : filing.order.map((itemId, position) => ({ panelId: filing.panelId!, itemId, position }));
  const filed = { ...snapshot, filings: [...kept, ...landed] };
  // Filing is what settles which Workspace an Item belongs to.
  return item.workspaceDecided === false
    ? withItem(filed, item.id, { workspaceDecided: true, workspaceId: filing.workspaceId })
    : filed;
}

/**
 * The changes to the list of Workspaces, drawn over it rather than over a
 * Workspace ("Show a Workspace rename, colour, delete or reorder the moment
 * you make it", issue 1365): kept drawn until a read of *the list* that began
 * after their answer lands, whichever Workspace's own read lands first. An add
 * is one of them ("Open a new Workspace the moment you add it", issue 1366).
 */
export const WORKSPACE_LIST_CHANGES: ReadonlySet<Drawn['name']> = new Set([
  'create_workspace',
  'rename_workspace',
  'set_workspace_theme',
  'delete_workspace',
  'reorder_workspaces',
]);

/**
 * The list of Workspaces as the server will have it after one more change.
 * **A colour the palette does not have is not drawn**, since the server refuses
 * it; one it has brings its other three colours, which the palette decides.
 * A rename the name rule would refuse is drawn all the same until the refusal
 * puts the old name back. **A new Workspace goes at the end in the first colour
 * no other wears**, as the server makes it; its `tenantId` is the account's, which
 * nothing here reads.
 */
function workspacesDrawnAhead(list: WorkspaceList, change: Drawn): WorkspaceList {
  const { workspaces } = list;
  const rewrite = (id: string, fields: Partial<Workspace>) => ({
    workspaces: workspaces.map((one) => (one.id === id ? { ...one, ...fields } : one)),
  });
  switch (change.name) {
    case 'create_workspace': {
      const { workspaceId: id, name } = change.payload;
      if (workspaces.some((one) => one.id === id)) return list;
      const { tint: color, bar, ground, header } = themeOf(nextColor(workspaces.map((one) => one.color)));
      return { workspaces: [...workspaces, { id, tenantId: workspaces[0]?.tenantId ?? '', name, color, bar, ground, header }] };
    }
    case 'rename_workspace':
      return rewrite(change.payload.workspaceId, { name: change.payload.name });
    case 'set_workspace_theme': {
      const { tint, bar, ground, header } = themeOf(change.payload.color);
      return tint === change.payload.color ? rewrite(change.payload.workspaceId, { color: tint, bar, ground, header }) : list;
    }
    case 'delete_workspace':
      return { workspaces: workspaces.filter((one) => one.id !== change.payload.workspaceId) };
    case 'reorder_workspaces': {
      const named = change.payload.workspaceIds;
      return {
        // One the order never named, arrived since it was drawn: kept on the end rather than taken off the strip.
        workspaces: [...named.flatMap((id) => workspaces.filter((one) => one.id === id)), ...workspaces.filter((one) => !named.includes(one.id))],
      };
    }
    default:
      return list;
  }
}

/**
 * The changes `drawnAhead` draws something for, which are the ones kept drawn
 * after their answer until a read covers them. A capture is drawn as well, but
 * the outbox sends it and the queue only holds it (`changeQueue.ts`).
 */
export const DRAWN_AHEAD: ReadonlySet<Drawn['name']> = new Set([
  ...WORKSPACE_LIST_CHANGES,
  'move_item_to_panel',
  'add_item_to_panel',
  'remove_item_from_panel',
  'remove_attachment',
  // An addition the outbox could not keep, sent by the queue instead (issue 1640).
  'append_to_item',
  'set_done',
  'set_started',
  'wait_for_reply',
  'set_priority',
  'set_due_date',
  'write_recurring_item',
  'delete_recurring_item',
  'set_title',
  'set_description',
  'set_next_action',
  'set_dismissed',
  'set_duplicate_settled',
  'add_dashboard',
  'rename_dashboard',
  'delete_dashboard',
  'reorder_dashboards',
  'add_panel',
  'set_panel_settings',
  'set_panel_filter',
  'set_panel_sort',
  'move_panel_to_dashboard',
  'delete_panel',
  'save_layout',
]);

/** The changes in the order they were made, each drawn over the one before. */
export function drawnOver(snapshot: WorkspaceSnapshot, changes: readonly Drawn[]): WorkspaceSnapshot {
  return changes.reduce(drawnAhead, snapshot);
}

/** The list of Workspaces with the changes drawn over it, in the order they were made. */
export function listDrawnOver(list: WorkspaceList, changes: readonly Drawn[]): WorkspaceList {
  return changes.reduce(workspacesDrawnAhead, list);
}

function withItem(snapshot: WorkspaceSnapshot, itemId: string, fields: Partial<Item>): WorkspaceSnapshot {
  if (!snapshot.items.some((item) => item.id === itemId)) return snapshot;
  return {
    ...snapshot,
    items: snapshot.items.map((item) => (item.id === itemId ? { ...item, ...fields } : item)),
  };
}
