import { describe, expect, it } from 'vitest';
import { SourceError, type OnDemandHost } from '@cockpit/connector-sdk';
import { NOTE_MARKER, createTeamsConnector } from '../../src/index.js';

/**
 * L1: the Teams connector reads the one message a pasted link names, through
 * Graph faked at the network ("Read pasted Teams links", issue 1755). Which
 * connections the host asks, and what it writes, is the API's
 * (apps/api/tests/integration/http/pasted-message-links.test.ts).
 */

const NOW = new Date('2026-11-13T10:00:00.000Z');
const ISSUER = 'https://issuer.test';
const GRAPH = 'https://graph.test';

const CHAT = '19:abc_def@unq.gbl.spaces';
const MEETING = '19:meeting_NjA2ZTk2@thread.v2';
const CHANNEL = '19:general@thread.tacv2';
const TEAM = '0f2a9c1e-5b7d-4e2a-9c3b-1a2b3c4d5e6f';

const chatLink = (chat: string, message = '1731490000000') =>
  `https://teams.microsoft.com/l/message/${encodeURIComponent(chat)}/${message}?context=%7B%22contextType%22%3A%22chat%22%7D`;
const channelLink = (message: string, parent?: string) =>
  `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/${message}?tenantId=t&groupId=${TEAM}${parent ? `&parentMessageId=${parent}` : ''}&teamName=Sales&channelName=General`;

/** A Graph chat message, as Graph answers one. */
function aMessage(body: { content: string; contentType: 'html' | 'text' }, from: string | null = 'Els Maes') {
  return {
    id: '1731490000000',
    createdDateTime: '2026-11-12T08:15:00Z',
    deletedDateTime: null,
    body,
    from: from === null ? null : { user: { displayName: from } },
  };
}

interface World {
  asked: string[];
  credential: Record<string, string>;
  saved: Record<string, string>[];
}

/** Graph and Microsoft's token endpoint on the network, answering `graph` for every Graph read. */
function teamsReading(options: { graph?: (url: string) => Response; refresh?: () => Response; credential?: Record<string, unknown> } = {}) {
  const world: World = {
    asked: [],
    credential: {
      credential: JSON.stringify(
        options.credential ?? { refresh_token: 'r-1', access_token: 'a-1', expires_at: '2026-11-13T11:00:00.000Z', scope: 'Chat.Read' },
      ),
    },
    saved: [],
  };
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    world.asked.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({ token_endpoint: `${ISSUER}/token` });
    if (url === `${ISSUER}/token`) {
      return options.refresh?.() ?? Response.json({ access_token: 'a-2', refresh_token: 'r-2', expires_in: 3600 });
    }
    if (url.startsWith(`${GRAPH}/v1.0/`)) return options.graph?.(url) ?? Response.json(aMessage({ content: 'Can you send me the Q3 numbers by Friday?', contentType: 'text' }));
    throw new Error(`the test tried to reach ${url}`);
  }) as typeof globalThis.fetch;
  const connector = createTeamsConnector({
    appId: 'a-bot',
    keys: async () => {
      throw new Error('no call is checked here');
    },
    issuer: ISSUER,
    apiOrigin: GRAPH,
    client: { id: 'cockpit', secret: 'secret' },
    fetch,
    now: () => NOW,
  });
  const host: OnDemandHost = {
    getCredentials: async () => world.credential,
    setCredentials: async (credentials) => {
      world.credential = credentials;
      world.saved.push(credentials);
    },
    getState: async () => null,
    log: () => {},
  };
  return {
    world,
    read: (link: string, note = '') => connector.readMessageAtLink!(host, link, note),
    grantToRead: (link: string) => connector.grantToRead!(link),
    graphAsked: () => world.asked.filter((url) => url.startsWith(GRAPH)).map((url) => decodeURIComponent(url.slice(`${GRAPH}/v1.0/`.length))),
  };
}

