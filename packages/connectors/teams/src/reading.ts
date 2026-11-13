import { SourceError, type MessageAtLink, type OnDemandHost } from '@cockpit/connector-sdk';
import { TITLE_LENGTH, cutTo, plainText, timestamp, withTheNote } from './activity.js';
import { MICROSOFT_ISSUER } from './sign-in.js';

/**
 * Reading the one Teams message a pasted link names, through Microsoft Graph
 * ("Read pasted Teams links", issue 1755), with the grant the connection got
 * when it was connected (sign-in.ts).
 *
 * | Link | Graph | Grant |
 * |---|---|---|
 * | a 1:1, group or meeting chat's message | `GET /chats/{chat}/messages/{message}` | `chats` |
 * | a channel post | `GET /teams/{team}/channels/{channel}/messages/{message}`, a reply under its post | `channels` |
 * | anything on personal Teams (`teams.live.com`) | none: Microsoft offers no access to it | none |
 *
 * **Not readable is an answer, not a failure**: a message deleted or refused
 * (another organisation, a grant withdrawn) and a sign-in Microsoft no longer
 * accepts all answer null, so the host tries the next connection and the Item
 * stays as typed. Only Microsoft not answering throws.
 */

/** The personal Teams host, whose messages Graph cannot reach. */
const PERSONAL_HOST = 'teams.live.com';

/** Where in Teams a message link points. */
export type LinkedMessage =
  | { kind: 'chat'; chatId: string; messageId: string }
  | { kind: 'channel'; teamId: string; channelId: string; messageId: string; parentId: string | null };

/**
 * The message a copied Teams link names, or null where it names none Graph can
 * read: personal Teams, or a link missing its thread or message.
 *
 * A link is `/l/message/{thread}/{message}`; a channel post's also carries the
 * team as `groupId` and, for a reply, the post it answers as `parentMessageId`
 * (Teams' "Copy link"). A chat's carries no team, a meeting chat included
 * (`19:meeting_…@thread.v2`).
 */
