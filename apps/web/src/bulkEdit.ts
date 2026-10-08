import { itemLabel, itemStatus, type Item, type ItemStatus, type ItemType, type Priority } from '@cockpit/shared';
import { CommandRefused } from './api/client';
import type { CommandArgs } from './api/queries';
import { fieldWrites, type StatusState } from './itemFieldCommands';

/**
 * Changing one field of everything a selection holds ("Change the type,
 * priority, due date or status of every selected item from the selection bar",
 * issue 864).
 *
 * **The deciding is here, and pure**, with the sending handed in: which Items
 * need a change, which commands each takes, and what putting each back means are
 * decisions with cases, and a decision kept out of the component is one that can
 * be proved without a rendered bar. The commands are the one-Item field commands
 * the item's form and a row's Status already send (`fieldWrites`), one Item after
 * another - no new command, nothing on the server.
 */

/** The four fields the bar edits; the form's other two are text. */
export type BulkField = 'typeId' | 'priority' | 'dueDate' | 'status';
export type BulkValue = string | Priority | ItemStatus | null;

/** What an Item holds for a field, in the form `fieldWrites` takes it. */
export function valueOf(item: Item, field: BulkField): BulkValue {
  switch (field) {
    case 'typeId':
      return item.typeId ?? null;
    case 'priority':
      return item.priority ?? null;
    case 'dueDate':
      return item.dueDate ?? null;
    case 'status':
      return itemStatus(item);
  }
}

/** Where an Item stands, which the status commands are chosen by. */
export function stateOf(item: Item): StatusState {
  return { status: itemStatus(item), started: item.startedAt != null };
}

/**
 * What every Item shares for a field, or that they differ. A Done Item cannot
 * be picked, so a status is never Done here; an Item with no type beside typed
 * ones is a difference like any other.
 */
export type Shared = { mixed: true } | { mixed: false; value: BulkValue };

export function sharedValue(items: readonly Item[], field: BulkField): Shared {
  const [first, ...rest] = items;
  if (!first) return { mixed: true };
  const value = valueOf(first, field);
  return rest.every((item) => valueOf(item, field) === value) ? { mixed: false, value } : { mixed: true };
}

/** What one Item became, and what it was - which is all putting it back needs. */
export interface Changed {
  item: Item;
  before: BulkValue;
  /** Where the Item stands once the change landed, which the commands that put it back start from. */
  after: StatusState;
  /** The agent run Done ended, which the Undo names so the server reopens exactly that one. */
  endedRunId?: string;
}

export interface Refused {
  item: Item;
  why: string;
}

/** What sends a command and what an envelope for one Item holds, handed in so the run can be proved with neither. */
export interface Sending {
  send: (args: CommandArgs) => Promise<{ applied: boolean }>;
  envelope: (itemId: string) => () => { commandId: string; issuedAt: string; workspaceId: string; itemId: string };
}

const CHANGED_ELSEWHERE = 'That item changed somewhere else.';

/**
 * Why a command did not land: the server's own words where it gave any, and a
 * stale write (answered with a 200 and `applied: false`) as the Item having
 * changed elsewhere. A network failure is a refusal of that Item like any other.
 */
export function whyNot(error: unknown): string {
  if (error instanceof CommandRefused) return error.message;
  return error instanceof Error && error.message ? error.message : 'That could not be saved.';
}

async function sendAll(sending: Sending, commands: readonly CommandArgs[]): Promise<void> {
  for (const command of commands) {
    if (!(await sending.send(command)).applied) throw new Error(CHANGED_ELSEWHERE);
  }
}

/**
 * The Items a choice would change: those not already holding the value. A type
 * that does not exist is offered to nobody, so it changes nothing.
 */
export function needingTheChange(
  items: readonly Item[],
  field: BulkField,
  value: BulkValue,
  types: readonly ItemType[],
): Item[] {
  if (field === 'typeId' && !types.some((type) => type.id === value)) return [];
  return items.filter((item) => valueOf(item, field) !== value);
}

