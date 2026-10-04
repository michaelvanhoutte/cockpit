import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  ACCOUNT_NAME,
  TASK_TYPE_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
  storeNamed,
} from '../seed.js';
import {
  gmailAnswersWith,
  gmailCalls,
  gmailHolds,
  gmailIsEmpty,
  googleRefreshes,
  issuerIsReachable,
  issuerWillIdentify,
  refreshes,
  type Grant,
} from '../issuer.js';
import { labelsAnswer, plainThread } from '../../gmail-payloads.js';
import { NO_LABEL, SIGN_IN_REFUSED } from '../../../src/connectors/gmail-check.js';
import { handleScheduled } from '../../../src/jobs/index.js';

/**
 * Integration level, through the real Worker and the account's own alarm,
 * because every rule here is about what ends up in the store - which Items,
 * in which Workspace, linked to which conversation - and about the alarm that
 * brings them in ("Bring in the conversations already labelled Cockpit as
 * tasks", issue 725). Gmail and Google are faked at the network boundary
 * (../issuer.ts), answering in the shapes ../../gmail-payloads.ts records.
 *
 * What a conversation's Item says, which label is Cockpit's and what a
 * refresh leaves sealed are tests/unit/connectors/gmail.test.ts's; what the
 * row draws is apps/web's.
 */

const OTHER_WORKSPACE_ID = 'ws-atlas';
const MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const ANNA = { email: 'anna@example.com', subject: 'google-anna' };

function granted(refreshToken: string, expiresIn = 3599): Grant {
  return {
    refresh_token: refreshToken,
    access_token: `access-for-${refreshToken}`,
    expires_in: expiresIn,
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${MODIFY}`,
  };
}

/** Connect, Google says whose mailbox it is, and back - as gmail-connections.test.ts walks it. */
async function connect(grant: Grant = granted('anna-refresh'), workspaceId = WORKSPACE_ID): Promise<void> {
  await issuerIsReachable();
  const session = await signInAs(USER_ID);
  const started = await SELF.fetch(`http://cockpit.test/v1/workspaces/${workspaceId}/connections/gmail/connect`, {
    redirect: 'manual',
    headers: { cookie: session },
  });
  const asked = new URL(started.headers.get('location')!);
  const attempt = started.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  issuerWillIdentify({ ...ANNA, nonce: asked.searchParams.get('nonce')! }, 'a-code', grant);
  const back = await SELF.fetch(
    `http://cockpit.test/v1/connections/gmail/callback?code=a-code&state=${asked.searchParams.get('state')}`,
    { redirect: 'manual', headers: { cookie: `${session}; ${attempt}` } },
  );
  expect(back.headers.get('location')).toBe(`/w/${workspaceId}?connections=gmail-connected`);
}

/** A mailbox holding `count` conversations labelled Cockpit, and one that is not. */
function mailboxWith(count: number): void {
  gmailHolds({
    labels: labelsAnswer(),
    historyId: '777',
    threads: [
      ...Array.from({ length: count }, (_, at) => {
        const id = `thread-${String(at).padStart(3, '0')}`;
        return { id, labelled: true, answer: plainThread(id, `Subject ${at}`, `Text ${at}`) };
      }),
      { id: 'thread-unlabelled', labelled: false, answer: plainThread('thread-unlabelled') },
    ],
  });
}

/** One run of the account's Gmail check, as the alarm fires it. */
function aCheckRuns(): Promise<boolean> {
  return runDurableObjectAlarm(storeNamed(ACCOUNT_NAME));
}

/**
 * Waits for the run the alarm started by itself to finish - connecting checks
 * at once, so the first run is nobody's to start - which is when it has armed
 * the next one.
 */
async function runningCheckFinishes(): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    const next = await nextCheck();
    if (next !== null && next > Date.now()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the check connecting started never finished');
}

/**
 * Lets the check started by connecting finish, then runs it until it has
 * nothing more to bring in before five minutes from now - at most `limit`
 * times - and answers how many runs that took.
 */
async function checksSettle(limit = 20): Promise<number> {
  await runningCheckFinishes();
  for (let runs = 1; runs <= limit; runs += 1) {
    const next = await nextCheck();
    if (next === null || next > Date.now() + 60_000) return runs;
    await aCheckRuns();
  }
  throw new Error(`the check had more to do after ${limit} runs`);
}

function nextCheck(): Promise<number | null> {
  return runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.getAlarm());
}

