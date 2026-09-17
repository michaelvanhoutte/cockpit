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
import {
  asFarAsItReads,
  canReadMeaning,
  embeddingsFor,
  EMBEDDING_MODEL,
} from '../embeddings/index.js';
import { couldStillBeActedOn, whatAnItemSays } from '../domain/duplicates.js';
import type { QueuedRewriteAttempt } from '../domain/rewrite-history.js';

/**
 * Three jobs on the account's own classification: reading a captured note and
 * proposing what to call it, what it said, and which Panel it belongs on
 * ("Clean up a captured note into a clear title and a fuller message", issue
 * 296), re-reading only that last part for everything still unsettled once a
 * filing elsewhere changes what a proposal should be ("Re-propose the rest of
 * the inbox the moment you file one", issue 300), and reading an Item's two
 * texts for what they *mean* so that one saying what another one already said
 * can be flagged ("Flag a captured note that says what another one already
 * said", issue 407).
 *
 * **The third is gated on its own configuration, not on the first two's.** The
 * Claude key and the AI binding are separately set and separately absent, and
 * an environment that cannot clean a note up must still flag duplicates.
 *
 * There were three. The nightly `summarize-workspace` wrote a paragraph
 * nothing read back, and is gone ("Drop the nightly filing summary, keep the
 * sentence you wrote", issue 392) - a message naming it, written before that
 * deploy and still on the queue after it, is refused by the union below
 * rather than misread.
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
export type EnrichmentJob = CleanUpJob | ReproposePanelsJob | ReadWhatItMeansJob | ReproposeTextsJob;

export interface CleanUpJob {
  kind: 'clean-up-a-note';
  accountName: string;
  itemId: string;
  /**
   * The rewrite-history row this attempt was queued as ("See the history of
   * what Cockpit proposed for the Inbox's items", issue 444) - minted by
   * `enqueueCleanUp` before this is ever sent, so a redelivery of this exact
   * message carries the same id and updates that one row rather than adding
   * another.
   *
   * **Optional, for one release.** A message this shape enqueued by the
   * Worker version before this field existed can still be sitting on the
   * queue when the new consumer starts reading it - Cloudflare Queues carry
   * no version pin to the producer, and this deploy has no drain or pause
   * (found in review) - and `enrichmentJobSchema`'s own union refuses,
   * rather than silently misreads, a shape it does not recognise. Required
   * again once a release has passed with nothing this old left to arrive.
   */
  attemptId?: string | undefined;
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
/**
 * Asks for one Item's two texts to be read for what they *mean*, so that an
 * Item saying what another one already said can be flagged ("Flag a captured
 * note that says what another one already said", issue 407).
 *
 * **An Item, and not the texts themselves** - the same shape and the same
 * reason as `CleanUpJob` above: the texts are re-read inside the job, so an
 * Item edited again while this sat on the queue is read as it now stands rather
 * than as it was.
 *
 * **Its own kind rather than a second half of `CleanUpJob`.** The two are
 * gated on different configuration and fired at different moments: cleaning up
 * happens once, on capture, and only where there is a Claude key; reading for
 * meaning happens again every time the two texts change, and only where there
 * is something to read meaning with.
 */
export interface ReadWhatItMeansJob {
  kind: 'read-what-a-note-means';
  accountName: string;
  itemId: string;
}

/**
 * Asks for every Item in the account still unsettled to have its title and
 * description re-proposed, the way `CleanUpJob` first proposes them - fired
 * once a correction is recorded, against corrections that now include it
 * ("Re-read the rest of the inbox the moment you fix a title", issue 399).
 *
 * **The whole account, not one Workspace**, unlike `ReproposePanelsJob`
 * beside it: how this person writes is a property of the account
 * (`docs/text-learning.md`, "Scope: per account"), not of the Workspace the
 * correcting Item happened to be in.
 *
 * **The account, not the Item that was corrected.** The one Item that just
 * settled is what caused this, but it is not what this job is about - it is
 * already settled, so it answers `itemsWithUnsettledTexts` itself and needs
 * nothing further.
 */
