import type { Connector } from '@cockpit/connector-sdk';
import { createOutlookConnector } from '../../src/index.js';
import {
  ARCHIVE_ID,
  DELETED_ITEMS_ID,
  VERSION_CHANGED,
  categoriesAnswer,
  deletedItemsAnswer,
  message,
  messagesPage,
  refreshAnswer,
  type MessageOptions,
} from '../graph-payloads.js';
import { FakeHost } from './fake-host.js';

/**
 * Microsoft Graph and Microsoft's token endpoint as a connector meets them over
 * the network, kept in memory and answering in the shapes `graph-payloads.ts`
 * records (docs/testing-strategy.md, "Third parties": faked at the network
 * boundary, by replacing `fetch`, so the connector does its own requests).
 *
 * A mailbox is changed the way a person changes one - `flag`, `complete`,
 * `categorise`, `moveTo`, `deleteForGood` - so a case says what happened to the
 * mailbox and not what Graph would answer.
 */

export const NOW = new Date('2026-10-09T12:00:00.000Z');
export const TOKEN_URL = 'https://login.example.test/token';
export const API = 'https://graph.example.test';
export const BUDGET = 40;

type Stored = { -readonly [K in keyof MessageOptions]: MessageOptions[K] };

export class GraphWorld {
  /** Newest first. */
  #messages: Stored[] = [];

