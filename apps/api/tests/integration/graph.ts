// The Outlook connector's own recorded shapes, which its contract suite keeps
// true to Graph (packages/connectors/outlook/tests/contract).
import {
  DELETED_ITEMS_ID,
  DRAFTS_ID,
  SENT_ITEMS_ID,
  categoriesAnswer,
  deletedItemsAnswer,
  message,
  messagesPage,
  sentItemsAnswer,
  type MessageOptions,
} from '../../../../packages/connectors/outlook/tests/graph-payloads.js';

/**
 * Microsoft Graph on the faked network, beside the issuer and Gmail
 * (`./issuer.ts`, "Connect Outlook from Settings, wherever the Microsoft
 * client is set", issue 1048): one mailbox answering the calls the Outlook
 * connector makes in the shapes Graph answers them. A refresh of its sign-in is
 * the issuer's token endpoint, which answers one.
 */
export const GRAPH_API = 'https://graph.microsoft.com';

/** What a message in the mailbox is: the recorded shape's options, which a write to the flag or categories changes. */
type Held = { -readonly [K in keyof MessageOptions]: MessageOptions[K] };
let messages: Held[] = [];

/** Every call Graph was asked, as `METHOD path?query` below `/v1.0/me/`, oldest first. */
export const graphCalls: string[] = [];

/** How many messages one page of a listing holds, so a case can make a listing longer than one. */
let pageSize = 100;

/** Forgets the mailbox and what it was asked - each case starts from nothing. */
export function graphIsEmpty(): void {
  messages = [];
  graphCalls.length = 0;
  graphDrafts.length = 0;
  graphRefusing = null;
  pageSize = 100;
}

/** Graph refusing the next call whose `METHOD path` this matches, with this status - as an Outlook that will not take a draft does. */
let graphRefusing: { when: (call: string) => boolean; status: number } | null = null;
export function graphRefuses(when: (call: string) => boolean, status = 403): void {
  graphRefusing = { when, status };
}

/** What the mailbox holds, and how many messages a page of a listing carries. */
export function graphHolds(held: readonly MessageOptions[], { perPage = 100 }: { perPage?: number } = {}): void {
  messages = held.map((one) => ({ ...one }));
  pageSize = perPage;
}

/** More messages arriving in the mailbox. */
export function graphAdds(more: readonly MessageOptions[]): void {
  messages.push(...more.map((one) => ({ ...one })));
}

/** What the mailbox holds of one message now. */
export function graphMessage(id: string): Held | undefined {
  return messages.find((one) => one.id === id);
}

/** Every draft Graph was asked to make, oldest first ("Email… makes an Outlook draft the Item then follows", issue 1709): its id, its subject, and the message it replies to (null for a new conversation). */
export const graphDrafts: { id: string; subject: string; replyTo: string | null }[] = [];

/** `POST /me/messages` and `POST /me/messages/{id}/createReply`: the draft in the Drafts folder, in a conversation of its own or the message's. */
function draftMade(replyTo: string | null, body: string): Response {
  const original = replyTo === null ? undefined : messages.find((one) => one.id === replyTo);
  if (replyTo !== null && !original) return Response.json({ error: { code: 'ErrorItemNotFound', message: 'Not found.' } }, { status: 404 });
  const n = graphDrafts.length + 1;
  const asked = JSON.parse(body || '{}') as { subject?: string; body?: { content?: string } };
  const subject = original ? `RE: ${message(original).subject}` : (asked.subject ?? '');
  graphDrafts.push({ id: `draft-m-${n}`, subject, replyTo });
  const draft: Held = {
    id: `draft-m-${n}`,
    draft: true,
    folder: DRAFTS_ID,
    from: { name: 'Anna', address: 'anna@example.com' },
    subject,
    // A reply draft holds the email it answers, quoted, in HTML as Outlook writes it (message-createreply's example).
    ...(original
      ? { html: `<html><head></head><body><div><br></div><hr><div id="divRplyFwdMsg"><b>From:</b> Steven<br><b>Sent:</b> Thursday</div><div>${message(original).bodyPreview}</div></body></html>` }
      : { text: asked.body?.content ?? '' }),
    receivedAt: new Date().toISOString(), // clock-ok: the connector reads mail received since the real time it last ran
    ...(original ? { conversation: message(original).conversationId } : {}),
  };
  messages.push(draft);
  return Response.json(message(draft), { status: 201 });
}

/** The draft sent from Outlook where it stands: a message in Sent Items now, with the id it had. */
export function graphSends(id: string): void {
  const one = graphMessage(id)!;
  one.draft = false;
  one.folder = SENT_ITEMS_ID;
  one.receivedAt = new Date().toISOString(); // clock-ok: see draftMade
}

