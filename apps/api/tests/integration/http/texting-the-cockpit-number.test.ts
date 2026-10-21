import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { ConnectionHistoryLine, Item } from '@cockpit/shared';
import {
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  besidesTheGuide,
  seedRegister,
  startFromEmpty,
} from '../seed.js';
import { issuerIsForgotten, issuerIsReachable } from '../issuer.js';
import { THE_CODE } from '../verify.js';

/**
 * Integration level, through the real Worker, register and account store,
 * because what is being asked is the wiring: one address every connected phone
 * shares, a register that says whose a number is, a store that confirms it, and
 * an Item that comes out the other end ("Text the Cockpit number and the note
 * lands in the Inbox", issue 1336). Which requests count as signed, and the
 * one pass deciding a text, is the connector's L1
 * (packages/connectors/twilio/tests/unit/hearing-a-text.test.ts). Texts are
 * signed here with Node's own HMAC, as Twilio would sign them; the phone is
 * connected the way Settings connects it, through Verify faked at the network
 * boundary (../verify.ts).
 *
 * **This is the coverage ceiling for hearing a text**: no browser can send one,
 * so what stands in for it is a signed request at the real address and the Item
 * read back through the application's own read.
 */

const OTHER_WORKSPACE_ID = 'ws-atlas';
const NUMBER = '+32470123456';
const SECOND_NUMBER = '+32486123456';
const ADDRESS = 'http://cockpit.test/ingress/twilio/sms';
const TOKEN = 'a-token-that-proves-nothing-here';

const settings = env as unknown as Record<string, string | undefined>;
const TWILIO = {
  TWILIO_ACCOUNT_SID: 'AC-the-test-account',
  TWILIO_AUTH_TOKEN: TOKEN,
  TWILIO_VERIFY_SERVICE_SID: 'VA-the-test-service',
  TWILIO_NUMBER: '+32460000000',
};

const connectionsOf = (workspaceId: string) => `http://cockpit.test/v1/workspaces/${workspaceId}/connections`;
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Connecting a phone the way Settings does: ask for a code, type it back. */
async function connectPhone(number = NUMBER, workspaceId = WORKSPACE_ID, userId = USER_ID): Promise<void> {
  const sent = await asUser(`${connectionsOf(workspaceId)}/twilio/phone/code`, post({ number }), userId);
  expect(sent.status).toBe(200);
  const confirmed = await asUser(
    `${connectionsOf(workspaceId)}/twilio/phone/confirm`,
    post({ number, code: THE_CODE }),
    userId,
  );
  expect(confirmed.status).toBe(200);
}

let sid = 0;
const aSid = () => `SM${String((sid += 1)).padStart(4, '0')}`;

/** What Twilio sends for a text. */
const aText = (params: Record<string, string> = {}): Record<string, string> => ({
  MessageSid: aSid(),
  AccountSid: TWILIO.TWILIO_ACCOUNT_SID,
  From: NUMBER,
  To: TWILIO.TWILIO_NUMBER,
  Body: 'call the plumber',
  NumMedia: '0',
  ...params,
});

function signedWith(token: string, params: Record<string, string>): string {
  const text = ADDRESS + Object.keys(params).sort().map((name) => name + params[name]).join('');
  return createHmac('sha1', token).update(text).digest('base64');
}

/** A text delivered as Twilio delivers it: a signed form post. */
function delivered(params: Record<string, string>, signature: string | null = signedWith(TOKEN, params)): Promise<Response> {
  return SELF.fetch(ADDRESS, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(signature === null ? {} : { 'x-twilio-signature': signature }),
    },
    body: new URLSearchParams(params).toString(),
  });
}

