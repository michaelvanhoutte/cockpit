import { createGmailConnector } from '../../src/index.js';
import type { Connector } from '@cockpit/connector-sdk';
import {
  COCKPIT_LABEL_ID,
  STARRED,
  historyAnswer,
  historyRecord,
  labelsAnswer,
  modifyAnswer,
  plainThread,
  profileAnswer,
  threadsPage,
} from '../gmail-payloads.js';
import { FakeHost } from './fake-host.js';

/**
 * Gmail and Google's token endpoint as a connector meets them over the network,
 * kept in memory and answering in the shapes `gmail-payloads.ts` records
 * (docs/testing-strategy.md, "Third parties": faked at the network boundary, by
 * replacing `fetch`, so the connector does its own requests).
 *
 * A mailbox is changed the way a person changes one - `mark`, `unmark`, `bin`,
 * `arrives` - and the world writes the history Gmail would, so a case says what
 * happened to the mailbox and not what the history looks like.
 */

export const NOW = new Date('2026-10-09T12:00:00.000Z');
export const TOKEN_URL = 'https://oauth.example.test/token';
export const REVOKE_URL = 'https://oauth.example.test/revoke';
export const API = 'https://gmail.example.test';
export const ADDRESS = 'anna@example.com';

interface Thread {
  id: string;
  messages: ReturnType<typeof plainThread>['messages'];
}

export class GmailWorld {
  /** Newest first, as Gmail lists them. */
  #threads: Thread[] = [];
  #records: { at: number; record: ReturnType<typeof historyRecord> }[] = [];
  #historyId = 4_000;
  #oldestKept = 0;

