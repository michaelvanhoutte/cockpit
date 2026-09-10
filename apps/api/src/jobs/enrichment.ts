import { z } from 'zod';
import type { Env } from '../env.js';
import type { Account } from '../accounts/index.js';
import {
  openAccount,
  AccountNotInRegisterError,
  NotFoundInAccountError,
} from '../accounts/index.js';
import { aiFor } from '../ai/index.js';
import type { RoutingCandidate } from '../ai/index.js';

/**
 * Two jobs on the account's own classification: reading a captured note and
 * proposing what to call it, what it said, and which Panel it belongs on
 * ("Clean up a captured note into a clear title and a fuller message", issue
 * 296), and re-reading only that last part for everything still unsettled
 * once a filing elsewhere changes what a proposal should be ("Re-propose the
 * rest of the inbox the moment you file one", issue 300).
 *
 * Plain functions calling `accounts/` and `ai/`; the queue is the adapter
 * that hands each one a message (architecture, "Background jobs"), which is
 * why nothing here names a Cloudflare type and why every branch below is
 * reachable in a test that never opens a queue.
 */

/**
 * What is put on the queue when a note is captured.
 *
 * **An account and an item, and not the note itself.** Reading the note here
 * costs one call to a store that is warm anyway, and buys three things the
 * message could not: an item dismissed and erased in the meantime is found
 * before a model call is paid for, one whose texts have since been edited is
 * skipped for the same reason, and a note's words are not left sitting in a
 * queue as a second copy of something the account already holds.
 *
 * `kind` is what makes this queue able to carry the next job as well - the
 * connector pulls and reconciliation passes that "Background jobs" names - and
 * is what a message from before a deploy is refused by rather than
 * misinterpreted.
 */
export type EnrichmentJob = CleanUpJob | ReproposePanelsJob;

export interface CleanUpJob {
  kind: 'clean-up-a-note';
  accountName: string;
  itemId: string;
}

/**
 * Asks for every unfiled item of one Workspace to have its panel destination
 * re-proposed, the way `CleanUpJob` first proposes one - fired once a filing
 * settles a routing for the first time, against a decision history that now
 * includes it ("Re-propose the rest of the inbox the moment you file one",
 * issue 300).
 *
 * **A Workspace, not an Item.** The one item that just settled is what
 * caused this, but it is not what this job is about - it is already filed,
 * so it answers `unfiledItemsInWorkspace` itself and needs nothing further.
 */
export interface ReproposePanelsJob {
  kind: 're-propose-panels';
  accountName: string;
  workspaceId: string;
}

/**
 * A message is not a value from inside this program: it was written by a
 * previous version of this Worker and has been sitting on a queue, so it is
 * parsed like a request body rather than cast.
 */
export const enrichmentJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clean-up-a-note'),
    accountName: z.string().min(1),
    itemId: z.uuid(),
  }),
  z.object({
    kind: z.literal('re-propose-panels'),
    accountName: z.string().min(1),
    // A plain string, not `z.uuid()`: a Workspace's id is whatever the
    // client that created it generated (`commandEnvelopeSchema.workspaceId`,
    // packages/shared), and this is carried straight from there.
    workspaceId: z.string().min(1),
  }),
]);

/**
 * Asks for a captured note to be cleaned up, without making the capture wait
 * for it or fail with it.
 *
 * **The only thing that enqueues one.** That is what decides what this feature
 * runs on: notes captured from this release onwards and nothing else. No sweep
 * exists and there is no backfill, so a title somebody wrote by hand before
 * this shipped is unreachable rather than merely skipped (issue 296, "What does
 * it run on?").
 *
 * **A queue that will not take the message loses the enrichment, not the
 * note.** Capture is the one thing in this product that may never fail for a
 * reason the person capturing cannot act on - it is what somebody does in a car
 * - and the Item is already written and already carries the mechanical title by
 * the time this runs. So the failure is logged and swallowed.
 */
