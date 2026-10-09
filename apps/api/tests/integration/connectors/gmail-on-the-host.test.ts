import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { seal, sealingKey } from '../../../src/connectors/credential-crypto.js';
import { ACCOUNT_NAME, WORKSPACE_ID, asUser, seedRegister, signInAs, startFromEmpty, storeNamed } from '../seed.js';
import {
  gmailCalls,
  gmailHolds,
  issuerIsForgotten,
  issuerIsReachable,
  issuerWillIdentify,
  refreshes,
} from '../issuer.js';
import { labelsAnswer, plainThread } from '../../../../../packages/connectors/gmail/tests/gmail-payloads.js';

/**
 * Integration level: Gmail registered in this environment and run by the
 * generic host - its sign-in through the generic connect routes, its checks
 * queued by the account's alarm and run by the Worker's queue consumer, both
 * against the real store ("Switch Gmail onto the generic host, and take it out
 * of the core", issue 944). Google and Gmail are faked at the network
 * (`../issuer.ts`). How Gmail behaves - what a label taken off does, a lapsed
 * history, a refused change - is the connector package's to prove against its
 * own fake host, and is not re-proved here; the host's own rules are
 * pulled-checks.test.ts's, against a scripted source.
 *
 * **The queue is held**, so each case delivers what the alarm queued through
 * the real consumer itself.
 */

/** The address a mailbox belongs to, and the key Google names it by. */
const ANNA = { email: 'anna@example.com', subject: 'google-anna' };

/** The free plan's ceilings per invocation (docs/deployment.md, "The environments"): calls out, and calls to Cloudflare's own services. */
const OUTBOUND_LIMIT = 50;
const INTERNAL_LIMIT = 1_000;

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

function holdTheQueue(): void {
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
}

function queuedChecks(): EnrichmentJob[] {
  return held.filter((job) => job.kind === 'check-a-pulled-connection');
}

/** Waits for the check the alarm queues - set for now, so it fires by itself. */
async function aCheckIsQueued(): Promise<EnrichmentJob> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const [check] = queuedChecks();
    if (check) {
      held = held.filter((job) => job !== check);
      return check;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no check was ever queued');
}

/** Delivers one message through the real consumer, under `under` in place of the Worker's own bindings. */
async function deliver(body: EnrichmentJob, under: typeof env = env): Promise<void> {
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [{ id: crypto.randomUUID(), timestamp: new Date(), body, attempts: 1, ack: () => {}, retry: () => {} }],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    under,
  );
}

/** A Gmail connection as the core's own Connect stored it: its sign-in in the core's shape, and no choice. */
async function connectedTheOldWay(): Promise<string> {
  const key = await sealingKey(env.CONNECTOR_CREDENTIAL_KEY);
  const sealed = await seal(
    JSON.stringify({ mailboxKey: ANNA.subject, refreshToken: 'anna-old-refresh', accessToken: null, accessTokenExpiresAt: null }),
    key!,
  );
  const answer = await storeNamed(ACCOUNT_NAME).applyChange(ACCOUNT_NAME, 'connect_source_account', {
    commandId: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    workspaceId: WORKSPACE_ID,
    sourceAccountId: crypto.randomUUID(),
    connectorId: 'gmail',
    externalAccountKey: ANNA.subject,
    displayName: ANNA.email,
    ...sealed,
  });
  expect(answer.status).toBe('ok');
  return (await gmailRow())!.id;
}

