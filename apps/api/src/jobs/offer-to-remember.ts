import { editedTheProposal, type RememberOffer } from '@cockpit/shared';
import type { Env } from '../env.js';
import { openAccount } from '../accounts/index.js';
import { GUEST_ACCOUNT_NAME } from '../accounts/new-user.js';
import { sourceNames } from '../connectors/registry.js';
import { aiFor, type SentenceOfferRead } from '../ai/index.js';
import { readSentenceOffer } from '../ai/sentence-offers.js';

/**
 * How long the offer is waited for. The link has opened already, so the person
 * is in Claude's window by then: an offer that comes later than this is one
 * nobody is there to take, and a call that never answers must not hold the
 * request open.
 */
export const OFFER_WAITED_FOR_MS = 20_000;

/**
 * The sentence worth remembering from an edit made before Open, or null
 * ("Remember an edit as a sentence you confirm", issue 1163).
 *
 * **Null for every way there is no offer, and never a failure**: the send is
 * already kept, and the person opened Claude before any of this, so a model
 * that fails, times out or declines, a send that was not an edit, an
 * environment with no key and the guest all answer the same way, with nothing
 * kept and nothing lost. **No call is made for a send whose prompt, folder and
 * destination are what was proposed.**
 *
 * Read from the send's own record rather than from what the browser says, so
 * the words asked about are the ones kept for the next proposal.
 */
export async function offerToRemember(env: Env, accountName: string, runId: string): Promise<RememberOffer | null> {
  // The stand-in calls no model, so nobody's key is spent and the guest may have it.
  const standIn = env.REMEMBER_OFFER_STAND_IN === 'true';
  if (accountName === GUEST_ACCOUNT_NAME && !standIn) return null;
  const ai = standIn ? STAND_IN : aiFor(env);
  if (!ai) return null;

  try {
    const account = await openAccount(env, accountName);
    const found = await account.sendToOfferOn(runId);
    if (!found || !editedTheProposal(found.send.proposed, found.send.sent)) return null;

    const item = await account.item(found.send.itemId);
    const read = await withinTime(
      ai.offerSentence(
        {
          title: found.send.itemTitle,
          description: found.send.itemDescription,
          source: found.sourceKind === 'internal' ? null : (sourceNames(env)[found.sourceKind] ?? found.sourceKind),
          sender: item?.sender ?? null,
          workspaces: found.workspaces.map((one) => one.name),
          proposed: found.send.proposed,
          sent: found.send.sent,
        },
        found.workspaces,
        { accountName, itemId: found.send.itemId, triggeredBy: 'edit-sent-to-claude' },
      ),
      OFFER_WAITED_FOR_MS,
    );
    if (read === null) return null;
    if (!('offer' in read)) {
      console.info(JSON.stringify({ level: 'info', message: `no sentence was offered for send ${runId}: ${read.none}` }));
      return null;
    }
    return { ...read.offer, sourceKind: found.sourceKind };
  } catch (error) {
    console.warn(`no sentence was offered for send ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * What the browser tier's stack offers for any edit (`REMEMBER_OFFER_STAND_IN`):
 * the same sentence every time, read through the reader a model's answer goes
 * through, so the window and the route are driven for real.
 */
const STAND_IN: Pick<NonNullable<ReturnType<typeof aiFor>>, 'offerSentence'> = {
  offerSentence: async (_edit, workspaces): Promise<SentenceOfferRead> =>
    readSentenceOffer(
      JSON.stringify({ sentence: 'Replies: Dutch, short, signed Michael.', action: 'reply to a mail', workspace: '' }),
      workspaces,
    ),
};

/** The promise's value, or null once `ms` has passed. */
async function withinTime<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}
