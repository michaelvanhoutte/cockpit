// The Outlook connector's own recorded shapes, which its contract suite keeps
// true to Graph (packages/connectors/outlook/tests/contract).
import {
  categoriesAnswer,
  deletedItemsAnswer,
  message,
  messagesPage,
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
  pageSize = 100;
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

/** Answers a call to Graph, or Microsoft's token endpoint's refresh. */
export async function graphAnswer(url: URL, init?: RequestInit): Promise<Response> {
  const call = `${init?.method ?? 'GET'} ${url.pathname.replace('/v1.0/me/', '')}${url.search ? decodeURIComponent(url.search) : ''}`;
  graphCalls.push(call);
  const token = new Headers(init?.headers).get('authorization') ?? '';
  if (!token.startsWith('Bearer ') || token.length <= 'Bearer '.length) {
    return Response.json({ error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty.' } }, { status: 401 });
  }
  const path = url.pathname.replace('/v1.0/me/', '');
  if (path === 'mailFolders/deleteditems') return Response.json(deletedItemsAnswer());
  if (path === 'messages') {
    const filter = url.searchParams.get('$filter') ?? '';
    const flagged = filter.includes('flagStatus');
    const marked = messages.filter((one) =>
      flagged ? one.flag === 'flagged' : (one.categories ?? []).some((name) => name.toLowerCase() === 'cockpit'),
    );
    const from = Number(url.searchParams.get('$skip') ?? 0);
    const page = marked.slice(from, from + pageSize);
    const next = new URL(url);
    next.searchParams.set('$skip', String(from + pageSize));
    return Response.json(messagesPage(page.map(message), from + pageSize < marked.length ? next.href : undefined));
  }
  const one = /^messages\/(.+)$/.exec(path);
  const held = one && messages.find((candidate) => candidate.id === decodeURIComponent(one[1]!));
  if (!held) return Response.json({ error: { code: 'ErrorItemNotFound', message: 'Not found.' } }, { status: 404 });
  if (init?.method === 'PATCH') {
    const change = JSON.parse(String(init.body)) as { flag?: { flagStatus: 'flagged' | 'complete' }; categories?: string[] };
    if (change.flag) held.flag = change.flag.flagStatus;
    if (change.categories) held.categories = change.categories;
    return Response.json(message(held));
  }
  return Response.json(url.searchParams.get('$select') === 'categories' ? categoriesAnswer(held) : message(held));
}
