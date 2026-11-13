import { SourceError, type Connector, type MessageAtLink } from '@cockpit/connector-sdk';
import { firstMessageLink, wordsBesideTheLink, type Item, type ReadPastedLinkCommand } from '@cockpit/shared';
import type { Env } from '../env.js';
import type { Account } from '../accounts/index.js';
import { logged, onDemandHost } from './drafts.js';
import { getConnector, messageLinks } from './registry.js';

/**
 * Reading the message a pasted link names, in the Worker ("Read pasted Teams
 * links", issue 1755): the clean-up job's first step for an Own note. The core
 * finds the first link a connector declared, and asks that connector, which
 * alone says which grant reads it and how its message and note are written.
 * Nothing here names a source.
 */

/** How long an Item's own link may be (`capturedFromSchema.sourceLink`). */
const SOURCE_LINK_LENGTH = 2_000;

/**
 * The link a captured note holds that some connector declared and can read,
 * with that connector and the grant reading it needs: what may be read, short
 * of asking which connections hold that grant.
 */
export function pastedLinkIn(
  env: Env,
  item: Pick<Item, 'source' | 'capturedMessage' | 'sourceId' | 'sourceLink'>,
): { source: string; link: string; connector: Connector; needs: string } | null {
  // An Own note only, as `applyPastedLinkRead` asks: an app's capture keeps its
  // app as its source ("Capture: a pasted Teams link alone makes an Item that
  // says nothing about the message", issue 1750, its decision "Only an Own note
  // typed in Cockpit is read").
  if (item.source !== 'internal' || item.sourceId !== null || item.sourceLink !== null) return null;
  const pasted = firstMessageLink(item.capturedMessage, messageLinks(env));
  // Longer than an Item's own link may be is a link no read could be stored with.
  if (!pasted || pasted.link.length > SOURCE_LINK_LENGTH) return null;
  const connector = getConnector(env, pasted.source);
  if (!connector?.readMessageAtLink || !connector.grantToRead) return null;
  const needs = connector.grantToRead(pasted.link);
  return needs === null ? null : { ...pasted, connector, needs };
}

/** What the read makes of the Item, for `read_pasted_link`. */
export type PastedLinkRead = Pick<ReadPastedLinkCommand, 'capturedFrom' | 'capturedMessage'>;

/**
 * The message the note's pasted link names, read with the first connection
 * that can: the Workspace's the note was captured in first, then each other
 * of the account's, only those granted what the connector says reading the link
 * needs. Null where none read it, which leaves the note as typed.
 *
 * **A source not answering throws**, so the queue tries the job again, unless
 * this is its last try: then it is read as not readable. A connection that
 * cannot read it is never marked failing, since the paste is optional.
 */
export async function readThePastedLink(
  env: Env,
  account: Account,
  item: Pick<Item, 'id' | 'workspaceId' | 'source' | 'capturedMessage' | 'sourceId' | 'sourceLink'>,
  lastAttempt: boolean,
): Promise<PastedLinkRead | null> {
  const pasted = pastedLinkIn(env, item);
  if (!pasted || !item.capturedMessage) return null;
  const { connector, needs } = pasted;
  const able = (await account.connectionsOfConnector(pasted.source)).filter((one) => one.granted?.includes(needs));
  const inOrder = [...able.filter((one) => one.workspaceId === item.workspaceId), ...able.filter((one) => one.workspaceId !== item.workspaceId)];
  const note = wordsBesideTheLink(item.capturedMessage, pasted.link);

  let busy: SourceError | null = null;
  for (const connection of inOrder) {
    // The account's own store failing is no answer about the link: it throws,
    // so the queue tries the job again.
    const asked = await account.listingAsk(connection.workspaceId, connection.id);
    const host = onDemandHost(
      env,
      account,
      connection.id,
      { sealedCredential: asked.sealedCredential, credentialNonce: asked.credentialNonce },
      asked.state,
      pasted.source,
    );
    let read: MessageAtLink | null;
    try {
      // Present: `pastedLinkIn` answers only for a connector that reads links.
      read = await connector.readMessageAtLink!(host, pasted.link, note);
    } catch (error) {
      if (error instanceof SourceError) {
        busy ??= error;
      } else {
        logged(pasted.source, 'error', 'a pasted link could not be read', error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    if (read) {
      return {
        capturedFrom: {
          source: pasted.source,
          sourceId: read.sourceId,
          sourceLink: pasted.link,
          ...(read.sender ? { sender: read.sender } : {}),
          ...(read.sentAt ? { sourceTimestamp: read.sentAt } : {}),
        },
        capturedMessage: read.capturedMessage,
      };
    }
  }
  if (busy && !lastAttempt) throw busy;
  if (busy) logged(pasted.source, 'warn', 'a pasted link was not read on the last try', busy.message);
  return null;
}