export async function enqueueCleanUp(env: Env, accountName: string, itemId: string): Promise<void> {
  /**
   * **An environment that cannot read a note queues nothing**, rather than
   * queueing work its consumer will discard a moment later. That is local
   * development without a key, and it is every test in the suite - and the
   * queue round trip per capture is real: it cost the backend tiers a minute
   * and tipped two unrelated bulk cases past their timeouts before this line
   * existed. What says an environment is in that state is `/health`, not a log
   * line on every capture.
   *
   * The job asks the same question again, and that is not redundant: a key can
   * go away between here and there, and the job is entered from a queue rather
   * than only from here.
   */
  if (!env.ANTHROPIC_API_KEY) return;

  const job: EnrichmentJob = { kind: 'clean-up-a-note', accountName, itemId };
  try {
    await env.ENRICHMENT.send(job);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `item ${itemId} was captured but not queued for cleaning up: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * Runs one job.
 *
 * **Every way this can decline is a return, and every way it can fail is a
 * throw**, because the two mean opposite things to the queue: a note nobody can
 * enrich must not be delivered again for ever, and a model that was rate-limited
 * must. So a missing key, a missing item, a note with nothing in it and a
 * proposal that will not validate all end here quietly with the Item keeping the
 * mechanical title capture wrote; only a call that failed is left to throw.
 */
export async function cleanUpACapturedNote(env: Env, job: CleanUpJob): Promise<void> {
  const ai = aiFor(env);
  if (!ai) return say(job.itemId, 'nothing was enriched: this environment has no ANTHROPIC_API_KEY');

  let account;
  try {
    account = await openAccount(env, job.accountName);
  } catch (error) {
    // The account has left the register - somebody's access was taken away
    // while a note of theirs was queued. Nothing will make this job work, so it
    // declines rather than being redelivered until its retries run out.
    if (error instanceof AccountNotInRegisterError) {
      return say(job.itemId, 'nothing was enriched: the account is no longer in the register');
    }
    throw error;
  }

  const item = await account.item(job.itemId);
  // Not an error and not worth retrying: an item can be dismissed and erased
  // between capture and here, and an id that belongs to another account matches
  // no row because every query in the store filters on the account.
  if (!item) return say(job.itemId, 'nothing was enriched: no such item in this account');
  // Nothing to read. Only capture writes this column, and it writes what was
  // typed, so this is an Item that arrived by some other door.
  if (!item.capturedMessage) return say(job.itemId, 'nothing was enriched: the item has no captured note');
  // Somebody edited the title or the description while this was queued, so the
  // two texts are theirs. The store refuses the write for the same reason - this
  // is what stops a model call being paid for to be refused.
  if (item.textsSettledAt !== null) {
    return say(job.itemId, 'nothing was proposed: the texts are already edited');
  }

  // Read fresh, for this call: the Panels this call may propose among are
  // this account's own and change from one note to the next, which is why
  // `cleanUpNote` takes them rather than closing over a fixed list ("Propose
  // where a captured note belongs, without filing it there", issue 298).
  //
  // Falls back to none rather than declining the whole job - see
  // `panelsOrEmpty`'s own comment for why - and the text cleanup below has no
  // such dependency and must not be held hostage to a read the routing half
  // alone needs.
  const panels = await panelsOrEmpty(account, item.workspaceId);

  // The account's decision history for this Workspace, and what else it has
  // captured lately and not yet filed - the two inputs that let a proposal
  // learn from where notes actually get filed ("Learn where notes belong from
  // where you actually file them", issue 299), read together in one round
  // trip since nothing ever needs one without the other. Neither checks the
  // Workspace still exists: an empty answer is already the right one for a
  // Workspace this far gone, exactly as an empty `panels` list is above.
  const { history, recentlyCaptured } = await account.routingContext(item.workspaceId, item.id);

  const read = await ai.cleanUpNote(item.capturedMessage, panels, history, recentlyCaptured);
  if (!('proposal' in read)) return say(job.itemId, `nothing was proposed: ${read.discarded}`);

  try {
    await account.applyChange('propose_item_texts', {
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      // The Workspace the Item is in, which is the envelope's and not a
      // decision: an Item belonging to none is still in the one it was captured
      // from, and the store is what tells every other Workspace it changed.
      workspaceId: item.workspaceId,
      itemId: item.id,
      title: read.proposal.title,
      description: read.proposal.message,
      // Translated onto the wire shape the Item's own form uses, the same way
      // the main proposal's `message` becomes `description` above ("Offer the
      // other readings when a captured note says two things", issue 297).
      readings: read.proposal.readings.map((candidate) => ({
        title: candidate.title,
        description: candidate.message,
        meaning: candidate.meaning,
      })),
    });
    // Which language it answered in, said out loud, because that is the rule
    // this prompt is most likely to break quietly and the only place a
    // deployment can be watched for it (issue 296, "The language rule needs a
    // structural answer").
    say(job.itemId, `proposed in ${read.proposal.language}`);
  } catch (error) {
    // The item went between the read above and this write. The same
    // not-worth-retrying case as above, arriving by the other door.
    if (error instanceof NotFoundInAccountError) {
      return say(job.itemId, 'nothing was written: the item went while the note was being read');
    }
    throw error;
  }

  // A second, independent write, factored out because a settled filing's own
  // re-proposal ("Re-propose the rest of the inbox the moment you file one",
  // issue 300) writes the same thing from a call of its own that never
  // touches the two texts above.
  const routed = await applyProposedPanelIfAny(account, item, read.proposal.panel, item.proposedPanelId);
  if (routed === 'the item went while it was being read') {
    say(job.itemId, `nothing was routed: ${routed}`);
  }
}

/**
 * Every live Panel that takes items, in one Workspace - or none, rather than
 * declining the whole job, where the Workspace itself has gone between
 * whatever read found this Workspace id and this one: a tombstone leaves its
 * Dashboards and Panels untouched, so this is the one place that race is
 * visible at all. An empty list is a safe answer to hand the model: its
 * schema's `panelId` enum then holds only the empty string, so it can
 * propose nothing but "no panel fits" - which is also what
 * `liveDestinationPanel` would answer for any Panel of a Workspace this far
 * gone, were one proposed anyway.
 *
 * Shared by `cleanUpACapturedNote` (moment 2) and `reproposePanels` below,
 * for the same reason `applyProposedPanelIfAny` beside it is: the read and
 * its one race are the same regardless of which call needs the Panels.
 */
async function panelsOrEmpty(
  account: Account,
  workspaceId: string,
): Promise<Awaited<ReturnType<Account['panelsThatTakeItems']>>> {
  try {
    return await account.panelsThatTakeItems(workspaceId);
  } catch (error) {
    if (error instanceof NotFoundInAccountError) return [];
    throw error;
  }
}

/**
 * Writes a proposed Panel onto an Item, withdraws its current one, or does
 * neither - naming no Panel is the common, welcome answer ("Proposing
 * nothing is a real answer and often the right one", issue 298), and where
 * the Item had no proposal already there is simply nothing to send, rather
 * than a value saying so. `command-service.ts` is where this is checked once
 * more, freshly, against the Panel and the Item as they actually stand by the
 * time this write lands - which is what makes this safe to call from a
 * refresh running well after the read that produced `panel`, and not only
 * from the same call that read it.
 *
 * **`currentProposedPanelId` is what tells "nothing new fits" apart from
 * "nothing ever did".** A freshly captured Item has no proposal to lose
 * either way, so moment 2 passing this always answers `null` here is a true
 * no-op, unchanged from before this parameter existed. A settled filing's
 * refresh of the rest of its Workspace's Inbox ("Re-propose the rest of the
 * inbox the moment you file one", issue 300) reads Items that may already
 * carry an earlier proposal, and where its own fresh read concludes nothing
 * fits any more, that proposal is exactly as wrong to leave standing as one
 * naming the wrong Panel would be (`docs/routing-learning.md`, "The rule": a
 * proposed routing may be replaced by the system at any time, without
 * asking) - replaced here with nothing, via `propose_item_panel`'s own
 * `panelId: null` withdrawal, rather than left for someone to notice.
 *
 * Shared by `cleanUpACapturedNote` (moment 2) and `reproposePanels` below
 * (the settle-triggered refresh), because the write and its one race are the
 * same regardless of which call proposed the Panel.
 */
async function applyProposedPanelIfAny(
  account: Account,
  item: { id: string; workspaceId: string },
  panel: RoutingCandidate | null,
  currentProposedPanelId: string | null,
): Promise<'routed' | 'withdrawn' | 'no panel fit' | 'the item went while it was being read'> {
  if (!panel && currentProposedPanelId === null) return 'no panel fit';
  try {
    await account.applyChange('propose_item_panel', {
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: item.workspaceId,
      itemId: item.id,
      panelId: panel?.panelId ?? null,
      reason: panel?.reason ?? '',
    });
    return panel ? 'routed' : 'withdrawn';
  } catch (error) {
    if (error instanceof NotFoundInAccountError) return 'the item went while it was being read';
    throw error;
  }
}

/**
 * Asks for a settled filing to re-propose the panel for the rest of its
 * Workspace's Inbox, without making the filing wait for it ("Re-propose the
 * rest of the inbox the moment you file one", issue 300) - the same shape as
 * `enqueueCleanUp` above, and the same guard: an environment with no key
 * queues nothing its consumer would only discard.
 */
export async function enqueueRepropose(env: Env, accountName: string, workspaceId: string): Promise<void> {
  if (!env.ANTHROPIC_API_KEY) return;

  const job: EnrichmentJob = { kind: 're-propose-panels', accountName, workspaceId };
  try {
    await env.ENRICHMENT.send(job);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `a filing settled but the rest of workspace ${workspaceId} was not queued for a refresh: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * Runs one refresh: every unfiled Item of one Workspace with a captured note
 * gets its panel destination read again, against the history and recent
 * captures as they stand right now - which is what makes this worth firing
 * on every settle rather than only when the Inbox is opened, unbuilt as that
 * still is (`docs/routing-learning.md`, "The decision moments").
 *
 * **Only the destination is re-read.** The two texts were settled on the way
 * in and nothing here calls `propose_item_texts` - the model's own answer
 * still names them, `cleanUpNote` asking for nothing narrower, but only its
 * `panel` is ever written; a second opinion on wording nobody asked for
 * would be the app editing notes at random.
 *
 * **One Item's failure does not cost the rest.** A refresh that fails costs
 * nothing - the Item keeps the proposal it had - so a rate limit or a
 * refusal on Item 3 of 10 is logged and the loop moves on to Item 4, rather
 * than the whole job being retried and Items 1 and 2 classified a second
 * time for nothing new.
 *
 * **Sequential, not parallel.** Nobody is waiting on the job as a whole, but
 * somebody may already be triaging the first card by the time it starts, and
 * a card refreshed while it is still on screen has to land below wherever
 * triage has reached, never above it and never all at once
 * (`docs/routing-learning.md`, "Moment 3 in slow motion" - the proposal for
 * the moment this job fires instead of).
 */
export async function reproposePanels(env: Env, job: ReproposePanelsJob): Promise<void> {
  const ai = aiFor(env);
  if (!ai) return sayForWorkspace(job.workspaceId, 'nothing was refreshed: this environment has no ANTHROPIC_API_KEY');

  let account;
  try {
    account = await openAccount(env, job.accountName);
  } catch (error) {
    if (error instanceof AccountNotInRegisterError) {
      return sayForWorkspace(job.workspaceId, 'nothing was refreshed: the account is no longer in the register');
    }
    throw error;
  }

  const candidates = await account.unfiledItemsInWorkspace(job.workspaceId);
  if (candidates.length === 0) return sayForWorkspace(job.workspaceId, 'nothing was waiting to be refreshed');

  for (const candidate of candidates) {
    try {
      // Panels, history and recent captures are each read fresh, and against
      // the candidate's own Workspace rather than the one this refresh was
      // triggered from - an Item still undecided between Workspaces is read
      // exactly as `cleanUpACapturedNote` reads it, not as if it already
      // belonged where the settle that triggered this happened to be.
      const panels = await panelsOrEmpty(account, candidate.workspaceId);
      const { history, recentlyCaptured } = await account.routingContext(candidate.workspaceId, candidate.id);
      const read = await ai.cleanUpNote(candidate.capturedMessage, panels, history, recentlyCaptured);
      if (!('proposal' in read)) {
        say(candidate.id, `nothing was refreshed: ${read.discarded}`);
        continue;
      }
      const routed = await applyProposedPanelIfAny(
        account,
        candidate,
        read.proposal.panel,
        candidate.proposedPanelId,
      );
      say(candidate.id, routed === 'routed' || routed === 'withdrawn' ? routed : `nothing was refreshed: ${routed}`);
    } catch (error) {
      // Worth trying again another time, but not worth losing the rest of
      // this refresh over: the queue's own retry is for the whole job, and a
      // model that was rate-limited on Item 3 will be rate-limited on Items
      // 4 through N too, redelivered or not.
      console.error(
        JSON.stringify({
          level: 'error',
          message: `item ${candidate.id} was not refreshed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      );
    }
  }
}

/** One line in the logs, saying which item and what happened to it. */
function say(itemId: string, what: string): void {
  console.info(JSON.stringify({ level: 'info', message: `${what} (item ${itemId})` }));
}

/** One line in the logs, saying which workspace's refresh and what happened to it. */
function sayForWorkspace(workspaceId: string, what: string): void {
  console.info(JSON.stringify({ level: 'info', message: `${what} (workspace ${workspaceId})` }));
}