interface InboxItem {
  id: string;
  title: string;
  description: string | null;
  source: string;
  sourceId: string | null;
  sourceLink: string | null;
  sender: string | null;
  typeId: string | null;
}

async function inboxOf(workspaceId = WORKSPACE_ID): Promise<InboxItem[]> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: InboxItem[] }).items.filter((item) => item.source === 'mail');
}

async function rowOf(workspaceId = WORKSPACE_ID): Promise<{ lastTestedAt: string | null; failingBecause: string | null }> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`);
  const { sourceAccounts } = (await res.json()) as {
    sourceAccounts: { lastTestedAt: string | null; failingBecause: string | null }[];
  };
  return sourceAccounts[0]!;
}

function sealedCredential(): Promise<string> {
  return inTheStore(
    (sql) =>
      [...sql.exec<{ encrypted_credential: string }>("SELECT encrypted_credential FROM connector_accounts WHERE connector_id = 'gmail'")][0]!
        .encrypted_credential,
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
  gmailIsEmpty();
});

describe('Capture', () => {
  describe('every conversation labelled Cockpit is exactly one open Item in the connecting Workspace’s Inbox', () => {
    it('three labelled at connect are three Tasks there, carrying what each conversation says, and none elsewhere', async () => {
      mailboxWith(3);
      await connect();

      await checksSettle();

      const items = await inboxOf();
      expect(items.map((item) => item.title).sort()).toEqual(['Subject 0', 'Subject 1', 'Subject 2']);
      expect(items.find((item) => item.title === 'Subject 1')).toMatchObject({
        description: 'Text 1',
        sender: 'Pieter Claes',
        sourceId: 'thread-001',
        sourceLink: 'https://mail.google.com/mail/?authuser=anna%40example.com#all/thread-001',
        typeId: TASK_TYPE_ID,
      });
      expect(await inboxOf(OTHER_WORKSPACE_ID)).toEqual([]);
    });

    it('none labelled is no Items, and the row reads when it was last checked', async () => {
      mailboxWith(0);
      await connect();

      await checksSettle();

      expect(await inboxOf()).toEqual([]);
      expect(await rowOf()).toMatchObject({ lastTestedAt: expect.any(String), failingBecause: null });
    });

    it('bringing them in again, after connecting the same mailbox again, still leaves three', async () => {
      mailboxWith(3);
      await connect();
      await checksSettle();

      await connect(granted('anna-refresh-again'));
      await checksSettle();

      expect(await inboxOf()).toHaveLength(3);
      expect(gmailCalls.filter((call) => call.startsWith('threads?'))).toHaveLength(2);
    });

    it('120 across several pages are 120 Items, over successive runs', async () => {
      mailboxWith(120);
      await connect();

      const runs = await checksSettle();

      const items = await inboxOf();
      expect(items).toHaveLength(120);
      expect(new Set(items.map((item) => item.sourceId)).size).toBe(120);
      expect(runs).toBeGreaterThan(1);
    });

    it('a run that stops after the first page resumes at the second, and makes no Item twice', async () => {
      mailboxWith(80);
      await connect();
      gmailAnswersWith(503, (call) => call.startsWith('threads?') && call.includes('pageToken=50'));

      await checksSettle();
      // The next run, five minutes on.
      await aCheckRuns();
      await checksSettle();

      const listed = gmailCalls.filter((call) => call.startsWith('threads?'));
      const failedAt = listed.findIndex((call) => call.includes('pageToken=50'));
      expect(listed.slice(failedAt, failedAt + 2).every((call) => call.includes('pageToken=50'))).toBe(true);
      expect(listed.slice(failedAt + 1).some((call) => !call.includes('pageToken'))).toBe(false);
      const items = await inboxOf();
      expect(items).toHaveLength(80);
      expect(new Set(items.map((item) => item.sourceId)).size).toBe(80);
    });

    it('the same mailbox connected to two Workspaces gives each its own Item', async () => {
      mailboxWith(2);
      await connect(granted('anna-in-work'));
      await connect(granted('anna-in-atlas'), OTHER_WORKSPACE_ID);

      await checksSettle();

      const inWork = await inboxOf();
      const inAtlas = await inboxOf(OTHER_WORKSPACE_ID);
      expect(inWork).toHaveLength(2);
      expect(inAtlas).toHaveLength(2);
      expect(inWork.some((item) => inAtlas.some((other) => other.id === item.id))).toBe(false);
    });
  });
});

describe('Connector management', () => {
  describe('the account checks Gmail while it holds a Gmail connection, and only then', () => {
    it('checks at once on the first connection, every five minutes after, and stops with the last disconnect', async () => {
      mailboxWith(1);
      expect(await nextCheck()).toBeNull();

      // Nobody runs the first check: connecting arms it for now, and it runs.
      await connect();
      await runningCheckFinishes();
      expect((await rowOf()).lastTestedAt).not.toBeNull();

      await aCheckRuns();
      const next = (await nextCheck())! - Date.now();
      expect(next).toBeGreaterThan(4 * 60_000);
      expect(next).toBeLessThanOrEqual(5 * 60_000);

      await connect(granted('anna-in-atlas'), OTHER_WORKSPACE_ID);
      const connections = async (workspaceId: string) =>
        ((await (await asUser(`http://cockpit.test/v1/workspaces/${workspaceId}/connections`)).json()) as {
          sourceAccounts: { id: string }[];
        }).sourceAccounts;
      const disconnect = async (workspaceId: string, commandId: string) => {
        const [held] = await connections(workspaceId);
        const res = await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ commandId, issuedAt: new Date().toISOString(), workspaceId, sourceAccountId: held!.id }),
        });
        expect(res.status).toBe(200);
      };

      await disconnect(WORKSPACE_ID, '018f0000-0000-7000-8000-0000000725a1');
      expect(await nextCheck()).not.toBeNull();
      await disconnect(OTHER_WORKSPACE_ID, '018f0000-0000-7000-8000-0000000725a2');
      expect(await nextCheck()).toBeNull();
      expect(await aCheckRuns()).toBe(false);
    });

    it('the nightly run arms the check again for an account holding a connection but no alarm, and for no other', async () => {
      mailboxWith(1);
      await connect();
      await runInDurableObject(storeNamed(ACCOUNT_NAME), (_instance, state) => state.storage.deleteAlarm());

      await handleScheduled({} as never, env);

      expect(await nextCheck()).not.toBeNull();
      expect(
        await runInDurableObject(storeNamed('tenant-ada'), (_instance, state) => state.storage.getAlarm()),
      ).toBeNull();
    });
  });

  describe('a Gmail connection that cannot be checked says why, and changes nothing', () => {
    it('no label called Cockpit fails the row and lists nothing', async () => {
      mailboxWith(3);
      gmailHolds({ labels: labelsAnswer({ cockpit: false }) });
      await connect();

      await checksSettle();

      expect(await inboxOf()).toEqual([]);
      expect(gmailCalls.some((call) => call.startsWith('threads'))).toBe(false);
      expect(await rowOf()).toMatchObject({ failingBecause: NO_LABEL, lastTestedAt: null });
    });

    it('Google refusing the refresh fails the row with the sign-in', async () => {
      mailboxWith(3);
      googleRefreshes('refuses');
      await connect(granted('anna-refresh', 30));

      await checksSettle();

      expect(await inboxOf()).toEqual([]);
      expect((await rowOf()).failingBecause).toBe(SIGN_IN_REFUSED);
    });

    it('an access token that has lapsed is refreshed, sealed again, and the check runs', async () => {
      mailboxWith(3);
      await connect(granted('anna-refresh', 30));

      await checksSettle();
      // A second run reads with the token the first sealed, rather than
      // refreshing again.
      await aCheckRuns();

      expect(await inboxOf()).toHaveLength(3);
      expect(refreshes).toEqual(['anna-refresh']);
      expect(await sealedCredential()).toBeTruthy();
      expect((await rowOf()).failingBecause).toBeNull();
    });

    it.each([
      { situation: 'Gmail answers 503', status: 503 },
      { situation: 'Gmail rate-limits', status: 429 },
      { situation: 'Google answers a refresh with a 503', status: 'refresh' as const },
    ])('$situation, so nothing changes and the next run tries again', async ({ status }) => {
      mailboxWith(3);
      if (status === 'refresh') googleRefreshes('fails');
      else gmailAnswersWith(status, (call) => call === 'labels');
      await connect(granted('anna-refresh', status === 'refresh' ? 30 : 3599));

      await runningCheckFinishes();

      expect(await inboxOf()).toEqual([]);
      expect(await rowOf()).toMatchObject({ lastTestedAt: null, failingBecause: null });
      expect((await nextCheck())! - Date.now()).toBeGreaterThan(4 * 60_000);

      googleRefreshes('answers');
      await aCheckRuns();
      await checksSettle();
      expect(await inboxOf()).toHaveLength(3);
    });
  });
});
