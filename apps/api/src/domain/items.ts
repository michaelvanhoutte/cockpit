import type {
  AssociateCommand,
  Association,
  CaptureItemCommand,
  Item,
  SetDescriptionCommand,
  SetFocusCommand,
  SetNextActionCommand,
  SetPriorityCommand,
  SetStatusCommand,
  SetTitleCommand,
  SnoozeUntilCommand,
} from '@cockpit/shared';

/**
 * Pure command handlers (architecture §6.1: domain imports nothing from the
 * other layers). Each takes domain objects in and returns domain objects out,
 * which is what keeps the L1 test tier a property of the design.
 *
 * Conflict resolution is last-write-wins on the command's client timestamp
 * (§4.2). v1 compares per row; per-field LWW is the documented refinement if
 * two devices ever fight over different fields of the same item.
 */

/** Returns true when the command is older than what the row already reflects. */
export function isStale(item: Item, issuedAt: string): boolean {
  return issuedAt < item.updatedAt;
}

export function captureItem(cmd: CaptureItemCommand, tenantId: string): Item {
  return {
    id: cmd.itemId,
    tenantId,
    workspaceId: cmd.workspaceId,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    // What was said is the captured message and nothing else. The title is left
    // empty deliberately: naming a thought is a second act, and the row falls
    // through to the captured message until somebody performs it (`itemLabel`).
    capturedMessage: cmd.message,
    title: '',
    description: null,
    sourceResolvedAt: null,
    status: 'to_process',
    nextAction: cmd.nextAction ?? null,
    focusHorizon: null,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
    unseen: false,
    deletedAt: null,
    createdAt: cmd.issuedAt,
    updatedAt: cmd.issuedAt,
  };
}

export function applySetStatus(item: Item, cmd: SetStatusCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return {
    ...item,
    status: cmd.status,
    // Leaving the snoozed state always clears the snooze date.
    snoozedUntil: cmd.status === 'snoozed' ? item.snoozedUntil : null,
    // Dismissal is the soft delete of the triage flow: tombstone, never erase -
    // and **any other status lifts the tombstone**, which is what makes a
    // dismissal reversible ("Undo what just happened", issue 144). It read
    // `item.deletedAt` before, so a dismissed item stayed out of every list
    // whatever it was given afterwards: nothing was destroyed and nothing could
    // be brought back either. Dismissal is the only thing that writes this
    // column, so clearing it here cannot lose a tombstone somebody else set.
    deletedAt: cmd.status === 'dismissed' ? cmd.issuedAt : null,
    updatedAt: cmd.issuedAt,
  };
}

export function applySnoozeUntil(item: Item, cmd: SnoozeUntilCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return {
    ...item,
    status: 'snoozed',
    snoozedUntil: cmd.until,
    // Snoozing lifts a dismissal, for the same reason every other status does
    // (`applySetStatus`): an item hidden until a date is not one that has been
    // got rid of. It is also the only way back for a *snoozed* item that was
    // dismissed - putting only its status back would lose the date it was
    // waiting for, so undoing that dismissal comes through here rather than
    // through a status.
    deletedAt: null,
    updatedAt: cmd.issuedAt,
  };
}

export function applySetFocus(item: Item, cmd: SetFocusCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return { ...item, focusHorizon: cmd.horizon, updatedAt: cmd.issuedAt };
}

export function applySetNextAction(item: Item, cmd: SetNextActionCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return { ...item, nextAction: cmd.nextAction, updatedAt: cmd.issuedAt };
}

export function applySetPriority(item: Item, cmd: SetPriorityCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return { ...item, priority: cmd.priority, updatedAt: cmd.issuedAt };
}

export function applySetTitle(item: Item, cmd: SetTitleCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return { ...item, title: cmd.title, updatedAt: cmd.issuedAt };
}

/**
 * The captured message is untouched here, and there is no handler that touches
 * it: it is written by `captureItem` and never again (architecture, "Schema
 * conventions"). That is the whole of its immutability - no trigger, because a
 * column with no writer needs none.
 */
export function applySetDescription(item: Item, cmd: SetDescriptionCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  // An emptied description is a cleared one, so it is stored as absent rather
  // than as an empty string nothing else in the product would distinguish.
  return { ...item, description: cmd.description || null, updatedAt: cmd.issuedAt };
}

export function associationFromCommand(cmd: AssociateCommand, tenantId: string): Association {
  return {
    id: cmd.associationId,
    tenantId,
    itemId: cmd.itemId,
    kind: cmd.kind,
    label: cmd.label,
    createdAt: cmd.issuedAt,
  };
}
