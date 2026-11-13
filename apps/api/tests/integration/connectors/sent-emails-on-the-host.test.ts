import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import type { SentEmails } from '@cockpit/shared/sent-emails';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { ACCOUNT_NAME, WORKSPACE_ID, alsoWorkspaces, asUser, inTheStore, seedRegister, signInAs, startFromEmpty } from '../seed.js';
import { gmailAnswersWith, gmailCalls, gmailHolds, issuerIsForgotten, issuerIsReachable, issuerWillIdentify } from '../issuer.js';
import { graphCalls, graphHolds } from '../graph.js';
import { labelsAnswer, message, threadAnswer } from '../../../../../packages/connectors/gmail/tests/gmail-payloads.js';
import { SENT_ITEMS_ID, type MessageOptions } from '../../../../../packages/connectors/outlook/tests/graph-payloads.js';

/**
 * Integration level: *Follow a sent email…* through the real routes and store,
 * Gmail and Outlook faked at the network (`../issuer.ts`, `../graph.ts`), from
 * the shapes each documents ("Follow a sent email… in Capture", issue 1710).
 * What is under test is the Worker's and the store's: the newest ten of every
 * mailbox of the Workspace together, a mailbox that fails named beside the rest,
 * another Workspace's connections never reached, and a pick making one Item
 * Waiting for reply. How each source lists its sent mail is the connector's
 * (packages/connectors/*\/tests/unit/listing-sent-emails.test.ts).
 */

const GOOGLE = { email: 'anna@example.com', subject: 'google-anna' };
const MICROSOFT = { email: 'anna@example.com', tenant: 'tenant-of-anna', object: 'object-of-anna' };

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

const now = () => new Date(); // clock-ok: a queue message and a person's change are stamped by the real clock

function takeQueuedChecks(): EnrichmentJob[] {
  const checks = held.filter((job) => job.kind === 'check-a-pulled-connection');
  held = held.filter((job) => job.kind !== 'check-a-pulled-connection');
  return checks;
}

