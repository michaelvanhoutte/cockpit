import type { Env } from '../env.js';
import { openAccount, AccountNotInRegisterError, NotFoundInAccountError } from '../accounts/index.js';
import { GUEST_ACCOUNT_NAME } from '../auth/register.js';
import { noteTypeId, taskTypeId } from '../accounts/changes.js';
import { typeToBringInAs } from '../domain/item-types.js';
import { demoAddress } from '@cockpit/shared';
import type { GuestArrivalJob } from './enrichment.js';

/**
 * What lands in the guest's Inbox after a sign-in ("Drop a mail and a Teams
 * message into the guest's Inbox after each sign-in", issue 775): a Gmail mail
 * about twenty seconds in and a Teams message about ten seconds after it, so a
 * visitor watching the Inbox sees Cockpit take in work as it arrives.
 *
 * **Delayed messages on the enrichment queue**, for the reason a simulated run
 * is (`jobs/simulated-run.ts`): work held open after a response is cut off by
 * a Worker. The consumer captures each as an ordinary Item through
 * `capture_item`, so open tabs hear of it over SSE like any capture.
 *
 * **Each message carries its own ids**, minted at sign-in, so a redelivery is a
 * replay the store ignores rather than a second Item. **Nothing is queued for
 * clean-up**: the title is final, so a guest sign-in costs no model call.
 * **Not capped**: a scripted sign-in loop can fill the shared Inbox until the
 * nightly reset, which is accepted.
 */

/** The Workspace they arrive in: the demo's first, which holds the seeded Gmail and Teams Items. */
const ARRIVES_IN_WORKSPACE = 'guest-ws-personal';

export const GMAIL_ARRIVES_AFTER_SECONDS = 20;
export const TEAMS_ARRIVES_AFTER_SECONDS = 30;

interface Arrival {
  readonly source: 'gmail' | 'teams';
  readonly after: number;
  readonly sender: string;
  readonly title: string;
  readonly message: string;
}

const ARRIVALS: readonly Arrival[] = [
  {
    source: 'gmail',
    after: GMAIL_ARRIVES_AFTER_SECONDS,
    sender: 'Dr. Peeters Dental',
    title: 'Confirm your check-up on Thursday at 09:30',
    message: 'Please confirm your appointment, or pick another time, by replying to this mail.',
  },
  {
    source: 'teams',
    after: TEAMS_ARRIVES_AFTER_SECONDS,
    sender: 'Nadia Peeters',
    title: 'Can you look over the venue shortlist before Friday?',
    message: 'Three options are in the shared folder - tell me which one you would pick.',
  },
];

/**
 * Asks for the two arrivals. A queue that will not take one loses that
 * arrival, which is wrong only for a demo, so it is logged rather than
 * failing the sign-in.
 */
export async function enqueueGuestArrivals(env: Env): Promise<void> {
  for (const arrival of ARRIVALS) {
    const job: GuestArrivalJob = {
      kind: 'guest-arrival',
      accountName: GUEST_ACCOUNT_NAME,
      workspaceId: ARRIVES_IN_WORKSPACE,
      source: arrival.source,
      itemId: crypto.randomUUID(),
      commandId: crypto.randomUUID(),
    };
    try {
      await env.ENRICHMENT.send(job, { delaySeconds: arrival.after });
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          message: `the ${arrival.source} arrival was not queued: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      );
    }
  }
}

/**
 * Captures one arrival as an Item of the Inbox, written the way a seeded Gmail
 * or Teams Item is: its sender, and Cockpit's own page for its source as its
 * link. Everything this declines on is a return, so the queue never redelivers
 * it: an account or Workspace that is gone has nothing to receive it, and the
 * same message twice is a replay the store answers without writing.
 */
export async function captureGuestArrival(env: Env, job: GuestArrivalJob): Promise<void> {
  const arrival = ARRIVALS.find((one) => one.source === job.source);
  if (!arrival) return;
  try {
    const account = await openAccount(env, job.accountName);
    const type = typeToBringInAs(
      await account.itemTypes(),
      taskTypeId(job.accountName),
      noteTypeId(job.accountName),
    );
    if (!type) return;
    const at = new Date().toISOString();
    await account.applyChange('capture_item', {
      commandId: job.commandId,
      issuedAt: at,
      workspaceId: job.workspaceId,
      itemId: job.itemId,
      title: arrival.title,
      message: arrival.message,
      typeId: type.id,
      capturedFrom: {
        source: arrival.source === 'gmail' ? 'mail' : 'teams',
        sourceId: job.itemId,
        sourceLink: demoAddress(arrival.source),
        sender: arrival.sender,
        sourceTimestamp: at,
      },
    });
  } catch (error) {
    if (error instanceof AccountNotInRegisterError || error instanceof NotFoundInAccountError) return;
    throw error;
  }
}