  /** Messages Graph answers per list page. */
  pageSize = 100;
  /**
   * Graph answering a list as if its filter matched everything, so what the
   * connector decides for itself (a completed flag, the other mark, Deleted
   * Items) is shown by the connector and not by this fake.
   */
  listsEverything = false;
  /** The origin the next-page link of a listing names instead of Graph's own. */
  nextLinkOrigin: string | null = null;
  /** Something that happens to the mailbox between a listing and the read of a message in it. */
  beforeRead: (id: string) => void = () => {};
  /** What each call whose path includes `prefix` answers instead, once each, after letting `after` such calls through. */
  readonly failures: { prefix: string; status: number; body?: unknown; after?: number }[] = [];
  /** Every request made, in order, as `METHOD path?query`. */
  readonly requests: string[] = [];
  /** The `Prefer` header of every request to Graph, in order. */
  readonly prefer: (string | null)[] = [];
  /** Which token Graph accepts: others are answered 401 until refreshed. */
  acceptedToken = 'a-good-access-token';
  /** What the token endpoint answers a refresh with. */
  refresh: { status: number; body: unknown } = { status: 200, body: refreshAnswer() };

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${decodeURIComponent(url.search)}`);

    if (url.origin + url.pathname === TOKEN_URL) return json(this.refresh.body, this.refresh.status);
    const headers = new Headers(init?.headers);
    this.prefer.push(headers.get('prefer'));
    const failure = this.failures.findIndex((one) => url.pathname.includes(one.prefix));
    if (failure >= 0 && (this.failures[failure]!.after ?? 0) > 0) {
      this.failures[failure]!.after! -= 1;
    } else if (failure >= 0) {
      const [one] = this.failures.splice(failure, 1);
      return json(one!.body ?? {}, one!.status);
    }
    if (headers.get('authorization') !== `Bearer ${this.acceptedToken}`) return json({ error: { code: 'InvalidAuthenticationToken' } }, 401);

    const path = url.pathname.replace('/v1.0/me/', '');
    if (path === 'mailFolders/deleteditems') return json(deletedItemsAnswer());
    if (path === 'messages') return this.#list(url, headers.get('prefer')?.includes('ImmutableId') ?? false);
    const read = /^messages\/(.+)$/.exec(path);
    if (read && method === 'PATCH') return this.#write(decodeURIComponent(read[1]!), headers.get('if-match'), init?.body);
    if (read) {
      const id = decodeURIComponent(read[1]!);
      this.beforeRead(id);
      const found = this.#find(id);
      if (!found) return json({ error: { code: 'ErrorItemNotFound' } }, 404);
      return json(url.searchParams.get('$select') === 'categories' ? categoriesAnswer(found) : message(found));
    }
    return json({}, 404);
  };

  /** Something the person does to a message between the connector reading its categories and writing them back. */
  beforeWrite: (id: string) => void = () => {};

  /** Every change written to a message, in order: its body and the version it was conditional on. */
  readonly writes: { id: string; body: unknown; ifMatch: string | null }[] = [];

  /** The flag of a message as Outlook shows it. */
  flagOf(id: string): string {
    return this.#get(id).flag ?? 'notFlagged';
  }

  /** The categories of a message as Outlook shows them, in order. */
  categoriesOf(id: string): readonly string[] {
    return this.#get(id).categories ?? [];
  }

  /**
   * A `PATCH` of one message: refused where it names a version the message has
   * moved past, merged into it otherwise - the flag's status, or the whole
   * category list - with a new version.
   */
  #write(id: string, ifMatch: string | null, body: BodyInit | null | undefined): Response {
    this.beforeWrite(id);
    const found = this.#find(id);
    if (!found) return json({ error: { code: 'ErrorItemNotFound' } }, 404);
    const change = JSON.parse(String(body)) as { flag?: { flagStatus?: Stored['flag'] }; categories?: string[] };
    this.writes.push({ id: found.id, body: change, ifMatch });
    if (ifMatch !== null && ifMatch !== versionOf(found)) return json(VERSION_CHANGED, 412);
    if (change.flag?.flagStatus) found.flag = change.flag.flagStatus;
    if (change.categories) found.categories = [...change.categories];
    this.#changed(found);
    return json(message(found));
  }

  #changed(one: Stored): void {
    one.version = `W/"v${Number(/v(\d+)/.exec(versionOf(one))?.[1] ?? 0) + 1}"`;
  }

  /** A message arriving, carrying the marks it is given. */
  arrives(id: string, options: Omit<MessageOptions, 'id'> = {}): void {
    this.#messages.unshift({ id, version: 'W/"v1"', ...options });
  }

  flag(id: string): void {
    this.#changed(Object.assign(this.#get(id), { flag: 'flagged' as const }));
  }

  complete(id: string): void {
    this.#changed(Object.assign(this.#get(id), { flag: 'complete' as const }));
  }

  unflag(id: string): void {
    this.#changed(Object.assign(this.#get(id), { flag: 'notFlagged' as const }));
  }

  categorise(id: string, ...categories: string[]): void {
    const one = this.#get(id);
    one.categories = [...(one.categories ?? []), ...categories];
    this.#changed(one);
  }

  uncategorise(id: string): void {
    this.#changed(Object.assign(this.#get(id), { categories: [] }));
  }

  moveTo(id: string, folder: string): void {
    this.#get(id).folder = folder;
  }

  deleteForGood(id: string): void {
    this.#messages = this.#messages.filter((one) => one.id !== id);
  }

  /** The messages read in full - what a run spent on reading - in order. */
  readsInFull(): string[] {
    return this.requests.filter((one) => /^GET \/v1\.0\/me\/messages\/[^?]/.test(one)).map((one) => /messages\/([^?]+)/.exec(one)![1]!);
  }

  listPages(): number {
    return this.requests.filter((one) => /^GET \/v1\.0\/me\/messages\?/.test(one)).length;
  }

  graphCalls(): number {
    return this.requests.filter((one) => one.includes('/v1.0/')).length;
  }

  forget(): void {
    this.requests.length = 0;
    this.prefer.length = 0;
  }

  connector(options: { now?: () => Date; callsPerRun?: number } = {}): Connector {
    return createOutlookConnector({
      clientId: 'microsofts-own-client',
      clientSecret: 'microsofts-own-secret',
      callsPerRun: options.callsPerRun ?? BUDGET,
      apiOrigin: API,
      endpoints: { tokenEndpoint: TOKEN_URL },
      fetch: this.fetch,
      now: options.now ?? (() => NOW),
    });
  }

  #get(id: string): Stored {
    const found = this.#messages.find((one) => one.id === id);
    if (!found) throw new Error(`no message ${id}`);
    return found;
  }

  /** A message by its id - the immutable one, or the default one Graph hands out without asking, which dies when the message moves. */
  #find(id: string): Stored | undefined {
    return this.#messages.find((one) => one.id === id || mutableId(one) === id);
  }

  #list(url: URL, immutable: boolean): Response {
    const filter = url.searchParams.get('$filter') ?? '';
    const top = Math.min(Number(url.searchParams.get('$top') ?? 10), this.pageSize);
    const skip = Number(url.searchParams.get('$skip') ?? 0);
    const matching = this.#messages.filter((one) => this.listsEverything || matches(one, filter));
    const page = matching.slice(skip, skip + top);
    const shown = page.map((one) => message(immutable ? one : { ...one, id: mutableId(one) }));
    let next: string | undefined;
    if (skip + top < matching.length) {
      const link = new URL(url);
      link.searchParams.set('$skip', String(skip + top));
      next = this.nextLinkOrigin ? link.href.replace(link.origin, this.nextLinkOrigin) : link.href;
    }
    return json(messagesPage(shown, next));
  }
}

/** The version Graph names a message at. */
function versionOf(one: Stored): string {
  return one.version ?? 'W/"v1"';
}

/** What Graph calls a message without the immutable id header: it names the folder, so it changes when the message moves. */
function mutableId(one: Stored): string {
  return `${one.id}.in.${one.folder ?? 'inbox'}`;
}

function matches(one: Stored, filter: string): boolean {
  if (filter.includes('flag/flagStatus')) return (one.flag ?? 'notFlagged') === 'flagged';
  const category = /c eq '([^']+)'/.exec(filter)?.[1]?.toLowerCase();
  return category !== undefined && (one.categories ?? []).some((name) => name.toLowerCase() === category);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A host holding an Outlook credential the way the generic sign-in seals it, with an access token that has hours left. */
export function signedInHost(options: { choice?: string | null; expiresAt?: string | null; accessToken?: string } = {}): FakeHost {
  const expiresAt = options.expiresAt === undefined ? '2026-10-09T13:00:00.000Z' : options.expiresAt;
  return new FakeHost({
    ...(options.choice === undefined ? {} : { choice: options.choice }),
    credential: {
      credential: JSON.stringify({
        access_token: options.accessToken ?? 'a-good-access-token',
        refresh_token: 'the-refresh-token',
        scope: 'Mail.ReadWrite openid profile email',
        token_type: 'Bearer',
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      }),
    },
  });
}

export { ARCHIVE_ID, DELETED_ITEMS_ID };
