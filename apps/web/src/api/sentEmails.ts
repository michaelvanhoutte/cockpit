import {
  followSentAnswerSchema,
  sentEmailsAvailableSchema,
  sentEmailsSchema,
  type FollowSentAnswer,
  type FollowSentAsked,
  type SentEmails,
} from '@cockpit/shared/sent-emails';
import { api, refusal } from './client';

/**
 * The requests behind *Follow a sent email…* in Capture ("Follow a sent email…
 * in Capture", issue 1710), apart from `client.ts` so they are fetched with the
 * list's own chunk (`components/FollowSentEmail.tsx`) rather than in the
 * initial bundle.
 */

/** The newest sent emails of the Workspace's mailboxes, and the mailboxes that could not be read. */
export async function fetchSentEmails(workspaceId: string): Promise<SentEmails> {
  const res = await api.v1.workspaces[':workspaceId']['sent-emails'].$get({ param: { workspaceId } });
  if (!res.ok) throw refusal('reading your sent emails', res.status);
  return sentEmailsSchema.parse(await res.json());
}

/** Whether the Workspace has a mailbox to list sent mail from, which is whether Capture offers the entry. Asks no source. */
export async function sentEmailsAvailable(workspaceId: string): Promise<boolean> {
  const res = await api.v1.workspaces[':workspaceId']['sent-emails'].available.$get({ param: { workspaceId } });
  if (!res.ok) throw refusal('reading your mailboxes', res.status);
  return sentEmailsAvailableSchema.parse(await res.json()).available;
}

/** Why a pick was not followed, in the server's words where it gave any. */
export class FollowRefused extends Error {}

/** The Item that follows the picked email's conversation: made now, or the open one that already did. */
export async function followSentEmail(workspaceId: string, ask: FollowSentAsked): Promise<FollowSentAnswer> {
  const res = await api.v1.workspaces[':workspaceId']['sent-emails'].follow.$post({ param: { workspaceId }, json: ask });
  if (res.ok) return followSentAnswerSchema.parse(await res.json());
  if (res.status === 401) throw refusal('following the email', res.status);
  const said = (await res.json().catch(() => null)) as { error?: unknown } | null;
  throw new FollowRefused(typeof said?.error === 'string' ? said.error : `That email could not be followed (${res.status})`);
}
