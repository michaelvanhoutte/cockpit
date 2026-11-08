import { SourceError, type Connector, type SentEmail } from '@cockpit/connector-sdk';
import { SENT_EMAILS_SHOWN, type FollowSentAsked, type SentEmailEntry, type SentEmails } from '@cockpit/shared/sent-emails';
import type { Env } from '../env.js';
import { NotFoundInAccountError, type Account } from '../accounts/index.js';
import { derivedUuid } from '../domain/derived-uuid.js';
import { logged, onDemandHost } from './drafts.js';
import { getConnector } from './registry.js';

/**
 * *Follow a sent email…* in the Worker ("Follow a sent email… in Capture",
 * issue 1710): the second place a person's request waits on an outside source,
 * after *Email…* (`drafts.ts`). The Worker opens each mail connection's
 * credential, has its connector list the newest sent mail, and answers the
 * newest ten of all of them. Nothing is changed at any source.
 *
 * **Not measured.** The spike that was to time the listing against a test
 * mailbox (issue 1704) was skipped, so the 2 s the design budgets for it is
 * unproven; built to the design as it stands.
 */

/** Whether a connection lists its sent mail: its connector can, under the choice it follows. */
function listsSent(connector: Connector | undefined, follows: string | null): boolean {
  const under = connector?.manifest.startsConversations?.underChoices;
  return Boolean(connector?.listRecentSent && under && follows !== null && under.includes(follows));
}

/** The Workspace's connections whose sent mail can be listed. */
function connectionsListingSent(env: Env, account: Account, workspaceId: string) {
  return account
    .sourceAccounts(workspaceId)
    .then((all) => all.filter((one) => listsSent(getConnector(env, one.connectorId), one.follows ?? null)));
}

/**
 * Whether the Workspace has a connection to list sent mail from, which is whether
 * Capture offers *Follow a sent email…*. Asks no source: it reads the connections.
 */
export async function sentMailCanBeListed(env: Env, account: Account, workspaceId: string): Promise<boolean> {
  return (await connectionsListingSent(env, account, workspaceId)).length > 0;
}

/**
 * The newest ten emails sent from the Workspace's mail connections, newest
 * first. A connection that cannot be read is named with why, and the others are
 * listed all the same.
 */
export async function listSentEmails(env: Env, account: Account, workspaceId: string): Promise<SentEmails> {
  const connections = await connectionsListingSent(env, account, workspaceId);
  const read = await Promise.allSettled(
    connections.map(async (one) => {
      const connector = getConnector(env, one.connectorId)!;
      const asked = await account.listingAsk(workspaceId, one.id);
      const host = onDemandHost(
        env,
        account,
        one.id,
        { sealedCredential: asked.sealedCredential, credentialNonce: asked.credentialNonce },
        asked.state,
        one.connectorId,
      );
      const sent: SentEmail[] = await connector.listRecentSent!(host, SENT_EMAILS_SHOWN);
      return sent.map(
        (email): SentEmailEntry => ({
          sourceAccountId: one.id,
          connectorId: one.connectorId,
          mailbox: one.displayName,
          ...email,
        }),
      );
    }),
  );
  const emails: SentEmailEntry[] = [];
  const failing: SentEmails['failing'] = [];
  read.forEach((result, at) => {
    const connection = connections[at]!;
    if (result.status === 'fulfilled') {
      emails.push(...result.value);
      return;
    }
    const error = result.reason;
    if (error instanceof SourceError) failing.push({ mailbox: connection.displayName, why: error.message });
    else {
      logged(connection.connectorId, 'error', 'sent mail could not be listed', error instanceof Error ? error.message : String(error));
      failing.push({ mailbox: connection.displayName, why: 'something went wrong' });
    }
  });
  emails.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
  return { emails: emails.slice(0, SENT_EMAILS_SHOWN), failing };
}

/**
 * Picks a sent email: the Item that follows its conversation, Waiting for
 * reply. Its id and the ids of the two changes are derived from the connection
 * and the conversation, so the same pick sent twice is one Item.
 */
export async function followSentEmail(
  env: Env,
  account: Account,
  accountName: string,
  workspaceId: string,
  ask: FollowSentAsked,
): Promise<{ itemId: string; made: boolean }> {
  const held = (await account.sourceAccounts(workspaceId)).find((one) => one.id === ask.sourceAccountId);
  if (!held || !listsSent(getConnector(env, held.connectorId), held.follows ?? null)) {
    throw new NotFoundInAccountError(`no connection ${ask.sourceAccountId} of this workspace lists sent mail`);
  }
  const named = JSON.stringify([accountName, ask.sourceAccountId, ask.conversationId]);
  return account.followSentEmail({
    workspaceId,
    sourceAccountId: ask.sourceAccountId,
    itemId: await derivedUuid(`sent-item:${named}`),
    captureId: await derivedUuid(`sent-captured:${named}`),
    followId: await derivedUuid(`sent-followed:${named}`),
    conversationId: ask.conversationId,
    subject: ask.subject,
    to: ask.to,
    sentAt: ask.sentAt,
    link: ask.link,
    excerpt: ask.excerpt,
    decided: ask.decided,
    panelIds: ask.panelIds ?? [],
  });
}
