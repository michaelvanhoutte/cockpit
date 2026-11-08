import { draftMadeSchema } from '@cockpit/shared/draft';
import { api, refusal } from './client';

/**
 * The request behind *Email…* and *Reply…* ("Email… makes a Gmail draft the
 * Item then follows", issue 1708), apart from `client.ts` so it is fetched with
 * the click's own chunk (`emailDraftClick.ts`) rather than in the initial bundle.
 */

/** Why a draft was not made, with the status it was answered with: below 500, or the source's 502, the Item has its status back. */
export class DraftRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DraftRefused';
  }
}

/**
 * The draft made in the mailbox named, and where it opens. Refused with the
 * reason the server gives - the source's own where it would not make the
 * draft - which the row says beside the Item put back.
 */
export async function makeADraft(
  workspaceId: string,
  itemId: string,
  ask: { clickId: string; sourceAccountId: string },
): Promise<string> {
  const res = await api.v1.workspaces[':workspaceId'].items[':itemId'].draft.$post({ param: { workspaceId, itemId }, json: ask });
  if (res.ok) return draftMadeSchema.parse(await res.json()).link;
  if (res.status === 401) throw refusal('making the draft', res.status);
  const said = (await res.json().catch(() => null)) as { error?: unknown } | null;
  throw new DraftRefused(typeof said?.error === 'string' ? said.error : `Couldn't make the draft (${res.status})`, res.status);
}