/** The draft deleted unsent: Outlook moves it to Deleted Items. */
export function graphDeletes(id: string): void {
  graphMessage(id)!.folder = DELETED_ITEMS_ID;
}

/** Answers a call to Graph, or Microsoft's token endpoint's refresh. */
export async function graphAnswer(url: URL, init?: RequestInit): Promise<Response> {
  const call = `${init?.method ?? 'GET'} ${url.pathname.replace('/v1.0/me/', '')}${url.search ? decodeURIComponent(url.search) : ''}`;
  graphCalls.push(call);
  if (graphRefusing?.when(call)) {
    const { status } = graphRefusing;
    graphRefusing = null;
    return Response.json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, { status });
  }
  const token = new Headers(init?.headers).get('authorization') ?? '';
  if (!token.startsWith('Bearer ') || token.length <= 'Bearer '.length) {
    return Response.json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } }, { status: 401 });
  }
  const path = url.pathname.replace('/v1.0/me/', '');
  if (path === 'mailFolders/deleteditems') return Response.json(deletedItemsAnswer());
  if (path === 'mailFolders/sentitems') return Response.json(sentItemsAnswer());
  if (path === 'mailFolders/sentitems/messages') {
    // Sent Items, a draft not among them, newest first ("Follow a sent email… in Capture", issue 1710).
    const sent = messages
      .filter((one) => one.folder === SENT_ITEMS_ID && !one.draft)
      .sort((a, b) => Date.parse(b.receivedAt ?? '2026-10-01T08:30:00Z') - Date.parse(a.receivedAt ?? '2026-10-01T08:30:00Z'))
      .slice(0, Number(url.searchParams.get('$top') ?? 10));
    return Response.json(messagesPage(sent.map(message), undefined, url.searchParams.get('$select')?.split(',')));
  }
  if (path === 'messages' && init?.method === 'POST') return draftMade(null, String(init.body ?? ''));
  const replying = /^messages\/(.+)\/createReply$/.exec(path);
  if (replying && init?.method === 'POST') return draftMade(decodeURIComponent(replying[1]!), String(init.body ?? ''));
  if (path === 'messages') {
    const filter = url.searchParams.get('$filter') ?? '';
    const flagged = filter.includes('flagStatus');
    const conversation = /conversationId eq '((?:[^']|'')*)'/.exec(filter)?.[1]?.replace(/''/g, "'");
    const since = /receivedDateTime ge (\S+)/.exec(filter)?.[1];
    const marked = messages.filter((one) => {
      if (conversation !== undefined) return message(one).conversationId === conversation;
      if (since !== undefined) return Date.parse(one.receivedAt ?? '2026-10-01T08:30:00Z') >= Date.parse(since);
      return flagged ? one.flag === 'flagged' : (one.categories ?? []).some((name) => name.toLowerCase() === 'cockpit');
    });
    if (url.searchParams.get('$orderby') === 'receivedDateTime') {
      marked.sort((a, b) => Date.parse(a.receivedAt ?? '2026-10-01T08:30:00Z') - Date.parse(b.receivedAt ?? '2026-10-01T08:30:00Z'));
    }
    const from = Number(url.searchParams.get('$skip') ?? 0);
    const page = marked.slice(from, from + pageSize);
    const next = new URL(url);
    next.searchParams.set('$skip', String(from + pageSize));
    return Response.json(
      messagesPage(page.map(message), from + pageSize < marked.length ? next.href : undefined, url.searchParams.get('$select')?.split(',')),
    );
  }
  const one = /^messages\/(.+)$/.exec(path);
  const held = one && messages.find((candidate) => candidate.id === decodeURIComponent(one[1]!));
  if (!held) return Response.json({ error: { code: 'ErrorItemNotFound', message: 'Not found.' } }, { status: 404 });
  if (init?.method === 'PATCH') {
    const change = JSON.parse(String(init.body)) as {
      flag?: { flagStatus: 'flagged' | 'complete' };
      categories?: string[];
      body?: { contentType: string; content: string };
    };
    if (change.body) {
      delete held.html;
      delete held.text;
      if (change.body.contentType === 'html') held.html = change.body.content;
      else held.text = change.body.content;
    }
    if (change.flag) held.flag = change.flag.flagStatus;
    if (change.categories) held.categories = change.categories;
    return Response.json(message(held));
  }
  return Response.json(url.searchParams.get('$select') === 'categories' ? categoriesAnswer(held) : message(held));
}
