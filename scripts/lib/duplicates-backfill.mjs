//
// Everything `pnpm duplicates:backfill` decides, with the asking injected - the
// same shape as backup.mjs and restore.mjs beside it.
//
// It reads every open Item an account holds that nothing has read yet, and
// works out which of them say the same thing ("Give every item already there a
// vector", issue 409): duplicate flagging otherwise only ever sees notes
// captured after it shipped, and the notes worth catching a duplicate of are
// the ones already sitting in the Inbox.
//
// The three rules that shape what is below:
//
//   - **It only ever adds.** Every call writes what notes mean and which of
//     them repeat each other, and touches the notes themselves nowhere - so a
//     run that stops has done part of the work and destroyed none of it.
//   - **A run across several accounts is not one transaction**, the same as a
//     restore: each account is walked to the end before the next is started,
//     and a failure stops at once and says which accounts went in.
//   - **Re-running is how a stopped run is finished**, and costs nothing for
//     what was already done: an Item with a reading is not a candidate, so the
//     second run over a finished account reads nothing at all.
//
// **Pacing is the operator's, and `--stop-after` is the lever.** A reading is
// one call to Workers AI per Item, and a few thousand Items in one sitting can
// pass a day's free neuron allocation. Nothing here schedules anything: the
// command reports how far it got and stops where it was told, and running it
// again tomorrow picks up exactly where it left off. Left alone it reads
// everything in one go, which is the deliberate choice for an account of a few
// hundred notes - `--stop-after` is for the day that is no longer the size of
// it, and the counts this prints are what says which day that is.
//

import { readAnswer, readEnvironment, readFlags } from './operator.mjs';

/** Where the list of accounts to walk comes from. */
export const ACCOUNTS_PATH = '/v1/operator/duplicates/accounts';

/** What the command was asked to do. */
export function readArguments(argv) {
  const args = readFlags(argv, {
    takes: {
      '--env': 'environment',
      '--user': 'user',
      '--batch': 'batch',
      '--stop-after': 'stopAfter',
    },
  });
  // Required rather than defaulting to local, the same as `pnpm guest:reset`: a
  // guessed environment is found out about in the wrong one.
  if (!args.environment) throw new Error('--env says which environment to read the notes in');
  readEnvironment(args.environment);
  return {
    ...args,
    batch: wholeNumber(args.batch, '--batch'),
    stopAfter: wholeNumber(args.stopAfter, '--stop-after'),
  };
}

/** A count somebody typed, or undefined where they typed none. */
function wholeNumber(given, flag) {
  if (given === undefined) return undefined;
  if (!/^\d+$/.test(given) || Number(given) < 1) {
    throw new Error(`${flag} takes a whole number of items, and ${given} is not one`);
  }
  return Number(given);
}

/**
 * Reads every account named, or the one `only` names, to the end.
 *
 * `ask` makes one request and answers the parsed body or throws the reason it
 * did not; `say` is given a line per account as it finishes, so a long run is
 * watchable rather than silent.
 *
 * **`stopAfter` counts Items read, not calls made**, because what it is pacing
 * is the model: a note with nothing written on it costs no reading and so does
 * not count against it.
 */
export async function backfill({ ask, only, batch, stopAfter, say = () => {} }) {
  const accounts = await accountsToWalk(ask, only);

  const done = [];
  let read = 0;
  for (const account of accounts) {
    const sofar = { account, read: 0, couldNotBeRead: [], finished: false };
    done.push(sofar);
    try {
      let after = null;
      for (;;) {
        // The batch is narrowed as the cap comes into view, so a run stops on
        // the Item it was told to rather than on the end of whichever batch
        // passed the cap.
        const room = stopAfter === undefined ? undefined : stopAfter - read;
        if (room !== undefined && room <= 0) break;
        const answer = await ask(oneBatch(account, after, smaller(batch, room)));
        readBatch(answer, account);
        sofar.read += answer.read.length;
        sofar.couldNotBeRead.push(...answer.couldNotBeRead);
        read += answer.read.length;
        after = answer.lastLooked;
        if (!answer.more) {
          sofar.finished = true;
          break;
        }
      }
    } catch (error) {
      // Stopped at the first failure rather than carried on, and what did go in
      // is named - the same promise `pnpm backup:restore` makes, and the same
      // reason: a run that reports only its last error leaves somebody to work
      // out how far it got.
      throw new Error(`${error.message}\n\nStopped there. ${describeProgress(done)}`);
    }
    say(lineFor(sofar));
  }
  return { accounts: done, read, stoppedEarly: stopAfter !== undefined && read >= stopAfter };
}

/** The accounts this run covers, from the environment rather than from whoever typed the command. */
async function accountsToWalk(ask, only) {
  const answer = await ask(ACCOUNTS_PATH);
  if (!answer || !Array.isArray(answer.accounts)) {
    throw new Error(
      'reading the list of accounts got an answer that is not one - is something in front of this environment?',
    );
  }
  if (!only) return answer.accounts;
  if (!answer.accounts.includes(only)) {
    throw new Error(`no account ${only} in this environment - it holds ${listed(answer.accounts)}`);
  }
  return [only];
}

/** Where one batch of one account's unread notes is asked for. */
export function oneBatch(account, after, batch) {
  const asking = new URLSearchParams();
  if (after) asking.set('after', after);
  if (batch !== undefined) asking.set('batch', String(batch));
  const query = asking.toString();
  return `${ACCOUNTS_PATH}/${encodeURIComponent(account)}${query ? `?${query}` : ''}`;
}

/**
 * That an answer is actually a batch.
 *
 * A 200 is not on its own - an edge or a proxy can answer with JSON of its own
 * - and without this the first thing to notice is a walk that thinks it
 * finished, which is the one failure this command must not report as success.
 */
function readBatch(answer, account) {
  if (
    !answer ||
    !Array.isArray(answer.read) ||
    !Array.isArray(answer.couldNotBeRead) ||
    typeof answer.more !== 'boolean'
  ) {
    throw new Error(
      `reading ${account} got an answer that is not a batch - is something in front of this environment?`,
    );
  }
}

/** The smaller of what was asked for and what is left, where either was given. */
function smaller(batch, room) {
  if (batch === undefined) return room;
  if (room === undefined) return batch;
  return Math.min(batch, room);
}

/** One line per account, saying what it read and what it could not. */
export function lineFor({ account, read, couldNotBeRead, finished }) {
  const nothingIn = couldNotBeRead.length
    ? `, ${couldNotBeRead.length} with nothing written on them (${couldNotBeRead.join(', ')})`
    : '';
  return `  ${account}: ${read} read${nothingIn}${finished ? '' : ' - more to go'}`;
}

/** How far a run that stopped got, for the sentence that reports it. */
export function describeProgress(done) {
  const went = done.filter((one) => one.read > 0 || one.finished);
  if (went.length === 0) return 'Nothing was read.';
  return `Read so far: ${went.map((one) => `${one.account} (${one.read})`).join(', ')}.`;
}

function listed(names) {
  return names.length ? names.join(', ') : 'no accounts at all';
}

/**
 * What one refusal means.
 *
 * The 409 is this command's own: the environment has nothing to read meaning
 * with, which is not something a flag can answer - it is the AI binding, and
 * the fix is to give the environment one or to point the command at an
 * environment that has it.
 */
export function readRefusal(answer) {
  return readAnswer(answer, {
    409: (why) =>
      `refused: ${why}. Nothing was read. It is the Workers AI binding, which is separately ` +
      'configured and separately absent - /health says whether an environment has one.',
  });
}
