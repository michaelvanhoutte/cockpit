import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { demoAddress } from '@cockpit/shared';
import type { ServerEvent, WorkspaceSnapshot } from '@cockpit/shared';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { GUEST_ACCOUNT_NAME } from '../../../src/auth/register.js';
import { seedRegister, startFromEmpty, storeNamed } from '../seed.js';
import { issuerIsReachable, issuerWillIdentify } from '../issuer.js';

/**
 * Integration level, through the real Worker: what is claimed is which
 * sign-ins send the guest a mail and a Teams message, and what the queue's
 * consumer then does to the guest account's own store ("Drop a mail and a
 * Teams message into the guest's Inbox after each sign-in", issue 775). The
 * queue's *timing* is held, as guest-runs.test.ts does, so no case waits
 * twenty seconds.
 */

const WORKSPACE = 'guest-ws-personal';

let held: { body: EnrichmentJob; delaySeconds: number | undefined }[] = [];
let realQueue: typeof env.ENRICHMENT;

function holdTheQueue(): void {
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob, options?: { delaySeconds?: number }) => {
      held.push({ body, delaySeconds: options?.delaySeconds });
    },
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
}

/** Delivers one held message through the real consumer; a retry fails the case, because a redelivery must never be asked for. */
async function deliver(message: { body: EnrichmentJob }): Promise<void> {
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          body: message.body,
          attempts: 1,
          ack: () => {},
          retry: () => {
            throw new Error(`a ${message.body.kind} was retried`);
          },
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
}

function sessionIn(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((one) => one.split(';')[0]!)
    .find((one) => one.startsWith('cockpit_session=') && !one.endsWith('='))!;
}

function continueAsGuest(cookie?: string): Promise<Response> {
  return SELF.fetch('http://cockpit.test/v1/sign-in/guest', {
    redirect: 'manual',
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

async function signInWithGoogle(): Promise<Response> {
  await issuerIsReachable();
  const start = await SELF.fetch('http://cockpit.test/v1/sign-in/google', { redirect: 'manual' });
  const asked = new URL(start.headers.get('location')!);
  issuerWillIdentify({ email: 'michael@example.com', nonce: asked.searchParams.get('nonce')! });
  return SELF.fetch(
    `http://cockpit.test/v1/sign-in/google/callback?${new URLSearchParams({ code: 'a-code', state: asked.searchParams.get('state')! })}`,
    { redirect: 'manual', headers: { cookie: start.headers.get('set-cookie')!.split(';')[0]! } },
  );
}

async function snapshotFor(cookie: string): Promise<WorkspaceSnapshot> {
  const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE}/snapshot`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

/** Where the account's change feed stands now, so what it reports afterwards is only what happened since. */
async function theFeedNow(): Promise<string> {
  const answer = await storeNamed(GUEST_ACCOUNT_NAME).changesSince(GUEST_ACCOUNT_NAME, new Date().toISOString());
  return (answer as { status: 'ok'; value: { cursor: string } }).value.cursor;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  holdTheQueue();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
});

describe('Sign-in', () => {
  describe('a fresh guest sign-in sends a mail and a Teams message, and no other sign-in sends any', () => {
    it('sends the two, about twenty and thirty seconds out, for a fresh guest sign-in', async () => {
      await continueAsGuest();

      expect(held.map((one) => [one.body.kind, 'source' in one.body ? one.body.source : null, one.delaySeconds])).toEqual([
        ['guest-arrival', 'gmail', 20],
        ['guest-arrival', 'teams', 30],
      ]);
    });

    it('sends none for a browser already signed in that presses Continue as guest', async () => {
      const first = await continueAsGuest();
      held = [];

      const again = await continueAsGuest(sessionIn(first));

      expect(again.headers.get('location')).toBe('/');
      expect(held).toEqual([]);
    });

    it('sends none for a named person signing in with Google', async () => {
      const back = await signInWithGoogle();

      expect(back.headers.get('location')).toBe('/');
      expect(held).toEqual([]);
    });
  });
});

describe('Inbox', () => {
  describe('what arrives for the guest lands in its Inbox, from its source, with its sender and address', () => {
    it.each([
      { situation: 'the mail', source: 'gmail', expected: { source: 'gmail', sender: 'Dr. Peeters Dental' } },
      { situation: 'the Teams message', source: 'teams', expected: { source: 'teams', sender: 'Nadia Peeters' } },
    ] as const)('puts $situation in the Inbox and tells the change feed', async ({ source, expected }) => {
      const cookie = sessionIn(await continueAsGuest());
      const before = await snapshotFor(cookie);
      const since = await theFeedNow();

      await deliver(held.find((one) => 'source' in one.body && one.body.source === source)!);

      const after = await snapshotFor(cookie);
      const inbox = after.items.filter((item) => !after.filings.some((filing) => filing.itemId === item.id));
      const arrived = inbox.filter((item) => !before.items.some((seen) => seen.id === item.id));
      expect(arrived).toHaveLength(1);
      expect(arrived[0]).toMatchObject({ ...expected, sourceLink: demoAddress(source) });
      const answer = await storeNamed(GUEST_ACCOUNT_NAME).changesSince(GUEST_ACCOUNT_NAME, since);
      const { events } = (answer as { status: 'ok'; value: { events: ServerEvent[] } }).value;
      expect(events.map((event) => event.workspaceId)).toContain(WORKSPACE);
    });
  });

  describe('an arrival is never sent for clean-up, and one delivered twice is captured once', () => {
    it('queues nothing for the Items that arrive', async () => {
      await continueAsGuest();
      const arrivals = [...held];
      held = [];

      for (const arrival of arrivals) await deliver(arrival);

      expect(held).toEqual([]);
    });

    it('captures one Item when the same message is consumed twice', async () => {
      const cookie = sessionIn(await continueAsGuest());
      const before = (await snapshotFor(cookie)).items.length;
      const mail = held[0]!;

      await deliver(mail);
      await deliver(mail);

      expect((await snapshotFor(cookie)).items.length).toBe(before + 1);
    });
  });

  describe('an arrival for a workspace that is gone is dropped without failing the queue', () => {
    it('captures nothing and does not ask for a retry when the workspace was deleted first', async () => {
      const cookie = sessionIn(await continueAsGuest());
      const gone = await SELF.fetch('http://cockpit.test/v1/commands/delete_workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          issuedAt: '2026-10-05T10:00:00.000Z',
          workspaceId: WORKSPACE,
        }),
      });
      expect(gone.status).toBe(200);

      await deliver(held[0]!);

      const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${WORKSPACE}/snapshot`, { headers: { cookie } });
      expect(res.status).toBe(404);
    });
  });
});
