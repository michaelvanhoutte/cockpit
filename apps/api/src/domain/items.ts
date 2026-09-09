import {
  textsFromCapture,
  type AssociateCommand,
  type Association,
  type CaptureItemCommand,
  type Item,
  type ProposeItemTextsCommand,
  type SetDescriptionCommand,
  type SetDismissedCommand,
  type SetDoneCommand,
  type SetNextActionCommand,
  type SetPriorityCommand,
  type SetTitleCommand,
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
  const texts = textsFromCapture(cmd.message);
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
    // What was said names the Item, and is kept beside it exactly as it was
    // said. Which of the two texts it becomes is `textsFromCapture`, and why an
    // Item has both is on the field in packages/shared/src/domain/item.ts.
    capturedMessage: cmd.message,
    title: texts.title,
    description: texts.description,
    // Nobody has taken these two over, so Cockpit may still replace them once
    // it has read the note ("Clean up a captured note into a clear title and a
    // fuller message", issue 296). Editing either is what settles both.
    textsSettledAt: null,
    sourceResolvedAt: null,
    // Every capture names one, so nothing is defaulted here. The column stays
    // nullable for the Items that have no Type - captured before Types
    // existed, or labelled with one since deleted.
    typeId: cmd.typeId,
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
  return { ...item, title: cmd.title, ...settledBy(item, cmd.issuedAt), updatedAt: cmd.issuedAt };
}

/**
 * Editing either of an Item's two texts takes both of them over from Cockpit,
 * for good ("Clean up a captured note into a clear title and a fuller message",
 * issue 296).
 *
 * **The first answer wins**, exactly as it does for the Workspace an Item
 * belongs to: this records when a person took the texts over, not when they
 * last touched them, so a second edit is not a second answer to the same
 * question. That also makes it safe to write on every edit rather than only the
 * first, which is what keeps this one expression instead of a branch.
 */
function settledBy(item: Item, issuedAt: string): Pick<Item, 'textsSettledAt'> {
  return { textsSettledAt: item.textsSettledAt ?? issuedAt };
}

/**
 * The title and the message Cockpit read out of the captured note, written
 * together ("Clean up a captured note into a clear title and a fuller message",
 * issue 296).
 *
 * **Refused outright once a person has taken the texts over**, rather than
 * resolved last-write-wins like everything else here. The clocks are not
 * comparable - this carries the moment the job ran, and an edit carries the
 * device's own - and the rule is not about which happened later anyway: Cockpit
 * may replace what it proposed and never what a person settled, which is the
 * same rule `decideWorkspace` above states for where an Item belongs. It is
 * also what makes a redelivered job a no-op instead of a clobber, which
 * at-least-once delivery guarantees will happen eventually.
 *
 * **`updatedAt` is deliberately left where it is.** Every other handler here
 * refuses a command older than it, so raising it to the moment the job happened
 * to run would let a proposal arriving three seconds after capture refuse an
 * edit made two seconds after capture on a device with a slow connection. A
 * proposal is not a change somebody made, so it does not move the clock other
 * people's changes are measured against; what a browser reads it back through
 * is the account's own change log, not this field.
 */
export function applyProposedTexts(item: Item, cmd: ProposeItemTextsCommand): Item | null {
  if (item.textsSettledAt !== null) return null;
  return { ...item, title: cmd.title, description: cmd.description };
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
  return {
    ...item,
    description: cmd.description || null,
    ...settledBy(item, cmd.issuedAt),
    updatedAt: cmd.issuedAt,
  };
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