/** Connect on the Gmail card or Reconnect on its row, picking the label: the whole trip a browser makes through Google. */
async function signInThroughGoogle(): Promise<void> {
  const session = await signInAs();
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/gmail/connect?choice=label`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify({ ...ANNA, nonce: asked.searchParams.get('nonce')! }, 'a-code', {
    refresh_token: 'anna-refresh',
    access_token: 'access-for-anna',
    expires_in: 3599,
    scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify',
  });
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/gmail/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
}

interface ConnectionRow {
  id: string;
  connectorId: string;
  failingBecause: string | null;
  follows?: string;
}

async function gmailRow(): Promise<ConnectionRow | undefined> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sourceAccounts: ConnectionRow[] }).sourceAccounts.find((row) => row.connectorId === 'gmail');
}

async function gmailItems(): Promise<{ title: string; typeId: string; sourceId: string | null }[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  const snapshot = (await res.json()) as {
    items: { title: string; typeId: string; sourceId: string | null; source: string }[];
    itemTypes?: { id: string; name: string }[];
  };
  return snapshot.items.filter((item) => item.source === 'gmail');
}

/**
 * Counts what a run asks of the world while it runs, under bindings that pass
 * every call through: each call out (`fetch`), and each call to the account's
 * store, the register and the queue - the two budgets a Worker invocation has.
 */
function counted(): { under: typeof env; outbound: () => number; internal: () => number } {
  let outbound = 0;
  let internal = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    outbound += 1;
    return realFetch(...args);
  }) as typeof fetch;
  const counting = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(on, property) {
        const value = Reflect.get(on, property) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          internal += 1;
          // `Reflect.apply`, since a store's stub answers any property - `apply` included - as a call to the store.
          return Reflect.apply(value as (...a: unknown[]) => unknown, on, args);
        };
      },
    });
  const under = {
    ...env,
    ACCOUNT: {
      idFromName: (name: string) => env.ACCOUNT.idFromName(name),
      get: (id: DurableObjectId) => counting(env.ACCOUNT.get(id)),
    } as unknown as typeof env.ACCOUNT,
    DB: counting(env.DB),
    ENRICHMENT: counting(env.ENRICHMENT),
  } as typeof env;
  return {
    under,
    outbound: () => {
      globalThis.fetch = realFetch;
      return outbound;
    },
    internal: () => internal,
  };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  held = [];
  holdTheQueue();
  await issuerIsReachable();
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
  issuerIsForgotten();
});

describe('Connector management', () => {
  describe('a Gmail connection made before Gmail moved reads as needing a reconnect, and reconnecting it checks it the new way', () => {
    it('reads nothing of the old sign-in, then brings in a labelled conversation as a titled Task once reconnected', async () => {
      gmailHolds({ labels: labelsAnswer(), historyId: '777', threads: [], history: [], historyLapsed: false });
      const id = await connectedTheOldWay();

      // Its check before a reconnect: no sign-in it can read, nothing filed, nothing asked of Gmail.
      await deliver(await aCheckIsQueued());
      expect((await gmailRow())?.failingBecause).toMatch(/Connect again/);
      expect(gmailCalls).toEqual([]);
      expect(refreshes).toEqual([]);

      gmailHolds({ threads: [{ id: 'thread-1', labelled: true, answer: plainThread('thread-1', 'Invoice 42') }] });
      await signInThroughGoogle();

      // The same row, now holding the label, and no longer failing.
      expect(await gmailRow()).toMatchObject({ id, follows: 'label', failingBecause: null });
      // Queued by the alarm, which itself asked nothing of Google or Gmail.
      const check = await aCheckIsQueued();
      expect(gmailCalls).toEqual([]);
      expect(refreshes).toEqual([]);

      await deliver(check);

      expect(await gmailItems()).toEqual([expect.objectContaining({ title: 'Invoice 42', sourceId: 'thread-1' })]);
      expect(await gmailRow()).toMatchObject({ failingBecause: null });
    });
  });

  describe('a Gmail check bringing in a busy mailbox stays within what one run may ask of the world', () => {
    it('makes at most the calls out and the calls to Cloudflare an invocation is allowed', async () => {
      const threads = Array.from({ length: 80 }, (_, nth) => {
        const threadId = `thread-${String(nth).padStart(2, '0')}`;
        return { id: threadId, labelled: true, answer: plainThread(threadId) };
      });
      gmailHolds({ labels: labelsAnswer(), historyId: '777', threads, history: [], historyLapsed: false });
      await signInThroughGoogle();
      const check = await aCheckIsQueued();

      const counting = counted();
      await deliver(check, counting.under);
      const outbound = counting.outbound();
      const internal = counting.internal();

      // The measurement the connector's call budget is set from (issue 944).
      console.log(
        JSON.stringify({
          measured: 'one Gmail run, first listing of 80 labelled conversations',
          outbound,
          internal,
          gmail: gmailCalls.length,
          refreshes: refreshes.length,
          filed: (await gmailItems()).length,
        }),
      );
      expect((await gmailItems()).length).toBeGreaterThan(0);
      expect(outbound).toBeLessThanOrEqual(OUTBOUND_LIMIT);
      expect(internal).toBeLessThanOrEqual(INTERNAL_LIMIT);
    });
  });
});
