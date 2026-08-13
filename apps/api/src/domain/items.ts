import type {
  AssociateCommand,
  Association,
  CaptureItemCommand,
  Item,
  SetFocusCommand,
  SetNextActionCommand,
  SetPriorityCommand,
  SetStatusCommand,
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
    title: cmd.title,
    preview: cmd.body ?? null,
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
    // Dismissal is the soft delete of the triage flow: tombstone, never erase.
    deletedAt: cmd.status === 'dismissed' ? cmd.issuedAt : item.deletedAt,
    updatedAt: cmd.issuedAt,
  };
}

export function applySnoozeUntil(item: Item, cmd: SnoozeUntilCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return { ...item, status: 'snoozed', snoozedUntil: cmd.until, updatedAt: cmd.issuedAt };
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