async function deliver(body: EnrichmentJob): Promise<void> {
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [{ id: crypto.randomUUID(), timestamp: now(), body, attempts: 1, ack: () => {}, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
}

/** The check connecting queues - set for now, so it fires by itself - delivered. */
async function firstCheckRuns(): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const checks = takeQueuedChecks();
    if (checks.length > 0) {
      for (const check of checks) await deliver(check);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** The whole trip through the source's sign-in for a connection following the star (Gmail) or the flag (Outlook). */
async function connect(connector: 'gmail' | 'outlook'): Promise<void> {
  const session = await signInAs();
  const choice = connector === 'gmail' ? 'star' : 'flag';
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/${connector}/connect?choice=${choice}&filesByName=false`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify(
    { ...(connector === 'gmail' ? GOOGLE : MICROSOFT), nonce: asked.searchParams.get('nonce')! },
    `a-code-for-${connector}`,
    connector === 'gmail'
      ? {
          refresh_token: 'anna-refresh',
          access_token: 'access-for-anna',
          expires_in: 3599,
          scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify',
        }
      : {
          refresh_token: 'anna-refresh-at-microsoft',
          access_token: 'access-for-anna-at-microsoft',
          expires_in: 3599,
          scope: 'openid email profile offline_access Mail.ReadWrite',
        },
  );
  await SELF.fetch(`http://cockpit.test/v1/connections/${connector}/callback?code=a-code-for-${connector}&state=${asked.searchParams.get('state')}`, {
    redirect: 'manual',
    headers: { cookie: `${session}; ${attempt}` },
  });
  await firstCheckRuns();
}

/** What Gmail holds: emails sent from the mailbox, each in a conversation of its own. */
function gmailSent(sent: readonly { id: string; subject: string; to: string; at: string; text?: string }[]): void {
  const threads = sent.map((one) => {
    const email = message(one.id, {
      id: one.id,
      sentAt: one.at,
      subject: one.subject,
      to: one.to,
      from: 'Anna Peeters <anna@example.com>',
      plain: one.text ?? `The text of ${one.id}.`,
      labelled: false,
    });
    email.labelIds = ['SENT'];
    return { id: one.id, labelled: false, answer: threadAnswer(one.id, [email]) };
  });
  gmailHolds({ labels: labelsAnswer(), historyId: '100', threads, history: [], historyLapsed: false });
}

/** What Outlook holds in Sent Items. */
function outlookSent(sent: readonly { id: string; subject: string; to: string; at: string; text?: string }[]): void {
  graphHolds(
    sent.map(
      (one): MessageOptions => ({
        id: one.id,
        folder: SENT_ITEMS_ID,
        subject: one.subject,
        text: one.text ?? `The text of ${one.id}.`,
        to: [{ name: one.to, address: 'someone@example.com' }],
        receivedAt: one.at,
        conversation: `conversation-${one.id}`,
      }),
    ),
  );
}

async function listed(workspaceId: string = WORKSPACE_ID): Promise<{ status: number; body: SentEmails }> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/sent-emails`);
  return { status: res.status, body: (await res.json()) as SentEmails };
}

type Entry = SentEmails['emails'][number];

/** A sent email picked: what the list showed, filed as Capture's *Where* and *File on* have it. */
function picked(entry: Entry, extra: { decided?: boolean; panelIds?: string[] } = {}): Promise<Response> {
  return asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/sent-emails/follow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sourceAccountId: entry.sourceAccountId,
      conversationId: entry.conversationId,
      subject: entry.subject,
      to: entry.to,
      sentAt: entry.sentAt,
      link: entry.link,
      excerpt: entry.excerpt,
      decided: extra.decided ?? true,
      ...(extra.panelIds ? { panelIds: extra.panelIds } : {}),
    }),
  });
}

async function opened(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
  await issuerIsReachable();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  issuerIsForgotten();
});

const SENT_TWELVE = Array.from({ length: 12 }, (_, n) => ({
  id: `g-${n + 1}`,
  subject: `Mail ${n + 1}`,
  to: 'Marc Lambrecht <marc@example.com>',
  at: `2026-10-${String(n + 1).padStart(2, '0')}T09:00:00Z`,
}));

describe('Triage', () => {
  describe('Follow a sent email… lists the newest ten sent from the Workspace’s mailboxes', () => {
    it('lists a Gmail mailbox’s last ten, newest first, each with who it went to and when', async () => {
      gmailSent(SENT_TWELVE);
      await connect('gmail');

      const { status, body } = await listed();

      expect(status).toBe(200);
      expect(body.failing).toEqual([]);
      expect(body.emails.map((one) => one.subject)).toEqual(
        ['Mail 12', 'Mail 11', 'Mail 10', 'Mail 9', 'Mail 8', 'Mail 7', 'Mail 6', 'Mail 5', 'Mail 4', 'Mail 3'],
      );
      expect(body.emails[0]).toEqual(
        expect.objectContaining({
          connectorId: 'gmail',
          conversationId: 'g-12',
          to: 'Marc Lambrecht',
          sentAt: '2026-10-12T09:00:00.000Z',
          link: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/g-12',
        }),
      );
    });

    it('lists the newest ten of a Gmail and an Outlook mailbox together', async () => {
      gmailSent(SENT_TWELVE.slice(0, 6));
      graphHolds([]);
      await connect('gmail');
      await connect('outlook');
      outlookSent(
        ['04', '07', '09', '11', '13'].map((day) => ({ id: `o-${day}`, subject: `Outlook ${day}`, to: 'Sofie Maes', at: `2026-10-${day}T12:00:00Z` })),
      );

      const { body } = await listed();

      // Gmail sent days 1 to 6; Outlook days 4, 7, 9, 11 and 13: eleven in all, ten shown.
      expect(body.emails.map((one) => one.subject)).toEqual([
        'Outlook 13',
        'Outlook 11',
        'Outlook 09',
        'Outlook 07',
        'Mail 6',
        'Mail 5',
        'Outlook 04',
        'Mail 4',
        'Mail 3',
        'Mail 2',
      ]);
      expect(new Set(body.emails.map((one) => one.connectorId))).toEqual(new Set(['gmail', 'outlook']));
      expect(body.failing).toEqual([]);
    });

    it('lists the others and names the mailbox that failed halfway, and why', async () => {
      gmailSent(SENT_TWELVE.slice(0, 3));
      graphHolds([]);
      await connect('gmail');
      await connect('outlook');
      outlookSent([{ id: 'o-1', subject: 'Outlook one', to: 'Sofie Maes', at: '2026-10-09T12:00:00Z' }]);
      gmailAnswersWith(503, (call) => call.startsWith('messages?labelIds=SENT'), { once: false });

      const { status, body } = await listed();

      expect(status).toBe(200);
      expect(body.emails.map((one) => one.subject)).toEqual(['Outlook one']);
      expect(body.failing).toEqual([{ mailbox: expect.any(String), why: 'Gmail did not answer. Try again in a moment.' }]);
    });

    it('never lists, nor reaches, another Workspace’s connections', async () => {
      await alsoWorkspaces();
      gmailSent(SENT_TWELVE.slice(0, 3));
      await connect('gmail');
      gmailCalls.length = 0;
      graphCalls.length = 0;

      const other = await listed('ws-atlas');

      expect(other).toEqual({ status: 200, body: { emails: [], failing: [] } });
      expect(gmailCalls).toEqual([]);
    });

    it('says whether a Workspace has a mailbox to list, for Capture’s entry, without asking any source', async () => {
      const available = async (workspaceId: string) =>
        (await (await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/sent-emails/available`)).json()) as { available: boolean };
      await alsoWorkspaces();
      expect(await available(WORKSPACE_ID)).toEqual({ available: false });
      gmailSent(SENT_TWELVE.slice(0, 1));
      await connect('gmail');
      gmailCalls.length = 0;

      expect(await available(WORKSPACE_ID)).toEqual({ available: true });
      expect(await available('ws-atlas')).toEqual({ available: false });
      expect(gmailCalls).toEqual([]);
    });

    it('lists nothing for a Workspace with no mail connection', async () => {
      const { status, body } = await listed();

      expect(status).toBe(200);
      expect(body).toEqual({ emails: [], failing: [] });
    });
  });

  describe('Picking a sent email makes one Item, Waiting for reply, that follows its conversation', () => {
    it('makes one Item titled with the subject, Waiting since today, following the sent email’s conversation', async () => {
      gmailSent(SENT_TWELVE.slice(0, 3));
      await connect('gmail');
      const [first] = (await listed()).body.emails;

      const res = await picked(first!);

      expect(res.status).toBe(200);
      const { itemId, made } = (await res.json()) as { itemId: string; made: boolean };
      expect(made).toBe(true);
      const read = await opened();
      const item = read.items.find((one) => one.id === itemId)!;
      expect(item.title).toBe('Mail 3');
      expect(item.waitingSince?.slice(0, 10)).toBe(now().toISOString().slice(0, 10));
      expect(item.completedAt).toBeNull();
      expect((read.conversations ?? []).filter((one) => one.itemId === itemId)).toEqual([
        expect.objectContaining({
          source: 'gmail',
          conversationId: 'g-3',
          lastBy: 'you',
          withWhom: 'Marc Lambrecht',
          link: first!.link,
        }),
      ]);
    });

    it('makes one Item for the same pick sent twice', async () => {
      gmailSent(SENT_TWELVE.slice(0, 3));
      await connect('gmail');
      const [first] = (await listed()).body.emails;

      const once = (await (await picked(first!)).json()) as { itemId: string; made: boolean };
      const again = (await (await picked(first!)).json()) as { itemId: string; made: boolean };

      expect(again).toEqual({ itemId: once.itemId, made: false });
      expect((await opened()).items.filter((one) => one.title === 'Mail 3')).toHaveLength(1);
    });

    it('answers the open Item that already follows the conversation, and makes none', async () => {
      gmailSent(SENT_TWELVE.slice(0, 3));
      await connect('gmail');
      const [first] = (await listed()).body.emails;
      const already = crypto.randomUUID();
      const res0 = await asUser('http://cockpit.test/v1/commands/capture_item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commandId: crypto.randomUUID(), issuedAt: now().toISOString(), workspaceId: WORKSPACE_ID, itemId: already, message: 'Plan the electrician' }),
      });
      expect(res0.status).toBe(200);
      await inTheStore((sql) => {
        const { key } = sql.exec(`SELECT external_account_key AS key FROM connector_accounts WHERE id = ?`, first!.sourceAccountId).toArray()[0] as { key: string };
        sql.exec(
          `INSERT INTO item_conversations (tenant_id, item_id, connector_id, external_account_key, conversation_id, link, last_by, last_at, last_excerpt, message_count, started_at)
           VALUES (?, ?, 'gmail', ?, 'g-3', 'https://mail.google.com/mail/?authuser=x#all/g-3', 'them', '2026-10-01T09:00:00.000Z', 'Hello', 2, '2026-10-01T08:00:00.000Z')`,
          ACCOUNT_NAME,
          already,
          key,
        );
      });
      const titlesBefore = (await opened()).items.length;

      const res = await picked(first!);

      expect(await res.json()).toEqual({ itemId: already, made: false });
      expect((await opened()).items).toHaveLength(titlesBefore);
    });

    it('files it on the Panels it was picked for, as Capture’s File on files a note', async () => {
      gmailSent(SENT_TWELVE.slice(0, 3));
      await connect('gmail');
      const [first] = (await listed()).body.emails;
      const panel = (await opened()).panels.find((one) => one.kind === 'items')!;

      const { itemId } = (await (await picked(first!, { panelIds: [panel.id] })).json()) as { itemId: string };

      const read = await opened();
      expect(read.filings.filter((one) => one.itemId === itemId).map((one) => one.panelId)).toEqual([panel.id]);
    });

    it('is refused for a connection of this Workspace that does not list sent mail, and makes no Item', async () => {
      gmailSent(SENT_TWELVE.slice(0, 3));
      await connect('gmail');
      const [first] = (await listed()).body.emails;
      const before = (await opened()).items.length;

      const res = await picked({ ...first!, sourceAccountId: 'no-such-connection' });

      expect(res.status).toBe(404);
      expect((await opened()).items).toHaveLength(before);
    });

    it('refuses a link that is not an https address, since Open ↗ would follow it', async () => {
      gmailSent(SENT_TWELVE.slice(0, 3));
      await connect('gmail');
      const [first] = (await listed()).body.emails;

      const res = await picked({ ...first!, link: 'javascript:alert(1)' });

      expect(res.status).toBe(400);
    });
  });
});

