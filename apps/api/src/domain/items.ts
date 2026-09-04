import type {
  AssociateCommand,
  Association,
  CaptureItemCommand,
  Item,
  SetDismissedCommand,
  SetDoneCommand,
  SetNextActionCommand,
  SetPriorityCommand,
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
    typeId: cmd.typeId ?? null,
    nextAction: cmd.nextAction ?? null,
    completedAt: null,
    priority: null,
    dueDate: null,
    unseen: false,
    deletedAt: null,
    createdAt: cmd.issuedAt,
    updatedAt: cmd.issuedAt,
  };
}

/**
 * Finishing with an item, and taking that back ("An item is either yours to
 * deal with or finished with", issue 154).
 *
 * The command's own timestamp is the completion time rather than the moment the
 * store saw it, so a change made offline and sent later says when it was made.
 */
export function applySetDone(item: Item, cmd: SetDoneCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return {
    ...item,
    completedAt: cmd.done ? cmd.issuedAt : null,
    updatedAt: cmd.issuedAt,
  };
}

/**
 * Dismissal is the soft delete of the triage flow: tombstone, never erase, and
 * **undismissing lifts the tombstone**, which is what makes it reversible
 * ("Undo what just happened", issue 144).
 *
 * Dismissal is the only thing that writes `deletedAt`, so clearing it here
 * cannot lose a tombstone somebody else set. It leaves `completedAt` alone in
 * both directions: dismissing something already finished with does not unfinish
 * it, and bringing it back does not either.
 */
export function applySetDismissed(item: Item, cmd: SetDismissedCommand): Item | null {
  if (isStale(item, cmd.issuedAt)) return null;
  return {
    ...item,
    deletedAt: cmd.dismissed ? cmd.issuedAt : null,
    updatedAt: cmd.issuedAt,
  };
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
