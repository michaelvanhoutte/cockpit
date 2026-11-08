import { useSyncExternalStore } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { DRAFT_STARTING_PREFIX, isDraftStarting, isLinkedInConversation, type Conversation, type Mailbox } from '@cockpit/shared';

/**
 * *Email…* and *Reply…* ("Email… makes a Gmail draft the Item then follows",
 * issue 1708): which mailboxes an Item's entry offers, and the click itself -
 * a tab opened at once, so no pop-up blocker refuses it, pointed at the draft
 * once the server has had the mailbox make it. The Item reads In progress and
 * *Draft started* from the click, before any answer.
 */

/** What an Item's entry says and which mailboxes it offers, last used first; null where none is offered. */
export interface EmailEntry {
  label: 'Email…' | 'Reply…';
  mailboxes: Mailbox[];
}

/**
 * The entry an Item offers: none without a mailbox, on an Item following a
 * LinkedIn conversation (answered in LinkedIn), or one following a conversation
 * no mailbox's connector reads. *Reply…* where it follows one a mailbox reads,
 * offering only that connector's; *Email…* otherwise. Several are offered last
 * used first, which the menu asks between; one is used as it is.
 */
export function emailEntryFor(
  conversation: Conversation | undefined,
  mailboxes: readonly Mailbox[] | undefined,
  lastUsed: string | null,
): EmailEntry | null {
  const followed = conversation && !isDraftStarting(conversation) ? conversation : undefined;
  if (followed && isLinkedInConversation(followed)) return null;
  const offered = (mailboxes ?? []).filter((one) => !followed || one.connectorId === followed.source);
  if (offered.length === 0) return null;
  const last = offered.find((one) => one.sourceAccountId === lastUsed);
  return {
    label: followed ? 'Reply…' : 'Email…',
    mailboxes: last ? [last, ...offered.filter((one) => one !== last)] : offered,
  };
}

/**
 * The conversation a row draws from the click on *Email…* until the Workspace
 * read carries the draft: the one it follows with the draft started, or a new
 * one at the connector the draft is made at, opening nothing yet.
 */
export function draftBeingStarted(itemId: string, connectorId: string, followed: Conversation | undefined): Conversation {
  const at = new Date().toISOString();
  return {
    ...(followed ?? {
      itemId,
      source: connectorId,
      conversationId: DRAFT_STARTING_PREFIX,
      link: '',
      lastBy: 'you',
      lastFrom: null,
      lastAt: at,
      lastExcerpt: '',
      messageCount: 1,
      startedAt: at,
      withWhom: null,
    }),
    draftStarted: true,
  };
}

/** Where this browser keeps the mailbox it last made a draft in, per Workspace. */
export const LAST_USED_KEY = 'cockpit.lastMailbox';

/** The mailbox this browser last made a draft in, for one Workspace: a per-viewer convenience, so lost storage only loses the order. */
export function lastMailboxIn(workspaceId: string): string | null {
  try {
    const held = JSON.parse(localStorage.getItem(LAST_USED_KEY) ?? '{}') as Record<string, unknown>;
    return typeof held[workspaceId] === 'string' ? held[workspaceId] : null;
  } catch {
    return null;
  }
}

/** The Items a click on *Email…* is making a draft for, with the connector it is made at, until the Workspace read says so itself. */
const starting = new Map<string, string>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listen of listeners) listen();
}

/** The connector a draft is being made at for this Item right now, or null: drawn In progress and *Draft started* meanwhile. */
export function useDraftStarting(itemId: string): string | null {
  return useSyncExternalStore(
    (listen) => {
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
    () => starting.get(itemId) ?? null,
  );
}

/**
 * The click: a blank tab opened now, while the click still allows it, the
 * draft asked for, and the tab pointed at it. Refused, the tab closes and the
 * line the row or form says is offered with Undo. The Workspace is read again
 * either way, so the row draws what the server holds.
 */
export async function emailFromItem(
  queryClient: QueryClient | undefined,
  ask: { workspaceId: string; itemId: string; mailbox: Mailbox; label: string },
  offer: (undo: { what: string }) => void,
): Promise<void> {
  const { itemId, mailbox } = ask;
  // A second press while the first is still making its draft makes no second draft.
  if (starting.has(itemId)) return;
  const tab = window.open('', '_blank');
  // The draft's page gets no hold on this one, as a link's `noopener` gives none.
  if (tab) tab.opener = null;
  starting.set(itemId, mailbox.connectorId);
  changed();
  let line: string | null;
  try {
    const { makeTheDraft } = await import('./emailDraftClick');
    line = await makeTheDraft(queryClient, ask, tab);
  } catch {
    // The chunk could not be fetched (offline, or a deploy since): nothing was asked of the server.
    tab?.close();
    line = `“${ask.label}”: Couldn't make the draft. Try again.`;
  } finally {
    starting.delete(itemId);
    changed();
  }
  if (line) offer({ what: line });
}
