import type { ConnectorHost, MirroredOpenStates, OpenStateWanted } from '@cockpit/connector-sdk';
import { Changed, NotAnswering, OutOfCalls, Refused, mailboxOf, type Mailbox, type OutlookConnectorConfig } from './graph.js';
import { categoriesIn, categoryChange, flagChange, markOf, type Mark } from './messages.js';

/**
 * Puts the followed mark back on, or takes it off, each message whose Item a
 * person opened or closed in Cockpit - that one field, and nothing else of the
 * message or the mailbox. The host calls this before the run lists, so the
 * listing agrees with what was pushed.
 *
 * - **The flag is set on its own**, to `complete` or `flagged`: setting it to
 *   what it already is changes nothing.
 * - **The category list is read, and written back conditionally on the version
 *   read**, so a category the person changes meanwhile makes the write refused
 *   rather than lost; it is read again and retried, up to `CATEGORY_ATTEMPTS`,
 *   then handed back next run. A list that already says what is wanted is not
 *   written at all.
 *
 * **Confirmed only once Graph has answered**, so a run that stops between the
 * write and the host's record writes it again, harmlessly. A message that is
 * gone counts as confirmed. Microsoft holding the mailbox back (a `429`, a
 * `5xx`) leaves the rest waiting, and a write meeting a save of the message
 * (a `409`) leaves that one waiting; any other refusal is given up on, so one
 * message cannot hold up the rest. Every call is spent from the run's budget,
 * shared with the listing that follows.
 */

/** How many times a category write refused for a changed message is read and tried again in one run. */
export const CATEGORY_ATTEMPTS = 3;

export async function mirrorOpenStates(
  host: ConnectorHost,
  config: OutlookConnectorConfig,
  wanted: OpenStateWanted[],
): Promise<MirroredOpenStates> {
  const mailbox = await mailboxOf(host, config);
  const mark = markOf(host.choice);
  const confirmed: string[] = [];
  const gaveUp: string[] = [];
  try {
    for (const one of wanted) {
      try {
        if (await pushed(mailbox, mark, one)) confirmed.push(one.sourceId);
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        host.log('warn', 'Microsoft refused to change the mark on a message, which is no longer asked of it', { status: error.status });
        gaveUp.push(one.sourceId);
      }
    }
  } catch (error) {
    // Out of calls, or Microsoft not answering this time: what was done
    // stands, and the rest is handed back next run.
    if (error instanceof NotAnswering) {
      host.log('warn', 'Outlook could not be told of every change this time', { cause: error.message });
    } else if (!(error instanceof OutOfCalls)) throw error;
  }
  return { confirmed, gaveUp };
}

/** Whether the message now holds what is wanted: false for a write that met a changed message (every attempt, for a category), or a category write that could not be made conditional. */
async function pushed(mailbox: Mailbox, mark: Mark, one: OpenStateWanted): Promise<boolean> {
  const path = `messages/${encodeURIComponent(one.sourceId)}`;
  // A message gone (null) has nothing left to mark.
  if (mark === 'flag') {
    try {
      await mailbox.patch(path, flagChange(one.open));
      return true;
    } catch (error) {
      // A conflict with a save made at the same moment is handed back, never given up.
      if (error instanceof Changed) return false;
      throw error;
    }
  }
  for (let attempt = 0; attempt < CATEGORY_ATTEMPTS; attempt++) {
    const answer = await mailbox.get(`${path}?$select=categories`);
    if (answer === null) return true;
    const read = categoriesIn(answer);
    // An answer naming no list, or no version to write against, is handed back:
    // a write without the version read could take away a category the person
    // just added.
    if (!read || read.version === null) return false;
    const categories = categoryChange(read.categories, one.open);
    if (categories === null) return true;
    try {
      await mailbox.patch(path, { categories }, { ifMatch: read.version });
      return true;
    } catch (error) {
      if (!(error instanceof Changed)) throw error;
    }
  }
  return false;
}
