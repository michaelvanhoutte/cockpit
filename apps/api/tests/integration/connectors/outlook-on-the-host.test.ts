import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env, runInDurableObject } from 'cloudflare:test';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { handleQueue } from '../../../src/jobs/index.js';
import { OUTLOOK_CALLS_PER_RUN } from '../../../src/connectors/registry.js';
import { ACCOUNT_NAME, WORKSPACE_ID, asUser, seedRegister, signInAs, startFromEmpty, storeNamed } from '../seed.js';
import { issuerIsForgotten, issuerIsReachable, issuerWillIdentify, refreshes } from '../issuer.js';
import { graphAdds, graphCalls, graphHolds, graphMessage } from '../graph.js';
import { type MessageOptions } from '../../../../../packages/connectors/outlook/tests/graph-payloads.js';

/**
 * Integration level: Outlook registered in this environment and run by the
 * generic host - its sign-in through the generic connect routes, its checks
 * queued by the account's alarm and run by the Worker's queue consumer, both
 * against the real store ("Connect Outlook from Settings, wherever the
 * Microsoft client is set", issue 1048). Microsoft and Graph are faked at the
 * network (`../issuer.ts`, `../graph.ts`). How Outlook behaves - what a flag
 * cleared does, a refused change, a lapsed listing - is the connector package's
 * to prove against its own fake host, and is not re-proved here; the host's own
 * rules are pulled-checks.test.ts's, against a scripted source.
 *
 * **What only a run on the host can count is its own round trips**: the calls
 * out one invocation may make, which is what `OUTLOOK_CALLS_PER_RUN` is
 * measured against.
 *
 * **The queue is held**, so each case delivers what the alarm queued through
 * the real consumer itself.
 */

const ANNA = { email: 'anna@example.com', tenant: 'tenant-of-anna', object: 'object-of-anna' };

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

/** Waits for the check the alarm queues - set for now, so it fires by itself. */
async function aCheckIsQueued(): Promise<EnrichmentJob> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const check = held.find((job) => job.kind === 'check-a-pulled-connection');
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

/** Connect on the Outlook card choosing the flag: the whole trip a browser makes through Microsoft. */
async function signInThroughMicrosoft(): Promise<void> {
  const session = await signInAs();
  const started = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/outlook/connect?choice=flag&filesByName=false`,
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
    scope: 'openid email profile offline_access Mail.ReadWrite',
  });
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/outlook/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
}

async function outlookRow(): Promise<{ failingBecause: string | null; follows?: string } | undefined> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sourceAccounts: { connectorId: string; failingBecause: string | null; follows?: string }[] }).sourceAccounts.find(
    (row) => row.connectorId === 'outlook',
  );
}

interface FiledItem {
  id: string;
  title: string;
  sourceId: string | null;
  source: string;
}

async function outlookItems(): Promise<FiledItem[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: FiledItem[] }).items.filter((item) => item.source === 'outlook');
}

async function markDone(itemId: string): Promise<void> {
  const res = await asUser('http://cockpit.test/v1/commands/set_done', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: crypto.randomUUID(),
      issuedAt: new Date().toISOString(),
      workspaceId: WORKSPACE_ID,
      itemId,
      done: true,
    }),
  });
  expect(res.status).toBe(200);
}

function nextAlarm(): Promise<number | null> {
  return runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.getAlarm());
}

/** Messages flagged in the mailbox, numbered from `from`. */
function flagged(count: number, from = 0): MessageOptions[] {
  return Array.from({ length: count }, (_, nth) => {
    const id = `message-${String(from + nth).padStart(3, '0')}`;
    return { id, flag: 'flagged' as const };
  });
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
  describe('an Outlook mailbox connected here is checked on the host, and files what it follows as titled Tasks', () => {
    it('brings in a flagged message as a Task under Outlook, and sets the next check about five minutes out', async () => {
      graphHolds([{ id: 'message-1', flag: 'flagged', subject: 'Invoice 42' }]);
      await signInThroughMicrosoft();
      expect(await outlookRow()).toMatchObject({ follows: 'flag', failingBecause: null });
      // Queued by the alarm, which itself asked nothing of Microsoft.
      const check = await aCheckIsQueued();
      expect(graphCalls).toEqual([]);

      await deliver(check);

      expect(await outlookItems()).toEqual([expect.objectContaining({ title: 'Invoice 42', sourceId: 'message-1' })]);
      expect(await outlookRow()).toMatchObject({ failingBecause: null });
      expect((await nextAlarm())! - Date.now()).toBeGreaterThan(4 * 60_000);
    });
  });

  describe('an Outlook check stays within what one run may ask of the world', () => {
    it('makes at most the calls out and the calls to Cloudflare an invocation is allowed, on a first listing longer than one run reads', async () => {
      graphHolds(flagged(150), { perPage: 100 });
      await signInThroughMicrosoft();
      const check = await aCheckIsQueued();

      const counting = counted();
      await deliver(check, counting.under);
      const outbound = counting.outbound();
      const internal = counting.internal();

      // The measurement the connector's call budget is set from (issue 1048).
      console.log(
        JSON.stringify({
          measured: 'one Outlook run, first listing of 150 flagged messages',
          outbound,
          internal,
          graph: graphCalls.length,
          refreshes: refreshes.length,
          filed: (await outlookItems()).length,
        }),
      );
      expect((await outlookItems()).length).toBeGreaterThan(0);
      expect(graphCalls.length + refreshes.length).toBeLessThanOrEqual(OUTLOOK_CALLS_PER_RUN);
      // And one more where the isolate has not yet read the issuer's discovery document, which an earlier case here may have.
      expect(outbound + 1).toBeLessThanOrEqual(OUTBOUND_LIMIT);
      expect(internal).toBeLessThanOrEqual(INTERNAL_LIMIT);
      // Not everything was read, so it is checked again within seconds rather than in five minutes.
      expect((await nextAlarm())! - Date.now()).toBeLessThanOrEqual(10_000);
    });

    it('makes the changes waiting for Outlook and reads the new messages within the same calls', async () => {
      graphHolds(flagged(30), { perPage: 100 });
      await signInThroughMicrosoft();
      await deliver(await aCheckIsQueued());
      for (let more = 0; (await outlookItems()).length < 30 && more < 5; more += 1) await deliver(await aCheckIsQueued());
      const filed = await outlookItems();
      expect(filed).toHaveLength(30);

      // Twelve closed in Cockpit, and thirty more flagged in Outlook meanwhile.
      for (const item of filed.slice(0, 12)) await markDone(item.id);
      graphAdds(flagged(30, 30));
      const check = await aCheckIsQueued();
      graphCalls.length = 0;
      refreshes.length = 0;

      const counting = counted();
      await deliver(check, counting.under);
      const outbound = counting.outbound();

      console.log(
        JSON.stringify({
          measured: 'one Outlook run, 12 changes waiting and 30 new messages',
          outbound,
          internal: counting.internal(),
          graph: graphCalls.length,
          refreshes: refreshes.length,
        }),
      );
      expect(graphCalls.filter((call) => call.startsWith('PATCH ')).length).toBe(12);
      expect(graphMessage(filed[0]!.sourceId!)?.flag).toBe('complete');
      expect(graphCalls.length + refreshes.length).toBeLessThanOrEqual(OUTLOOK_CALLS_PER_RUN);
      // And one more where the isolate has not yet read the issuer's discovery document, which an earlier case here may have.
      expect(outbound + 1).toBeLessThanOrEqual(OUTBOUND_LIMIT);
    });
  });
});