/**
 * Sets a field on every Item that does not already hold the value, one Item
 * after another.
 *
 * **A refusal is recorded against its Item and the run goes on**, unlike filing
 * several, which stops at the first: filing builds each order on the one before
 * it, where these Items are independent of each other. What did change and what
 * did not are both answered, so the bar can say how many were not changed and
 * why, and the Undo can cover exactly the ones that were.
 */
export async function editSeveral(
  sending: Sending,
  options: {
    items: readonly Item[];
    field: BulkField;
    value: BulkValue;
    types: readonly ItemType[];
    /** The open agent run of an Item, which Done ends. */
    runOf: (itemId: string) => string | undefined;
    /** Told which Item (counting from one) of how many is being sent. */
    onProgress: (at: number, of: number) => void;
  },
): Promise<{ changed: Changed[]; refused: Refused[] }> {
  const { field, value } = options;
  const toChange = needingTheChange(options.items, field, value, options.types);
  const changed: Changed[] = [];
  const refused: Refused[] = [];
  for (const [at, item] of toChange.entries()) {
    options.onProgress(at + 1, toChange.length);
    const writes = fieldWrites(field, sending.envelope(item.id), value, stateOf(item));
    try {
      await sendAll(sending, writes.map((write) => write.command));
      const endedRunId = field === 'status' && value === 'done' ? options.runOf(item.id) : undefined;
      changed.push({
        item,
        before: valueOf(item, field),
        after: writes.at(-1)?.held ?? stateOf(item),
        ...(endedRunId && { endedRunId }),
      });
    } catch (error) {
      refused.push({ item, why: whyNot(error) });
    }
  }
  return { changed, refused };
}

/**
 * Puts each changed Item back to its own previous value, with the same
 * commands. **Stops at the first refusal and says how far it got**, leaving the
 * rest as they are now, because offering the same Undo again would be guessing a
 * second time.
 *
 * An Item that had no type has nothing to go back to - no command sets a type
 * to none - and is left out, as the form's Undo leaves it.
 */
export async function putBack(
  sending: Sending,
  field: BulkField,
  changed: readonly Changed[],
): Promise<void> {
  const toPutBack = changed.filter(({ before }) => !(field === 'typeId' && before === null));
  for (const [at, { item, before, after, endedRunId }] of toPutBack.entries()) {
    const writes = fieldWrites(field, sending.envelope(item.id), before, after).map(({ command }) =>
      endedRunId && command.name === 'set_done' && !command.payload.done
        ? { ...command, payload: { ...command.payload, reopensRunId: endedRunId } }
        : command,
    );
    try {
      await sendAll(sending, writes);
    } catch (error) {
      throw new Error(
        `${at} of ${toPutBack.length} put back, the rest still changed. ${whyNot(error)}`,
      );
    }
  }
}

/** How many changed Items an Undo cannot return, for the sentence that offers it. */
export function cannotBePutBack(field: BulkField, changed: readonly Changed[]): number {
  return field === 'typeId' ? changed.filter(({ before }) => before === null).length : 0;
}

/** The names the bar uses for a field. */
export const BULK_FIELD_NAMES: Record<BulkField, string> = {
  typeId: 'Type',
  priority: 'Priority',
  dueDate: 'Due date',
  status: 'Status',
};

/** What the offer to undo says happened: what was done, to how many. */
export function whatWasChanged(
  field: BulkField,
  /** What the choice is called, or null for the due date being cleared. */
  valueName: string | null,
  changed: readonly Changed[],
): string {
  const done = valueName === null ? 'Due date cleared' : `${BULK_FIELD_NAMES[field]} set to ${valueName}`;
  const only = changed.length === 1 ? changed[0]!.item : null;
  const on = only ? `“${itemLabel(only)}”` : `${changed.length} items`;
  const stays = cannotBePutBack(field, changed);
  return `${done} on ${on}${stays > 0 ? ` (Undo leaves the ${stays} that had no type)` : ''}`;
}

/** What the bar says of the Items a run could not change. */
export function saysWhatWasNotChanged(refused: readonly Refused[]): string | null {
  if (refused.length === 0) return null;
  const reasons = [...new Set(refused.map(({ why }) => why))].join(' ');
  return `${refused.length} not changed. ${reasons}`;
}