describe('Capture', () => {
  describe('the Teams connector reads the one message a pasted link names', () => {
    it.each([
      { situation: 'a 1:1 chat', chat: CHAT },
      { situation: 'a meeting chat', chat: MEETING },
    ])('$situation: asks for that chat’s message, and answers its text, sender and time', async ({ chat }) => {
      const teams = teamsReading();

      const read = await teams.read(chatLink(chat));

      expect(teams.graphAsked()).toEqual([`chats/${chat}/messages/1731490000000`]);
      expect(read).toEqual({
        sourceId: `${chat}:1731490000000`,
        sender: 'Els Maes',
        sentAt: '2026-11-12T08:15:00.000Z',
        capturedMessage: 'Can you send me the Q3 numbers by Friday?',
      });
    });

    it.each([
      { situation: 'a channel post', link: channelLink('1731490000001'), path: `teams/${TEAM}/channels/${CHANNEL}/messages/1731490000001` },
      {
        situation: 'a reply in a channel',
        link: channelLink('1731490000002', '1731490000001'),
        path: `teams/${TEAM}/channels/${CHANNEL}/messages/1731490000001/replies/1731490000002`,
      },
    ])('$situation: asks for it from the link’s team and channel', async ({ link, path }) => {
      const teams = teamsReading();

      expect(await teams.read(link)).not.toBeNull();

      expect(teams.graphAsked()).toEqual([path]);
    });

    it('answers a message written as HTML as plain text, as a Teams save makes it', async () => {
      const teams = teamsReading({
        graph: () => Response.json(aMessage({ content: '<p>Can you send me the <b>Q3</b> numbers?</p><p>Thanks &amp; regards</p>', contentType: 'html' })),
      });

      expect((await teams.read(chatLink(CHAT)))?.capturedMessage).toBe('Can you send me the Q3 numbers?\nThanks & regards');
    });

    it('writes your words after her message as a Teams save with a note writes them', async () => {
      const teams = teamsReading();

      expect((await teams.read(chatLink(CHAT), 'call her back Friday'))?.capturedMessage).toBe(
        `Can you send me the Q3 numbers by Friday?\n\n${NOTE_MARKER}\ncall her back Friday`,
      );
    });

    it('cuts a message too long to keep, and keeps your note whole', async () => {
      const teams = teamsReading({ graph: () => Response.json(aMessage({ content: 'x'.repeat(70_000), contentType: 'text' })) });

      const captured = (await teams.read(chatLink(CHAT), 'my note'))!.capturedMessage;

      expect(captured.length).toBeLessThanOrEqual(60_000);
      expect(captured.endsWith(`${NOTE_MARKER}\nmy note`)).toBe(true);
    });

    it('renews an expired sign-in first, and hands the renewed one back', async () => {
      const teams = teamsReading({ credential: { refresh_token: 'r-1', access_token: 'a-1', expires_in: 3599, scope: 'Chat.Read' } });

      expect(await teams.read(chatLink(CHAT))).not.toBeNull();

      expect(teams.world.saved).toHaveLength(1);
      expect(JSON.parse(teams.world.saved[0]!.credential!)).toMatchObject({ refresh_token: 'r-2', access_token: 'a-2', scope: 'Chat.Read' });
    });

    it('answers a personal Teams link as not readable, without asking Microsoft', async () => {
      const teams = teamsReading();
      const personal = 'https://teams.live.com/l/message/19:abc@thread.v2/1731490000000';

      expect(await teams.read(personal)).toBeNull();
      expect(teams.grantToRead(personal)).toBeNull();
      expect(teams.world.asked).toEqual([]);
    });

    it.each([
      { situation: 'a chat link', link: chatLink(CHAT), grant: 'chats' },
      { situation: 'a channel link', link: channelLink('1731490000001'), grant: 'channels' },
    ])('says $situation needs a connection granted $grant', ({ link, grant }) => {
      expect(teamsReading().grantToRead(link)).toBe(grant);
    });
  });

  describe('a message Teams will not give is not readable, and Teams not answering is said so', () => {
    it.each([
      { situation: 'deleted', status: 404 },
      { situation: 'refused, another organisation’s', status: 403 },
    ])('$situation: not readable', async ({ status }) => {
      // Whatever the answer carries: the status decides.
      const teams = teamsReading({ graph: () => Response.json(aMessage({ content: 'not yours', contentType: 'text' }), { status }) });

      expect(await teams.read(chatLink(CHAT))).toBeNull();
    });

    it('a sign-in Microsoft will not renew: not readable', async () => {
      const teams = teamsReading({
        credential: { refresh_token: 'r-1', access_token: 'a-1' },
        refresh: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
      });

      expect(await teams.read(chatLink(CHAT))).toBeNull();
    });

    it.each([
      { situation: 'busy', status: 429 },
      { situation: 'down', status: 503 },
    ])('Microsoft $situation: says Teams did not answer, for another try', async ({ status }) => {
      const teams = teamsReading({ graph: () => new Response('{}', { status }) });

      await expect(teams.read(chatLink(CHAT))).rejects.toBeInstanceOf(SourceError);
    });
  });
});
