import type {
  AssociateCommand,
  Association,
  CaptureItemCommand,
  Item,
  SetDescriptionCommand,
  SetDismissedCommand,
  SetDoneCommand,
  SetNextActionCommand,
  SetPriorityCommand,
  SetTitleCommand,
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
    /**
     * Decided unless the capture says otherwise ("Capture something before you
     * know which workspace it belongs to", issue 165), so a front door with no
     * opinion - an SMS, a connector, the Inbox's own row - captures into the
     * Workspace it named, as it always did.
     */
    workspaceDecided: cmd.workspaceDecided ?? true,
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
 * Where an Item belongs, said for the first time ("Capture something before you
 * know which workspace it belongs to", issue 165).
 *
 * **The first answer wins, not the last one.** Everything else about an item is
 * last-write-wins on the command's clock, and this deliberately is not: an Item
 * belonging to no Workspace is a question, and once somebody has answered it
 * there is nothing left for a later command to be more recent about. So an Item
 * that already belongs somewhere returns null - nothing to write - which is
 * also what makes filing it onto a second Panel leave its Workspace alone.
 *
 * That is the rule a proposed routing will need too: the system may replace
 * what it proposed, never what a person settled.
 */
export function decideWorkspace(item: Item, workspaceId: string, issuedAt: string): Item | null {
  if (item.workspaceDecided) return null;
  return {
    ...item,
    workspaceId,
    workspaceDecided: true,
    // **Never backwards**, which is why this is not simply `issuedAt`. The
    // answer stands whenever it was given - a settling is not refused for being
    // stale, because a question already answered has nothing to be stale about
    // - but `updatedAt` is what every other handler measures staleness by, so
    // lowering it here would let a command they had rightly rejected through.
    updatedAt: issuedAt > item.updatedAt ? issuedAt : item.updatedAt,
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