export function linkedMessage(link: string): LinkedMessage | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() === PERSONAL_HOST) return null;
  const match = /^\/l\/message\/([^/]+)\/([^/?#]+)/.exec(url.pathname);
  if (!match) return null;
  const thread = decoded(match[1]!);
  const messageId = decoded(match[2]!);
  if (!thread || !messageId) return null;
  const teamId = url.searchParams.get('groupId')?.trim();
  if (teamId) {
    const parent = url.searchParams.get('parentMessageId')?.trim();
    return { kind: 'channel', teamId, channelId: thread, messageId, parentId: parent && parent !== messageId ? parent : null };
  }
  return { kind: 'chat', chatId: thread, messageId };
}

/** The grant a connection needs to read the message at this link, or null where none reads it. */
export function grantToRead(link: string): string | null {
  const message = linkedMessage(link);
  if (!message) return null;
  return message.kind === 'chat' ? 'chats' : 'channels';
}

/** What reading a pasted link needs to have been told. */
export interface ReadingConfig {
  /** The client Microsoft issued this Cockpit (`MS_CLIENT_ID`), which a refresh is made with. */
  readonly clientId: string;
  readonly clientSecret: string;
  /** Who issues the sign-in, whose discovery document names where to refresh it. Defaults to Microsoft's. */
  readonly issuer?: string;
  /** Where Graph is reached. Defaults to Microsoft's; a local stack points it at its stand-in. */
  readonly apiOrigin?: string;
  /** Handed in by the tests, which must reach no network. */
  readonly fetch?: typeof fetch;
  /** Read once per use, so a token is judged against the time it is used. */
  readonly now?: () => Date;
}

/** Microsoft not answering this time, in words that name no address. */
const NOT_ANSWERING = 'Microsoft could not be reached';

/** The message at the link, read with this connection's sign-in, or null where it cannot be. */
export async function readMessageAtLink(
  host: OnDemandHost,
  config: ReadingConfig,
  link: string,
  note: string,
): Promise<MessageAtLink | null> {
  const message = linkedMessage(link);
  if (!message) return null;
  const credential = credentialIn(await host.getCredentials());
  if (!credential) {
    host.log('info', 'a pasted Teams link was not read: the connection holds no sign-in that can be renewed');
    return null;
  }
  const graph = new Graph(host, config, credential);
  const answer = await graph.get(pathOf(message));
  if (!answer || typeof answer !== 'object') return null;
  const read = answer as GraphMessage;
  if (read.deletedDateTime) return null;
  const said = plainText(read.body);
  if (!said) return null;
  const sender = cutTo(text(read.from?.user?.displayName) || text(read.from?.application?.displayName), TITLE_LENGTH);
  return {
    sourceId: message.kind === 'chat' ? `${message.chatId}:${message.messageId}` : `${message.channelId}:${message.messageId}`,
    sender: sender || null,
    sentAt: timestamp(read.createdDateTime),
    capturedMessage: withTheNote(said, note.trim()),
  };
}

/** The Graph path of a linked message, each id encoded as one path segment. */
function pathOf(message: LinkedMessage): string {
  const e = encodeURIComponent;
  if (message.kind === 'chat') return `chats/${e(message.chatId)}/messages/${e(message.messageId)}`;
  const channel = `teams/${e(message.teamId)}/channels/${e(message.channelId)}/messages`;
  return message.parentId
    ? `${channel}/${e(message.parentId)}/replies/${e(message.messageId)}`
    : `${channel}/${e(message.messageId)}`;
}

/** What Graph answers of one chat message, as far as anything here reads it. */
interface GraphMessage {
  createdDateTime?: unknown;
  deletedDateTime?: unknown;
  body?: { content?: unknown; contentType?: unknown };
  from?: { user?: { displayName?: unknown } | null; application?: { displayName?: unknown } | null } | null;
}

/** An opened Teams credential: the token response Microsoft issued, as the host sealed it. */
interface TeamsCredential {
  readonly refreshToken: string;
  readonly accessToken: string | null;
  /** When the access token lapses, where a refresh here wrote it down; Microsoft's own answer says only how long from when. */
  readonly expiresAt: string | null;
  readonly rest: Readonly<Record<string, unknown>>;
}

function credentialIn(opened: Record<string, string>): TeamsCredential | null {
  try {
    const parsed: unknown = JSON.parse(opened.credential ?? '');
    if (!parsed || typeof parsed !== 'object') return null;
    const { refresh_token, access_token, expires_at, ...rest } = parsed as Record<string, unknown>;
    if (typeof refresh_token !== 'string' || !refresh_token) return null;
    return {
      refreshToken: refresh_token,
      accessToken: typeof access_token === 'string' && access_token ? access_token : null,
      expiresAt: typeof expires_at === 'string' && expires_at ? expires_at : null,
      rest,
    };
  } catch {
    return null;
  }
}

/** Each issuer's token endpoint, held for the life of the isolate: it changes on the order of years. Only an answer is held, never a failure. */
const tokenEndpoints = new Map<string, string>();

/** A token with less than this left is refreshed rather than used. */
const ACCESS_TOKEN_MARGIN_MS = 60_000;

class Graph {
  #credential: TeamsCredential;
  #token: string | null;
  readonly #origin: string;

  constructor(
    private readonly host: OnDemandHost,
    private readonly config: ReadingConfig,
    credential: TeamsCredential,
  ) {
    this.#credential = credential;
    this.#origin = (config.apiOrigin?.trim() || 'https://graph.microsoft.com').replace(/\/$/, '');
    // A token whose lapse is not known is refreshed first, as the Outlook connector does: the sealed answer says only how long it lasted from when it was issued.
    const lapses = credential.expiresAt ? Date.parse(credential.expiresAt) : NaN;
    this.#token =
      credential.accessToken && Number.isFinite(lapses) && lapses - ACCESS_TOKEN_MARGIN_MS > this.#now().getTime()
        ? credential.accessToken
        : null;
  }

  /** One read under `/v1.0/`, or null where it is not there, not allowed, or the sign-in is refused. */
  async get(path: string): Promise<unknown> {
    const refreshedHere = this.#token === null;
    let token = this.#token ?? (await this.#refresh());
    if (token === null) return null;
    let response = await this.#call(`${this.#origin}/v1.0/${path}`, token);
    if (response.status === 401 && !refreshedHere) {
      token = await this.#refresh();
      if (token === null) return null;
      response = await this.#call(`${this.#origin}/v1.0/${path}`, token);
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new SourceError(`Microsoft Graph answered ${response.status}`, response.status);
    }
    // Deleted, refused (another organisation, a grant withdrawn), or the sign-in itself: none passes by asking again.
    if (!response.ok) {
      this.host.log('info', `a pasted Teams link was not read: Graph answered ${response.status}`);
      return null;
    }
    return response.json().catch(() => null);
  }

  async #call(url: string, token: string): Promise<Response> {
    try {
      return await (this.config.fetch ?? fetch)(url, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new SourceError(NOT_ANSWERING);
    }
  }

  /** A new access token, handed back to the host before it is used; null where Microsoft refuses the sign-in. */
  async #refresh(): Promise<string | null> {
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(await this.#tokenEndpoint(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.#credential.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
      });
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(NOT_ANSWERING);
    }
    // Revoked, expired or withdrawn by an administrator: not this paste's to mend.
    if (response.status === 400 || response.status === 401) {
      this.host.log('info', 'a pasted Teams link was not read: Microsoft refused to renew the sign-in');
      return null;
    }
    if (!response.ok) throw new SourceError(`Microsoft answered ${response.status} to a refresh`, response.status);
    const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const accessToken = typeof answer?.access_token === 'string' ? answer.access_token : '';
    if (!accessToken) throw new SourceError('Microsoft answered a refresh with no access token');
    const lasts = typeof answer?.expires_in === 'number' && answer.expires_in > 0 ? answer.expires_in : 3600;
    const rotated = typeof answer?.refresh_token === 'string' && answer.refresh_token ? answer.refresh_token : this.#credential.refreshToken;
    this.#credential = {
      refreshToken: rotated,
      accessToken,
      expiresAt: new Date(this.#now().getTime() + lasts * 1000).toISOString(),
      rest: this.#credential.rest,
    };
    // Microsoft rotates the refresh token, so the new one is kept before the old is spent again.
    await this.host.setCredentials({
      credential: JSON.stringify({
        ...this.#credential.rest,
        refresh_token: this.#credential.refreshToken,
        access_token: this.#credential.accessToken,
        expires_at: this.#credential.expiresAt,
      }),
    });
    this.#token = accessToken;
    return accessToken;
  }

  async #tokenEndpoint(): Promise<string> {
    const issuer = (this.config.issuer?.trim() || MICROSOFT_ISSUER).replace(/\/$/, '');
    const known = tokenEndpoints.get(issuer);
    if (known) return known;
    let answer: Response;
    try {
      answer = await (this.config.fetch ?? fetch)(`${issuer}/.well-known/openid-configuration`);
    } catch {
      throw new SourceError(NOT_ANSWERING);
    }
    if (!answer.ok) throw new SourceError(`the issuer's discovery document could not be read: ${answer.status}`, answer.status);
    const document = (await answer.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof document?.token_endpoint !== 'string') throw new SourceError('the issuer names nowhere to renew a sign-in');
    tokenEndpoints.set(issuer, document.token_endpoint);
    return document.token_endpoint;
  }

  #now(): Date {
    return this.config.now?.() ?? new Date();
  }
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment).trim();
  } catch {
    return '';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