export interface ReproposeTextsJob {
  kind: 're-propose-texts';
  accountName: string;
}

export const enrichmentJobSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('clean-up-a-note'),
    accountName: z.string().min(1),
    itemId: z.uuid(),
    attemptId: z.uuid().optional(),
  }),
  z.object({
    kind: z.literal('read-what-a-note-means'),
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
  z.object({
    kind: z.literal('re-propose-texts'),
    accountName: z.string().min(1),
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
/**
 * Writes a rewrite-history row, never letting a failure to write it change
 * what the caller itself reports - the record is a courtesy kept beside the
 * real work, and a store that could not take it must not turn an enrichment
 * that actually succeeded into one the queue redelivers for nothing new, nor
 * one that was already declined into a throw the queue treats as worth
 * retrying.
 */
async function recordHistory(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `a rewrite-history row was not written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

export async function enqueueCleanUp(env: Env, accountName: string, itemId: string): Promise<void> {
  /**
   * **Read before anything here awaits, not after.** An async function's own
   * body runs synchronously up to its first `await`, so this is read at
   * exactly the moment capture calls this - the same moment the original,
   * single-line guard read it. Reading it any later - after opening the
   * account below, say - would decide "queue nothing" or "queue for real"
   * against whatever the environment happens to say by *then*, which in a
   * deployed Worker never moves but in this very suite does: several cases
   * flip this key a line after capturing, on the assumption that a capture's
   * own enrichment has already decided its fate.
   *
   * **An environment that cannot read a note queues nothing**, rather than
   * queueing work its consumer will discard a moment later. That is local
   * development without a key, and it is every test in the suite - and the
   * queue round trip per capture is real: it cost the backend tiers a minute
   * and tipped two unrelated bulk cases past their timeouts before this line
   * existed. What says an environment is in that state is `/health`, not a log
   * line on every capture.
   */
  const hasKey = Boolean(env.ANTHROPIC_API_KEY);

  // Opened regardless of whether a key is configured - unlike the rest of
  // this function before this line existed. What a captured note's cleanup
  // did is now a durable row from the very first capture ("See the history
  // of what Cockpit proposed for the Inbox's items", issue 444), and an
  // environment with no key still owes that row a reason, not silence.
  //
  // **Both reads share one try, and any failure here is logged and
  // swallowed** - the same contract the lone `env.ENRICHMENT.send` below
  // already keeps, extended to cover what this function now does before it
  // (found in review). This runs from `waitUntil`, after the response has
  // already gone, so nothing else stands between a transient failure here
  // and a note that never gets cleaned up: capture may never fail for a
  // reason the person capturing cannot act on, and that has to hold for a
  // store hiccup opening the account or reading the item just as much as it
  // already does for a hiccup putting the job on the queue.
  let account;
  let item;
  try {
    account = await openAccount(env, accountName);
    item = await account.item(itemId);
  } catch (error) {
    if (error instanceof AccountNotInRegisterError) return;
    console.error(
      JSON.stringify({
        level: 'error',
        message: `item ${itemId} was captured but not queued for cleaning up: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
    return;
  }
  // Dismissed and erased already, or captured by some other door that never
  // reaches this queue - nothing to show a history of.
  if (!item) return;

  const attemptId = crypto.randomUUID();
  const attempt: QueuedRewriteAttempt = {
    id: attemptId,
    tenantId: accountName,
    workspaceId: item.workspaceId,
    itemId,
    titleBefore: item.title,
    descriptionBefore: item.description,
    attemptedAt: new Date().toISOString(),
  };
  await recordHistory(() => account.queueRewriteAttempt(attempt));

  /**
   * **Settled here, straight to left-as-is, rather than queued Pending.**
   * Nothing downstream will ever pick this attempt up, so a row left at
   * Pending would sit there for ever, unlike the true race `cleanUpACapturedNote`
   * itself still checks for (a key removed between here and there).
   */
  if (!hasKey) {
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: 'left-as-is',
        message: 'nothing was enriched: this environment has no ANTHROPIC_API_KEY',
      }),
    );
    return;
  }

  const job: EnrichmentJob = { kind: 'clean-up-a-note', accountName, itemId, attemptId };
  try {
    await env.ENRICHMENT.send(job);
  } catch (error) {
    // Nothing will ever settle this attempt otherwise - the row just queued
    // above would sit at Pending for ever, indistinguishable from one still
    // genuinely in flight.
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
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
  // A fresh id stands in for a message enqueued before `attemptId` existed
  // (found in review, on the same deploy-skew window `enrichmentJobSchema`'s
  // own `.optional()` now allows through) - no queued row exists to update
  // under it, so every `recordRewriteOutcome` call below is a harmless no-op
  // for exactly this one case, and the enrichment itself proceeds exactly as
  // it always has.
  const attemptId = job.attemptId ?? crypto.randomUUID();

  let account;
  try {
    account = await openAccount(env, job.accountName);
  } catch (error) {
    // The account has left the register - somebody's access was taken away
    // while a note of theirs was queued. Nothing will make this job work, so it
    // declines rather than being redelivered until its retries run out.
    //
    // Nothing is recorded onto `attemptId` here: the row it names lives in
    // the very account this could not open, so there is nowhere to write the
    // outcome to. The row is left at Pending - an administrative rarity, and
    // no rarer than the account being gone leaves every other read of it.
    if (error instanceof AccountNotInRegisterError) {
      return say(job.itemId, 'nothing was enriched: the account is no longer in the register');
    }
    throw error;
  }

  const ai = aiFor(env);
  if (!ai) {
    // The race `enqueueCleanUp`'s own guard cannot close: a key can go away
    // between there and here, and the job is entered from a queue rather than
    // only from there.
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: 'left-as-is',
        message: 'nothing was enriched: this environment has no ANTHROPIC_API_KEY',
      }),
    );
    return say(job.itemId, 'nothing was enriched: this environment has no ANTHROPIC_API_KEY');
  }

  const item = await account.item(job.itemId);
  // Not an error and not worth retrying: an item can be dismissed and erased
  // between capture and here, and an id that belongs to another account matches
  // no row because every query in the store filters on the account. Nothing is
  // recorded either, for the same reason the register check above records
  // nothing: there is no item left to describe a before/after against.
  if (!item) return say(job.itemId, 'nothing was enriched: no such item in this account');
  // Nothing to read. Only capture writes this column, and it writes what was
  // typed, so this is an Item that arrived by some other door.
  if (!item.capturedMessage) {
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: 'left-as-is',
        message: 'nothing was enriched: the item has no captured note',
      }),
    );
    return say(job.itemId, 'nothing was enriched: the item has no captured note');
  }
  // Somebody edited the title or the description while this was queued, so the
  // two texts are theirs. The store refuses the write for the same reason - this
  // is what stops a model call being paid for to be refused.
  if (item.textsSettledAt !== null) {
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: 'left-as-is',
        message: 'nothing was proposed: the texts are already edited',
      }),
    );
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

  // This Workspace's decision history, capped and filtered to Panels that
  // still exist, and what else it has captured lately and not yet filed -
  // the two inputs that let a proposal learn from where notes actually get
  // filed ("Learn where notes belong from where you actually file them",
  // issue 299; "Cap the routing prompt to the last 50 decisions on panels
  // that still exist, and drop the correction override", issue 450), read
  // together in one round trip since nothing ever needs one without the
  // other. Neither checks the Workspace still exists: an empty answer is
  // already the right one for a Workspace this far gone, exactly as an empty
  // `panels` list is above.
  const { history, recentlyCaptured } = await account.routingContext(item.workspaceId, item.id);
  // Per account, not per Workspace - how this person writes is not a
  // property of which Workspace a note landed in ("Learn how you write from
  // the titles you correct", issue 394; `docs/text-learning.md`, "Scope: per
  // account").
  const { promptCorrections, promptStood } = await account.textLearningContext();

  let read;
  try {
    read = await ai.cleanUpNote(
      item.capturedMessage,
      panels,
      history,
      recentlyCaptured,
      promptCorrections,
      promptStood,
    );
  } catch (error) {
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
  if (!('proposal' in read)) {
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: 'left-as-is',
        message: `nothing was proposed: ${read.discarded}`,
      }),
    );
    return say(job.itemId, `nothing was proposed: ${read.discarded}`);
  }

  try {
    const written = await account.applyChange('propose_item_texts', {
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
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: written.applied ? 'rewritten' : 'left-as-is',
        titleAfter: written.applied ? read.proposal.title : null,
        descriptionAfter: written.applied ? read.proposal.message : null,
        proposedPanelId: written.applied ? (read.proposal.panel?.panelId ?? null) : null,
        proposedPanelReason: written.applied ? (read.proposal.panel?.reason ?? null) : null,
        message: written.applied
          ? `proposed in ${read.proposal.language}`
          : 'nothing was written: the texts are already edited',
      }),
    );
    // Which language it answered in, said out loud, because that is the rule
    // this prompt is most likely to break quietly and the only place a
    // deployment can be watched for it (issue 296, "The language rule needs a
    // structural answer").
    say(job.itemId, `proposed in ${read.proposal.language}`);
    // The two texts have just been replaced, so whatever was worked out about
    // what this Item means is about words nobody can see any more ("Flag a
    // captured note that says what another one already said", issue 407). The
    // same re-read an edit fires, from the other of the two things that rewrite
    // an Item's texts - and only where the write actually landed, so a
    // redelivered job whose proposal the store refused costs no second reading.
    if (written.applied) await enqueueReadingItsMeaning(env, job.accountName, job.itemId);
  } catch (error) {
    // The item went between the read above and this write. The same
    // not-worth-retrying case as above, arriving by the other door.
    if (error instanceof NotFoundInAccountError) {
      await recordHistory(() =>
        account.recordRewriteOutcome(attemptId, {
          status: 'left-as-is',
          message: 'nothing was written: the item went while the note was being read',
        }),
      );
      return say(job.itemId, 'nothing was written: the item went while the note was being read');
    }
    await recordHistory(() =>
      account.recordRewriteOutcome(attemptId, {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
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
 * **Sequential, not parallel.** Nobody is waiting on the job as a whole. What
 * this actually buys is an ordering guarantee, not a rendering one: each
 * candidate is classified against whatever the previous one just wrote,
 * never against a state two writes are still in flight to produce. Rendering
 * is a separate matter the client's own 3-second poll already coarsens on
 * its own (`collectInvalidations`, `apps/api/src/accounts/events.ts`
 * collapses several changes to one Workspace into the latest), and a chip
 * only ever changing below wherever triage has reached is
 * `docs/routing-learning.md`, "Moment 3 in slow motion"'s own proposal for
 * the inbox-open trigger this job fires instead of - unimplemented
 * client-side, not a property this job's own ordering provides.
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

  // Read once for the whole refresh, not per candidate: per account rather
  // than per Workspace, so it does not vary across the candidates below the
  // way `panels`, `history` and `recentlyCaptured` each do ("Learn how you
  // write from the titles you correct", issue 394; `docs/text-learning.md`,
  // "Scope: per account").
  const { promptCorrections, promptStood } = await account.textLearningContext();

  for (const candidate of candidates) {
    try {
      // Panels, history and recent captures are each read fresh, and against
      // the candidate's own Workspace rather than the one this refresh was
      // triggered from - an Item still undecided between Workspaces is read
      // exactly as `cleanUpACapturedNote` reads it, not as if it already
      // belonged where the settle that triggered this happened to be.
      const panels = await panelsOrEmpty(account, candidate.workspaceId);
      const { history, recentlyCaptured } = await account.routingContext(
        candidate.workspaceId,
        candidate.id,
      );
      const read = await ai.cleanUpNote(
        candidate.capturedMessage,
        panels,
        history,
        recentlyCaptured,
        promptCorrections,
        promptStood,
      );
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

/**
 * Asks for a correction to have every still-unsettled Item in the account
 * re-proposed, without making the edit that caused it wait for it ("Re-read
 * the rest of the inbox the moment you fix a title", issue 399) - the same
 * shape as `enqueueRepropose` above, and the same guard: an environment with
 * no key queues nothing its consumer would only discard.
 */
export async function enqueueReproposeTexts(env: Env, accountName: string): Promise<void> {
  if (!env.ANTHROPIC_API_KEY) return;

  const job: EnrichmentJob = { kind: 're-propose-texts', accountName };
  try {
    await env.ENRICHMENT.send(job);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `a correction was recorded but account ${accountName} was not queued for a re-read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * Runs one re-read: every Item in the account with a captured note whose
 * texts nobody has settled gets its title and description proposed again,
 * against the corrections as they stand right now - which is what makes this
 * worth firing on every correction rather than only when the Inbox is
 * opened.
 *
 * **Only the two texts are written.** The model's own answer still names a
 * Panel, `cleanUpNote` asking for nothing narrower, but only `title` and
 * `description` are ever sent on here - a second opinion on routing nobody
 * asked for would be `reproposePanels`'s own job, fired from a settled filing
 * rather than from a correction.
 *
 * **Goes through `propose_item_texts`, never around it.** The same guard
 * `cleanUpACapturedNote` writes through - `applyProposedTexts` refuses any
 * Item whose `texts_settled_at` is set - is what stops this from overwriting
 * an edit that landed after `itemsWithUnsettledTexts` was read: the query and
 * this write are not atomic with each other, and a candidate settled in
 * between is simply refused rather than clobbered.
 *
 * **One Item's failure does not cost the rest**, and this runs sequentially
 * rather than in parallel, for the same two reasons `reproposePanels` beside
 * it gives.
 */
export async function reproposeTexts(env: Env, job: ReproposeTextsJob): Promise<void> {
  const ai = aiFor(env);
  if (!ai) return sayForAccount(job.accountName, 'nothing was re-read: this environment has no ANTHROPIC_API_KEY');

  let account;
  try {
    account = await openAccount(env, job.accountName);
  } catch (error) {
    if (error instanceof AccountNotInRegisterError) {
      return sayForAccount(job.accountName, 'nothing was re-read: the account is no longer in the register');
    }
    throw error;
  }

  const candidates = await account.itemsWithUnsettledTexts();
  if (candidates.length === 0) return sayForAccount(job.accountName, 'nothing was waiting to be re-read');

  // Read once for the whole re-read, the same as `reproposePanels`: per
  // account rather than per candidate, since it does not vary across them.
  const { promptCorrections, promptStood } = await account.textLearningContext();

  for (const candidate of candidates) {
    // Queued the moment this loop reaches it, rather than at `enqueueReproposeTexts`
    // above: which items this fans out to is not known until `itemsWithUnsettledTexts`
    // has actually run. A fresh id every time, unlike `cleanUpACapturedNote`'s
    // own `job.attemptId` - this whole job is never seen to throw past this
    // point (every failure below is caught in this same loop and logged rather
    // than rethrown), so there is no redelivery of it to reconcile against.
    const attemptId = crypto.randomUUID();
    try {
      await recordHistory(() =>
        account.queueRewriteAttempt({
          id: attemptId,
          tenantId: job.accountName,
          workspaceId: candidate.workspaceId,
          itemId: candidate.id,
          titleBefore: candidate.title,
          descriptionBefore: candidate.description,
          attemptedAt: new Date().toISOString(),
        }),
      );

      const panels = await panelsOrEmpty(account, candidate.workspaceId);
      const { history, recentlyCaptured } = await account.routingContext(
        candidate.workspaceId,
        candidate.id,
      );
      const read = await ai.cleanUpNote(
        candidate.capturedMessage,
        panels,
        history,
        recentlyCaptured,
        promptCorrections,
        promptStood,
      );
      if (!('proposal' in read)) {
        await recordHistory(() =>
          account.recordRewriteOutcome(attemptId, {
            status: 'left-as-is',
            message: `nothing was re-read: ${read.discarded}`,
          }),
        );
        say(candidate.id, `nothing was re-read: ${read.discarded}`);
        continue;
      }
      let written;
      try {
        written = await account.applyChange('propose_item_texts', {
          commandId: crypto.randomUUID(),
          issuedAt: new Date().toISOString(),
          workspaceId: candidate.workspaceId,
          itemId: candidate.id,
          title: read.proposal.title,
          description: read.proposal.message,
          readings: read.proposal.readings.map((reading) => ({
            title: reading.title,
            description: reading.message,
            meaning: reading.meaning,
          })),
        });
      } catch (error) {
        // The candidate went between the read above and this write - the
        // same not-worth-retrying race `cleanUpACapturedNote` names for the
        // same write, arriving by the same door.
        if (error instanceof NotFoundInAccountError) {
          await recordHistory(() =>
            account.recordRewriteOutcome(attemptId, {
              status: 'left-as-is',
              message: 'nothing was written: the item went while it was being re-read',
            }),
          );
          say(candidate.id, 'nothing was written: the item went while it was being re-read');
          continue;
        }
        throw error;
      }
      await recordHistory(() =>
        account.recordRewriteOutcome(attemptId, {
          status: written.applied ? 'rewritten' : 'left-as-is',
          titleAfter: written.applied ? read.proposal.title : null,
          descriptionAfter: written.applied ? read.proposal.message : null,
          proposedPanelId: written.applied ? (read.proposal.panel?.panelId ?? null) : null,
          proposedPanelReason: written.applied ? (read.proposal.panel?.reason ?? null) : null,
          message: written.applied
            ? `re-proposed in ${read.proposal.language}`
            : 'nothing was written: the texts are already edited',
        }),
      );
      say(
        candidate.id,
        written.applied ? `re-proposed in ${read.proposal.language}` : 'nothing was written: the texts are already edited',
      );
      // The two texts have just been replaced, so whatever was worked out
      // about what this Item means is about words nobody can see any more
      // ("Flag a captured note that says what another one already said",
      // issue 407) - the same re-read `cleanUpACapturedNote` fires from the
      // other door that rewrites an Item's texts, and only where the write
      // actually landed, for the same reason.
      if (written.applied) await enqueueReadingItsMeaning(env, job.accountName, candidate.id);
    } catch (error) {
      // Worth trying again another time, but not worth losing the rest of
      // this re-read over - the same reasoning `reproposePanels` gives.
      await recordHistory(() =>
        account.recordRewriteOutcome(attemptId, {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      console.error(
        JSON.stringify({
          level: 'error',
          message: `item ${candidate.id} was not re-read: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      );
    }
  }
}

/**
 * Asks for an Item's two texts to be read for what they mean, without making
 * whoever wrote them wait for it ("Flag a captured note that says what another
 * one already said", issue 407).
 *
 * **Gated on being able to read meaning at all, and on nothing else.**
 * `enqueueCleanUp` above returns early without a Claude key; an environment
 * that cannot clean a note up must still flag duplicates, so this asks
 * `canReadMeaning` instead - which is the AI binding, separately configured
 * and separately absent.
 *
 * **A queue that will not take the message loses the flagging, not the note**,
 * exactly as above: capture may never fail for a reason the person capturing
 * cannot act on, and an edit that saved must not report a failure because a
 * follow-up could not be queued.
 */
export async function enqueueReadingItsMeaning(
  env: Env,
  accountName: string,
  itemId: string,
): Promise<void> {
  if (!canReadMeaning(env)) return;

  const job: EnrichmentJob = { kind: 'read-what-a-note-means', accountName, itemId };
  try {
    await env.ENRICHMENT.send(job);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        message: `item ${itemId} was not queued to be read for what it means: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
    );
  }
}

/**
 * Reads one Item's two texts for what they mean, and has the account work out
 * which of its other Items say the same thing ("Flag a captured note that says
 * what another one already said", issue 407).
 *
 * **A decision is a return and a failure is a throw**, the same split
 * `cleanUpACapturedNote` above makes and for the same reason: an Item nobody
 * can read must not be delivered for ever, and a model call that failed must
 * be. So an environment with nothing to read meaning with, an Item that has
 * gone, one finished with or dismissed since it was queued, an account no
 * longer in the register and a note with nothing in it all end here quietly;
 * only the call itself is left to throw.
 */
export async function readWhatANoteMeans(env: Env, job: ReadWhatItMeansJob): Promise<void> {
  const embeddings = embeddingsFor(env);
  if (!embeddings) {
    return say(job.itemId, 'nothing was read: this environment cannot read what a note means');
  }

  let account;
  try {
    account = await openAccount(env, job.accountName);
  } catch (error) {
    if (error instanceof AccountNotInRegisterError) {
      return say(job.itemId, 'nothing was read: the account is no longer in the register');
    }
    throw error;
  }

  // Read fresh rather than carried on the message, so an Item edited again
  // while this waited is read as it now stands - and one dealt with in the
  // meantime costs no call at all.
  const item = await account.item(job.itemId);
  if (!item) return say(job.itemId, 'nothing was read: no such item in this account');

  const said = whatAnItemSays(item);
  // An Item whose Title and Description are empty or only whitespace has
  // nothing to mean. Asking anyway spends a call to be told so, and would pair
  // every such Item with every other - so nothing is read, and whatever it
  // meant while it still said something is forgotten along with the marks built
  // on it, rather than left standing over words nobody can see any more. This
  // runs before the dismissed/finished check below: a note emptied and then
  // dismissed or completed before this job ran must still lose its stale mark.
  if (!said) {
    await account.forgetWhatAnItemMeans(job.itemId);
    return say(job.itemId, 'nothing was read: the item has nothing written on it');
  }
  // A note is dismissed rather than erased, so it is still here to be read -
  // and reading it would spend a call on a note nothing can draw a mark on
  // (`listDuplicatesInWorkspace`, accounts/repo.ts, leaves it out either way).
  // One finished with is the same case by the same rule.
  if (!couldStillBeActedOn(item)) {
    return say(job.itemId, 'nothing was read: the item is finished with or dismissed');
  }

  const reading = await embeddings.readMeaning(asFarAsItReads(said));
  const remembered = await account.rememberWhatAnItemMeans(job.itemId, EMBEDDING_MODEL, reading);
  say(
    job.itemId,
    remembered === 'remembered'
      ? 'read, and compared against the rest of the account'
      : 'nothing was written: the item went while it was being read',
  );
}

/** One line in the logs, saying what happened and to which item/workspace/account. */
function sayAbout(label: string, id: string, what: string): void {
  console.info(JSON.stringify({ level: 'info', message: `${what} (${label} ${id})` }));
}

/** One line in the logs, saying which item and what happened to it. */
function say(itemId: string, what: string): void {
  sayAbout('item', itemId, what);
}

/** One line in the logs, saying which workspace's refresh and what happened to it. */
function sayForWorkspace(workspaceId: string, what: string): void {
  sayAbout('workspace', workspaceId, what);
}

/** One line in the logs, saying which account's re-read and what happened to it. */
function sayForAccount(accountName: string, what: string): void {
  sayAbout('account', accountName, what);
}