  hasLabel = true;
  /** Conversations Gmail answers per list page; the real ceiling is far above what a case needs. */
  historyPageSize = 1000;
  /** What each next call to a path prefix answers instead, once each: `[status, body]`. */
  readonly failures: { prefix: string; status: number; body?: unknown }[] = [];
  /** Every request made, in order, as `METHOD path?query`. */
  readonly requests: string[] = [];
  /** Which token Google accepts: others are answered 401 until refreshed. */
  acceptedToken = 'a-good-access-token';
  /** What the token endpoint answers a refresh with. */
  refreshAnswer: { status: number; body: unknown } = {
    status: 200,
    body: { access_token: 'a-good-access-token', expires_in: 3599, scope: 'openid', token_type: 'Bearer' },
  };
  revoked: string[] = [];
  revokeStatus = 200;
  /** What `threads.modify` answers for a conversation: a status other than 200 refuses it. */
  modifyStatus: (threadId: string) => number = () => 200;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${url.search}`);

    if (url.origin + url.pathname === TOKEN_URL) {
      return json(this.refreshAnswer.body, this.refreshAnswer.status);
    }
    if (url.origin + url.pathname === REVOKE_URL) {
      this.revoked.push(String(new URLSearchParams(String(init?.body)).get('token')));
      return json({}, this.revokeStatus);
    }
    const failure = this.failures.findIndex((one) => url.pathname.includes(one.prefix));
    if (failure >= 0) {
      const [one] = this.failures.splice(failure, 1);
      return json(one!.body ?? {}, one!.status);
    }
    const bearer = new Headers(init?.headers).get('authorization');
    if (bearer !== `Bearer ${this.acceptedToken}`) return json({ error: { code: 401 } }, 401);

    const path = url.pathname.replace('/gmail/v1/users/me/', '');
    if (path === 'labels') return json(labelsAnswer({ cockpit: this.hasLabel }));
    if (path === 'profile') return json({ ...profileAnswer(String(this.#historyId)), emailAddress: ADDRESS });
    if (path === 'threads') return this.#list(url);
    if (path === 'history') return this.#history(url);
    const modify = /^threads\/([^/]+)\/modify$/.exec(path);
    if (modify) return this.#modify(decodeURIComponent(modify[1]!), JSON.parse(String(init?.body)));
    const read = /^threads\/([^/]+)$/.exec(path);
    if (read) {
      const thread = this.#threads.find((one) => one.id === decodeURIComponent(read[1]!));
      return thread ? json({ id: thread.id, historyId: String(this.#historyId), messages: thread.messages }) : json({}, 404);
    }
    return json({}, 404);
  };

  /** A conversation arriving, carrying the marks it is given. */
  arrives(id: string, subject: string, text = `The text of ${id}.`, marks: readonly ('label' | 'star')[] = ['label']): void {
    const thread = plainThread(id, subject, text, { labelled: marks.includes('label'), starred: marks.includes('star') });
    this.#threads.unshift({ id, messages: thread.messages });
    const message = thread.messages[0]!;
    this.#record({ added: message.id, threadId: id, labelIds: message.labelIds });
  }

  mark(threadId: string, mark: 'label' | 'star'): void {
    this.#change(threadId, mark, true);
  }

  unmark(threadId: string, mark: 'label' | 'star'): void {
    this.#change(threadId, mark, false);
  }

  bin(threadId: string): void {
    const thread = this.#thread(threadId);
    for (const message of thread.messages) message.labelIds = [...message.labelIds.filter((one) => one !== 'INBOX'), 'TRASH'];
    const message = thread.messages[0]!;
    this.#record({ labelled: message.id, threadId, with: ['TRASH'], labelIds: message.labelIds });
  }

  /** Gmail forgetting its history up to now, as it does after about a week. */
  forgetHistory(): void {
    this.#oldestKept = this.#historyId;
  }

  labelsOf(threadId: string): string[] {
    return this.#thread(threadId).messages[0]!.labelIds;
  }

  /** The requests made to Google's API for a conversation read in full - what a run spent on reading. */
  readsInFull(): string[] {
    return this.requests.filter((one) => /GET .*threads\/[^/?]+\?format=full/.test(one)).map((one) => /threads\/([^/?]+)/.exec(one)![1]!);
  }

  gmailCalls(): number {
    return this.requests.filter((one) => one.includes('/gmail/v1/')).length;
  }

  forget(): void {
    this.requests.length = 0;
  }

  connector(options: { now?: () => Date } = {}): Connector {
    return createGmailConnector({
      clientId: 'gmails-own-client',
      clientSecret: 'gmails-own-secret',
      apiOrigin: API,
      endpoints: { tokenEndpoint: TOKEN_URL, revocationEndpoint: REVOKE_URL },
      fetch: this.fetch,
      now: options.now ?? (() => NOW),
    });
  }

  #thread(id: string): Thread {
    const thread = this.#threads.find((one) => one.id === id);
    if (!thread) throw new Error(`no conversation ${id}`);
    return thread;
  }

  #change(threadId: string, mark: 'label' | 'star', on: boolean): void {
    const markId = mark === 'label' ? COCKPIT_LABEL_ID : STARRED;
    const thread = this.#thread(threadId);
    for (const message of thread.messages) {
      message.labelIds = on ? [...new Set([...message.labelIds, markId])] : message.labelIds.filter((one) => one !== markId);
    }
    const message = thread.messages[0]!;
    this.#record(
      on
        ? { labelled: message.id, threadId, with: [markId], labelIds: message.labelIds }
        : { unlabelled: message.id, threadId, with: [markId], labelIds: message.labelIds },
    );
  }

  #record(change: Parameters<typeof historyRecord>[1]): void {
    this.#historyId += 1;
    this.#records.push({ at: this.#historyId, record: historyRecord(String(this.#historyId), change) });
  }

  #carrying(markId: string): Thread[] {
    return this.#threads.filter((thread) =>
      thread.messages.some((message) => message.labelIds.includes(markId) && !message.labelIds.includes('TRASH')),
    );
  }

  #list(url: URL): Response {
    const markId = url.searchParams.get('labelIds')!;
    const size = Number(url.searchParams.get('maxResults'));
    const offset = Number(url.searchParams.get('pageToken') ?? 0);
    const all = this.#carrying(markId).map((one) => one.id);
    const page = all.slice(offset, offset + size);
    return json(threadsPage(page, offset + size < all.length ? String(offset + size) : undefined));
  }

  #history(url: URL): Response {
    const start = Number(url.searchParams.get('startHistoryId'));
    if (start < this.#oldestKept) return json({ error: { code: 404 } }, 404);
    const offset = Number(url.searchParams.get('pageToken') ?? 0);
    const wanted = this.#records.filter((one) => one.at > start);
    const page = wanted.slice(offset, offset + this.historyPageSize);
    return json(
      historyAnswer(
        page.map((one) => one.record),
        {
          historyId: String(this.#historyId),
          ...(offset + this.historyPageSize < wanted.length ? { nextPageToken: String(offset + this.historyPageSize) } : {}),
        },
      ),
    );
  }

  #modify(threadId: string, body: { addLabelIds?: string[]; removeLabelIds?: string[] }): Response {
    const status = this.modifyStatus(threadId);
    if (status !== 200) return json({ error: { code: status } }, status);
    const thread = this.#threads.find((one) => one.id === threadId);
    if (!thread) return json({}, 404);
    const [markId, on] = body.addLabelIds ? [body.addLabelIds[0]!, true] : [body.removeLabelIds![0]!, false];
    for (const message of thread.messages) {
      message.labelIds = on ? [...new Set([...message.labelIds, markId])] : message.labelIds.filter((one) => one !== markId);
    }
    return json(modifyAnswer({ id: thread.id, historyId: String(this.#historyId), messages: thread.messages }));
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A host holding a Gmail credential the way the generic sign-in seals it, with an access token that has hours left. */
export function signedInHost(options: { choice?: string | null; expiresAt?: string | null; accessToken?: string } = {}): FakeHost {
  const expiresAt = options.expiresAt === undefined ? '2026-10-09T13:00:00.000Z' : options.expiresAt;
  return new FakeHost({
    ...(options.choice === undefined ? {} : { choice: options.choice }),
    credential: {
      credential: JSON.stringify({
        access_token: options.accessToken ?? 'a-good-access-token',
        refresh_token: 'the-refresh-token',
        scope: 'openid email https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        ...(expiresAt ? { expires_at: expiresAt } : {}),
      }),
    },
  });
}
