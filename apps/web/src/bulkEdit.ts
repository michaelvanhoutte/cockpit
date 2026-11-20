import { itemLabel, itemStatus, type Item, type ItemStatus, type Priority, type StatusState } from '@cockpit/shared';
import { CommandRefused } from './api/client';
import type { CommandArgs } from './api/queries';
import { fieldWrites } from './itemFieldCommands';
import { KeptOnTheWhiteboard, cardsTakenOffBy, putCardsBack } from './whiteboardQuestion';

/**
 * Changing one field of everything a selection holds ("Change the priority, due
 * date or status of every selected item from the selection bar", issue 864).
 *
 * **The deciding is here, and pure**, with the sending handed in: which Items
 * need a change, which commands each takes, and what putting each back means are
 * decisions with cases, and a decision kept out of the component is one that can
 * be proved without a rendered bar. The commands are the one-Item field commands
 * the item's form and a row's Status already send (`fieldWrites`), one Item after
 * another - no new command, nothing on the server.
 */

/** The three fields the bar edits; the form's title and description are text. */
export type BulkField = 'priority' | 'dueDate' | 'status';
export type BulkValue = Priority | ItemStatus | string | null;

/** What an Item holds for a field, in the form `fieldWrites` takes it. */
export function valueOf(item: Item, field: BulkField): BulkValue {
  switch (field) {
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
  return { status: itemStatus(item), started: item.startedAt != null, waiting: item.waitingSince != null };
}

/**
 * What every Item shares for a field, or that they differ. A Done Item cannot
 * be picked, so a status is never Done here.
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

export const CHANGED_ELSEWHERE = 'That item changed somewhere else.';

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

/** The Items a choice would change: those not already holding the value. */
export function needingTheChange(items: readonly Item[], field: BulkField, value: BulkValue): Item[] {
  return items.filter((item) => valueOf(item, field) !== value);
}

/**
 * Sets a field on every Item that does not already hold the value, in the order picked.
 *
 * **Every change is handed over before any is awaited**, so the tab's queue
 * (`changeQueue.ts`) draws the whole selection at once and sends them one after
 * another; `onStarted` is told the moment that is done, which is when an Undo
 * can already be offered. What the answers say is gathered afterwards, in order.
 *
 * **A refusal is recorded against its Item and the run goes on**, unlike filing
 * several, which stops at the first: filing builds each order on the one before
 * it, where these Items are independent of each other. What did change and what
 * did not are both answered, so the bar can say how many were not changed and
 * why, and the Undo can cover exactly the ones that were.
 */
export function editSeveral(
  sending: Sending,
  options: {
    items: readonly Item[];
    field: BulkField;
    value: BulkValue;
    /** The open agent run of an Item, which Done ends. */
    runOf: (itemId: string) => string | undefined;
    /** Told which Item (counting from one) of how many is being answered. */
    onProgress: (at: number, of: number) => void;
    /** Told, as soon as every change has been handed over, which Items are changing and what will say how it went. */
    onStarted?: (changing: Changed[], answer: Promise<{ changed: Changed[]; refused: Refused[] }>) => void;
  },
): Promise<{ changed: Changed[]; refused: Refused[] }> {
  const { field, value } = options;
  const runs = needingTheChange(options.items, field, value).map((item) => {
    const writes = fieldWrites(field, sending.envelope(item.id), value, stateOf(item));
    const sends = writes.map((write) => sending.send(write.command));
    const endedRunId = field === 'status' && value === 'done' ? options.runOf(item.id) : undefined;
    const changing: Changed = {
      item,
      before: valueOf(item, field),
      after: writes.at(-1)?.held ?? stateOf(item),
      ...(endedRunId && { endedRunId }),
    };
    return { changing, sends };
  });
  return handedOver(runs, options.onProgress, options.onStarted);
}

/**
 * What every run of Items shares: the changes are all handed over before any is
 * awaited, then answered one Item at a time, and `onStarted` is told the moment
 * the hand-over is done.
 */
function handedOver<T extends { item: Item }>(
  runs: readonly { changing: T; sends: readonly Promise<{ applied: boolean }>[] }[],
  onProgress: (at: number, of: number) => void,
  onStarted?: (changing: T[], answer: Promise<{ changed: T[]; refused: Refused[] }>) => void,
): Promise<{ changed: T[]; refused: Refused[] }> {
  // Awaited one Item at a time below: a refusal met while an earlier Item is
  // still being waited on must not be reported as unhandled meanwhile.
  runs.forEach((run) => run.sends.forEach((send) => send.catch(() => {})));
  const answer = answered(runs, onProgress);
  onStarted?.(
    runs.map((run) => run.changing),
    answer,
  );
  return answer;
}

async function answered<T extends { item: Item }>(
  runs: readonly { changing: T; sends: readonly Promise<{ applied: boolean }>[] }[],
  onProgress: (at: number, of: number) => void,
): Promise<{ changed: T[]; refused: Refused[] }> {
  const changed: T[] = [];
  const refused: Refused[] = [];
  for (const [at, { changing, sends }] of runs.entries()) {
    onProgress(at + 1, runs.length);
    try {
      for (const send of sends) {
        if (!(await send).applied) throw new Error(CHANGED_ELSEWHERE);
      }
      changed.push(changing);
    } catch (error) {
      // Kept on a whiteboard at "Take it off there too?": not done, and nothing to say.
      if (!(error instanceof KeptOnTheWhiteboard)) refused.push({ item: changing.item, why: whyNot(error) });
    }
  }
  return { changed, refused };
}

/**
 * Puts each changed Item back to its own previous value, with the same
 * commands. **Stops at the first refusal and says how far it got**, leaving the
 * rest as they are now, because offering the same Undo again would be guessing a
 * second time.
 */
export async function putBack(sending: Sending, field: BulkField, changed: readonly Changed[]): Promise<void> {
  for (const [at, { item, before, after, endedRunId }] of changed.entries()) {
    try {
      // Inside the try: a status that cannot be put back (`WAIT_NOT_PUT_BACK`) is a refusal like any other.
      const writes = fieldWrites(field, sending.envelope(item.id), before, after).map(({ command }) =>
        endedRunId && command.name === 'set_done' && !command.payload.done
          ? { ...command, payload: { ...command.payload, reopensRunId: endedRunId } }
          : command,
      );
      await sendAll(sending, writes);
    } catch (error) {
      throw new Error(
        `${at} of ${changed.length} put back, the rest still changed. ${whyNot(error)}`,
      );
    }
  }
}

/** The names the bar uses for a field. */
export const BULK_FIELD_NAMES: Record<BulkField, string> = {
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
  return `${done} on ${on}`;
}

/** What the bar says of the Items a run could not change (or `dismissed`, or whatever the run did): how many, and why. */
export function saysWhatWasNot(verb: 'changed' | 'dismissed', refused: readonly Refused[]): string | null {
  if (refused.length === 0) return null;
  const reasons = [...new Set(refused.map(({ why }) => why))].join(' ');
  return `${refused.length} not ${verb}. ${reasons}`;
}

/** One Item the bar dismissed, and the agent run its dismissal ended, which the Undo names so the server reopens exactly that one. */
export interface Dismissed {
  item: Item;
  endedRunId?: string;
  /** The cards of the Items it held that *Take off both* took off the whiteboards with it, for the Undo to put back. */
  cardsTakenOff?: string[];
}

/**
 * Dismisses every Item handed in, one `set_dismissed` each - the command one row's
 * Dismiss sends - in the order given ("Add Dismiss to the selection bar, asking
 * first", issue 1819). Handed over and answered exactly as `editSeveral` does:
 * every change before any is awaited, a refusal recorded against its Item while
 * the run goes on, and `onStarted` told at the moment an Undo can be offered.
 */
export function dismissSeveral(
  sending: Sending,
  options: {
    items: readonly Item[];
    /** The open agent run of an Item, which dismissing it ends. */
    runOf: (itemId: string) => string | undefined;
    onProgress: (at: number, of: number) => void;
    onStarted?: (dismissing: Dismissed[], answer: Promise<{ changed: Dismissed[]; refused: Refused[] }>) => void;
  },
): Promise<{ changed: Dismissed[]; refused: Refused[] }> {
  const runs = options.items.map((item) => {
    const send = sending.send({ name: 'set_dismissed', payload: { ...sending.envelope(item.id)(), dismissed: true } });
    const endedRunId = options.runOf(item.id);
    const changing: Dismissed = { item, ...(endedRunId && { endedRunId }) };
    send.then(
      (answer) => {
        const taken = cardsTakenOffBy(answer);
        if (taken.length > 0) changing.cardsTakenOff = taken;
      },
      () => {},
    );
    return { changing, sends: [send] };
  });
  return handedOver(runs, options.onProgress, options.onStarted);
}

/**
 * Undismisses each Item the run dismissed: the same command with the flag turned
 * round, naming the run it ended. **Stops at the first refusal and says how far it
 * got**, as `putBack` does.
 */
export async function undismissSeveral(sending: Sending, dismissed: readonly Dismissed[]): Promise<void> {
  for (const [at, { item, endedRunId }] of dismissed.entries()) {
    try {
      await sendAll(sending, [
        {
          name: 'set_dismissed',
          payload: { ...sending.envelope(item.id)(), dismissed: false, ...(endedRunId && { reopensRunId: endedRunId }) },
        },
      ]);
    } catch (error) {
      throw new Error(`${at} of ${dismissed.length} put back, the rest still dismissed. ${whyNot(error)}`);
    }
  }
  // Then the cards of the Items they held that *Take off both* took off, behind them.
  const taken = dismissed.flatMap((one) => one.cardsTakenOff ?? []);
  const first = dismissed[0];
  if (taken.length > 0 && first) await putCardsBack(sending.send, sending.envelope(first.item.id)().workspaceId, taken);
}

/** What the offer to undo says happened, worded as one row's Dismiss words it for one Item. */
export function whatWasDismissed(dismissed: readonly Dismissed[]): string {
  const only = dismissed.length === 1 ? dismissed[0]!.item : null;
  return only ? `“${itemLabel(only)}” dismissed` : `${dismissed.length} items dismissed`;
}