/** What the Inbox of a Workspace would show: its Items as the application reads them, those the account arrived with aside. */
async function itemsIn(workspaceId = WORKSPACE_ID, userId = USER_ID): Promise<Item[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`, {}, userId);
  expect(res.status).toBe(200);
  return besidesTheGuide(((await res.json()) as { items: Item[] }).items);
}

async function connectionIn(workspaceId = WORKSPACE_ID, userId = USER_ID): Promise<string> {
  const res = await asUser(connectionsOf(workspaceId), {}, userId);
  const [connected] = ((await res.json()) as { sourceAccounts: { id: string }[] }).sourceAccounts;
  return connected!.id;
}

async function historyOf(sourceAccountId: string, workspaceId = WORKSPACE_ID): Promise<ConnectionHistoryLine[]> {
  const res = await asUser(`${connectionsOf(workspaceId)}/${sourceAccountId}/history`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { lines: ConnectionHistoryLine[] }).lines;
}

const EMPTY_REPLY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  Object.assign(settings, TWILIO);
  await issuerIsReachable();
});

afterEach(() => {
  for (const name of Object.keys(TWILIO)) delete settings[name];
  vi.restoreAllMocks();
  issuerIsForgotten();
});

describe('Capture', () => {
  describe('a text from a connected phone becomes an Item on Any workspace, from Text message, holding its words', () => {
    it('lands in every Workspace’s Inbox, from the one the phone was connected from, with no sender', async () => {
      await connectPhone();

      const answer = await delivered(aText());

      expect(answer.status).toBe(200);
      for (const workspace of [WORKSPACE_ID, OTHER_WORKSPACE_ID]) {
        const items = await itemsIn(workspace);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          source: 'twilio',
          sender: null,
          sourceLink: null,
          capturedMessage: 'call the plumber',
          title: 'call the plumber',
          workspaceDecided: false,
          workspaceId: WORKSPACE_ID,
          priority: null,
          dueDate: null,
        });
      }
    });

    it('is called Text message in the names the Workspace carries, where the entry is Text messages', async () => {
      const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
      const { sourceNames } = (await res.json()) as { sourceNames: Record<string, string> };

      expect(sourceNames.twilio).toBe('Text message');
    });

    it('captures a long multi-part text whole', async () => {
      await connectPhone();
      const long = `${'a long thought, '.repeat(106)}end`;
      expect(long.length).toBeGreaterThan(1_600);

      await delivered(aText({ Body: long }));

      const [item] = await itemsIn();
      expect(item!.capturedMessage).toBe(long);
    });

    it('files nothing for a text with no words, writes a Failed line on the connection, and still answers Twilio', async () => {
      await connectPhone();

      const answer = await delivered(aText({ Body: '   ' }));

      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe(EMPTY_REPLY);
      expect(await itemsIn()).toEqual([]);
      const [line, ...others] = await historyOf(await connectionIn());
      expect(others).toEqual([]);
      expect(line).toMatchObject({ outcome: 'failed', reason: 'delivery' });
      expect(line!.message).toMatch(/no words/);
    });
  });

  describe('a text lands once, however often Twilio delivers it', () => {
    it('makes one Item and one line of history of the same message delivered twice, and answers both', async () => {
      await connectPhone();
      const text = aText();

      const first = await delivered(text);
      const again = await delivered(text);

      expect([first.status, again.status]).toEqual([200, 200]);
      expect(await itemsIn()).toHaveLength(1);
      const [line, ...others] = await historyOf(await connectionIn());
      expect(others).toEqual([]);
      expect(line).toMatchObject({ outcome: 'worked', reason: 'delivery', count: 1 });
      expect(line!.did.broughtIn.count).toBe(1);
    });

    it('makes two Items of two messages with the same words', async () => {
      await connectPhone();

      await delivered(aText());
      await delivered(aText());

      expect(await itemsIn()).toHaveLength(2);
    });
  });

  describe('only texts Twilio signed are heard', () => {
    it.each([
      { situation: 'an unsigned request', signed: () => null },
      { situation: 'a request signed with another token', signed: (text: Record<string, string>) => signedWith('another-token', text) },
    ])('refuses $situation with 403, and captures nothing', async ({ signed }) => {
      await connectPhone();
      const text = aText();

      const answer = await delivered(text, signed(text));

      expect(answer.status).toBe(403);
      expect(await itemsIn()).toEqual([]);
      expect(await historyOf(await connectionIn())).toEqual([]);
    });
  });

  describe('a text from a phone nobody connected is dropped', () => {
    async function logsWhile(work: () => Promise<void>): Promise<string> {
      const spy = vi.spyOn(console, 'log');
      await work();
      return spy.mock.calls.map((call) => String(call[0])).join('\n');
    }

    it('files nothing, writes no line, and logs the reason with only the last four digits', async () => {
      await connectPhone();

      let answer!: Response;
      const logged = await logsWhile(async () => {
        answer = await delivered(aText({ From: '+32499987654' }));
      });

      expect(answer.status).toBe(200);
      expect(await itemsIn()).toEqual([]);
      expect(await historyOf(await connectionIn())).toEqual([]);
      expect(logged).toContain('nobody has connected');
      expect(logged).toContain('7654');
      expect(logged).not.toContain('99987654');
      expect(logged).not.toContain('+32499');
    });

    it('drops a text from a phone since disconnected, in the same way', async () => {
      await connectPhone();
      const connection = await connectionIn();
      await asUser('http://cockpit.test/v1/commands/disconnect_source_account', post({
        commandId: '0195c0f6-0000-7000-8000-000000000101',
        issuedAt: new Date().toISOString(),
        workspaceId: WORKSPACE_ID,
        sourceAccountId: connection,
      }));

      let answer!: Response;
      const logged = await logsWhile(async () => {
        answer = await delivered(aText());
      });

      expect(answer.status).toBe(200);
      expect(await itemsIn()).toEqual([]);
      expect(logged).toContain('nobody has connected');
      expect(logged).toContain('3456');
      expect(logged).not.toContain(NUMBER);
    });

    it('does not connect a phone by being texted from it', async () => {
      const answer = await delivered(aText({ From: SECOND_NUMBER }));

      expect(answer.status).toBe(200);
      const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM connector_directory').first<{ n: number }>();
      expect(rows!.n).toBe(0);
    });
  });

  describe('every signed text is answered with nothing to send', () => {
    it.each([
      { situation: 'a captured text', send: async () => (await connectPhone(), aText()) },
      {
        situation: 'a repeated text',
        send: async () => {
          await connectPhone();
          const text = aText();
          await delivered(text);
          return text;
        },
      },
      { situation: 'a dropped text', send: async () => aText({ From: SECOND_NUMBER }) },
    ])('answers $situation 200 with an empty reply', async ({ send }) => {
      const text = await send();

      const answer = await delivered(text);

      expect(answer.status).toBe(200);
      expect(answer.headers.get('content-type')).toContain('xml');
      expect(await answer.text()).toBe(EMPTY_REPLY);
    });

    it('texts nothing back through Twilio', async () => {
      await connectPhone();
      const calls = vi.spyOn(globalThis, 'fetch');

      await delivered(aText());

      expect(calls.mock.calls.filter(([target]) => String(target).includes('twilio.com'))).toEqual([]);
    });
  });

  describe('a phone connected in two accounts texts into the one it was connected to last', () => {
    it('lands the text in the later account only', async () => {
      await connectPhone();
      const adasWorkspace = await asUser('http://cockpit.test/v1/workspaces', {}, OTHER_USER_ID)
        .then((res) => res.json() as Promise<{ workspaces: { id: string }[] }>)
        .then((read) => read.workspaces[0]!.id);
      await connectPhone(NUMBER, adasWorkspace, OTHER_USER_ID);

      await delivered(aText());

      expect(await itemsIn(adasWorkspace, OTHER_USER_ID)).toHaveLength(1);
      expect(await itemsIn()).toEqual([]);
    });
  });

  describe('an environment without Twilio configured has no texting door', () => {
    it.each(Object.keys(TWILIO).map((name) => ({ situation: `${name} is not set`, name })))(
      'answers 404 where $situation, and captures nothing',
      async ({ name }) => {
        await connectPhone();
        delete settings[name];

        const answer = await delivered(aText());

        expect(answer.status).toBe(404);
        expect(await itemsIn()).toEqual([]);
      },
    );
  });
});
