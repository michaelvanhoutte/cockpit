import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import {
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';
import {
  issuerAnswersTogether,
  issuerIsReachable,
  issuerWillIdentify,
  issuerWillRefuseTheExchange,
} from '../issuer.js';

/**
 * Integration level, through the real Worker, because every rule here is about
 * what actually ends up stored and what one Workspace can see of another's.
 * Connecting is two navigations with a secret carried between them and a real
 * token exchange in the middle, so a test calling the write path directly
 * would prove the write and say nothing about the flow that is the feature.
 *
 * The issuer is faked at the network boundary (../issuer.ts), exactly as the
 * sign-in suite fakes it - the application does its own redirect, its own code
 * exchange and its own signature check against a key that file publishes.
 * Which claims a token has to carry, and what is read out of them, is
 * tests/unit/connectors/teams.test.ts's and is not re-proved here.
 */

const OTHER_WORKSPACE_ID = 'ws-atlas';

/** What a connected row actually holds, read straight out of the store. */
interface StoredRow extends Record<string, string> {
  id: string;
  workspace_id: string;
  connector_id: string;
  external_account_key: string;
  display_name: string;
  encrypted_credential: string;
  credential_nonce: string;
  connected_at: string;
  updated_at: string;
}

function storedRows(): Promise<StoredRow[]> {
  return inTheStore((sql) => [
    ...sql.exec<StoredRow>('SELECT * FROM connector_accounts ORDER BY connected_at'),
  ]);
}

/** Pressing Connect: what the browser is sent to, and what it is left holding. */
async function startConnecting(
  workspaceId: string,
  session: string,
): Promise<{ asked: URL; attempt: string }> {
  const res = await SELF.fetch(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections/teams/connect`,
    { redirect: 'manual', headers: { cookie: session } },
  );
  expect(res.status).toBe(302);
  const asked = new URL(res.headers.get('location')!);
  const attempt = res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => cookie.startsWith('cockpit_connect='))!;
  return { asked, attempt };
}

/** Coming back from Microsoft, carrying whatever the browser holds. */
function comeBack(query: Record<string, string>, cookies: string): Promise<Response> {
  return SELF.fetch(
    `http://cockpit.test/v1/connections/teams/callback?${new URLSearchParams(query)}`,
    { redirect: 'manual', headers: { cookie: cookies } },
  );
}

/** The whole walk, as a browser makes it, for whoever the issuer says you are. */
async function connect(
  who: { email: string; name?: string },
  workspaceId = WORKSPACE_ID,
  userId = USER_ID,
): Promise<Response> {
  await issuerIsReachable();
  const session = await signInAs(userId);
  const { asked, attempt } = await startConnecting(workspaceId, session);
  issuerWillIdentify({ ...who, nonce: asked.searchParams.get('nonce')! });
  return comeBack(
    { code: 'a-code', state: asked.searchParams.get('state')! },
    `${session}; ${attempt}`,
  );
}

/** What the window would show: this Workspace's connected accounts, as the app reads them. */
async function listed(
  workspaceId = WORKSPACE_ID,
  userId = USER_ID,
): Promise<{ id: string; displayName: string; connectorId: string }[]> {
  const res = await asUser(
    `http://cockpit.test/v1/workspaces/${workspaceId}/connections`,
    {},
    userId,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { sourceAccounts: { id: string; displayName: string; connectorId: string }[] })
    .sourceAccounts;
}

const ADA = { email: 'ada@example.com', name: 'Ada Lovelace' };
const MICHAEL = { email: 'michael@example.com', name: 'Michael' };

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await alsoWorkspaces();
});

describe('Connector management', () => {
  describe('a workspace shows exactly the source accounts it connected, and no others', () => {
    it('lists what it connected, and nothing another workspace connected', async () => {
      expect((await connect(ADA)).headers.get('location')).toBe(
        `/w/${WORKSPACE_ID}?connections=connected`,
      );
      await connect(MICHAEL, OTHER_WORKSPACE_ID);

      expect((await listed()).map((one) => one.displayName)).toEqual(['Ada Lovelace']);
      expect((await listed(OTHER_WORKSPACE_ID)).map((one) => one.displayName)).toEqual(['Michael']);
    });

    /**
     * Another account's store is a different database entirely, so a request
     * naming this workspace's id from another account reads that account's own
     * workspace of the same id and finds nothing - asserted rather than
     * assumed, because it is the boundary the whole feature sits behind. Every
     * account starts with a workspace by this id (`0015-first-workspace`),
     * which is what makes it the id worth trying.
     */
    it('is not another account’s to read, whatever id it names', async () => {
      await connect(ADA);

      expect(await listed(WORKSPACE_ID, OTHER_USER_ID)).toEqual([]);
    });

    /**
     * The one place in this store where deleting really deletes: a tombstoned
     * Workspace holding a live credential nobody can see would be the opposite
     * of what deleting it means.
     */
    it('takes its source accounts with it when the workspace is deleted', async () => {
      await connect(ADA);
      expect(await storedRows()).toHaveLength(1);

      const deleted = await asUser('http://cockpit.test/v1/commands/delete_workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-0000000004a1',
          issuedAt: '2026-09-18T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
        }),
      });

      expect({ status: deleted.status, said: await deleted.text() }).toMatchObject({ status: 200 });
      expect(await storedRows()).toEqual([]);
    });
  });

  describe('connecting the same source account again refreshes it instead of duplicating it', () => {
    it('keeps one row for one account, and a second for a different one', async () => {
      await connect(ADA);
      const [first] = await storedRows();

      await connect({ ...ADA, name: 'Ada, renamed at the source' });
      const afterAgain = await storedRows();

      expect(afterAgain).toHaveLength(1);
      // The same row, refreshed: the id is what anything pointing at this
      // connection holds, and when this workspace first connected the account
      // is not changed by connecting it again.
      expect(afterAgain[0]).toMatchObject({
        id: first!.id,
        display_name: 'Ada, renamed at the source',
        connected_at: first!.connected_at,
      });
      expect(afterAgain[0]!.encrypted_credential).not.toBe(first!.encrypted_credential);
      expect(afterAgain[0]!.updated_at >= first!.updated_at).toBe(true);

      await connect(MICHAEL);

      expect((await listed()).map((one) => one.displayName)).toEqual([
        'Ada, renamed at the source',
        'Michael',
      ]);
    });

    /**
     * A connection belongs to the Workspace that made it, so the same account
     * connected from two Workspaces is two connections rather than one moving.
     */
    it('is a connection per workspace, not one the workspaces share', async () => {
      await connect(ADA);
      await connect(ADA, OTHER_WORKSPACE_ID);

      expect(await storedRows()).toHaveLength(2);
      expect((await listed()).map((one) => one.displayName)).toEqual(['Ada Lovelace']);
      expect((await listed(OTHER_WORKSPACE_ID)).map((one) => one.displayName)).toEqual([
        'Ada Lovelace',
      ]);
    });
  });

  describe('connecting either stores one sealed credential or stores nothing at all', () => {
    it('stores the credential sealed, and never what the source answered', async () => {
      await connect(ADA);

      const [row] = await storedRows();
      expect(row).toMatchObject({ workspace_id: WORKSPACE_ID, connector_id: 'teams' });
      expect(row!.encrypted_credential).not.toContain('id_token');
      expect(row!.credential_nonce).not.toBe('');
      // The list the window reads carries neither half of it.
      expect(JSON.stringify(await listed())).not.toContain(row!.encrypted_credential);
    });

    /**
     * The command log outlives what it refers to, so a credential left in it
     * would still be there after the row holding it was disconnected - which
     * would make disconnecting a lie.
     */
    it('leaves no copy of the credential in what the account records', async () => {
      await connect(ADA);
      const [row] = await storedRows();

      const logged = await inTheStore((sql) => [
        ...sql.exec<{ payload: string }>(
          "SELECT payload FROM commands WHERE name = 'connect_source_account'",
        ),
      ]);

      expect(logged).toHaveLength(1);
      expect(logged[0]!.payload).not.toContain(row!.encrypted_credential);
      expect(logged[0]!.payload).not.toContain(row!.credential_nonce);
      // It still says what happened, which is what an audit trail is for.
      expect(JSON.parse(logged[0]!.payload)).toMatchObject({ connectorId: 'teams' });
    });

    it.each([
      {
        situation: 'the consent screen is declined',
        reply: { error: 'access_denied' },
        spoil: 'nothing' as const,
      },
      {
        situation: 'the code has already been spent',
        reply: { code: 'a-code' },
        spoil: 'the exchange' as const,
      },
      {
        situation: 'the exchange with the source fails',
        reply: { code: 'a-code' },
        spoil: 'the exchange' as const,
      },
    ])('refuses and stores nothing when $situation', async ({ reply, spoil }) => {
      await issuerIsReachable();
      const session = await signInAs();
      const { asked, attempt } = await startConnecting(WORKSPACE_ID, session);
      if (spoil === 'the exchange') issuerWillRefuseTheExchange();

      const back = await comeBack(
        { ...reply, state: asked.searchParams.get('state')! },
        `${session}; ${attempt}`,
      );

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(await storedRows()).toEqual([]);
    });

    /**
     * The attempt is spent before the reply is acted on, so a reply delivered
     * twice - the back button, a bookmarked address - finds nothing to check
     * itself against the second time and cannot write a second row.
     */
    it('refuses the same reply delivered twice, and connects once', async () => {
      await issuerIsReachable();
      const session = await signInAs();
      const { asked, attempt } = await startConnecting(WORKSPACE_ID, session);
      const reply = { code: 'a-code', state: asked.searchParams.get('state')! };
      issuerWillIdentify({ ...ADA, nonce: asked.searchParams.get('nonce')! });
      expect((await comeBack(reply, `${session}; ${attempt}`)).headers.get('location')).toBe(
        `/w/${WORKSPACE_ID}?connections=connected`,
      );

      // The browser is no longer holding the attempt: what it sends the second
      // time is the cookie the first answer deleted, which is nothing.
      const again = await comeBack(reply, session);

      expect(again.headers.get('location')).toBe('/');
      expect(await storedRows()).toHaveLength(1);
    });

    /**
     * The session decides whose store a connection lands in, and every account
     * is handed a workspace under the same id (`0015-first-workspace`) - so a
     * sign-out and a different sign-in while somebody is away at the source
     * must not seal their credential into whoever is signed in when the reply
     * arrives.
     */
    it('refuses a reply that comes back signed in as another account', async () => {
      await issuerIsReachable();
      const session = await signInAs();
      const somebodyElse = await signInAs(OTHER_USER_ID);
      const { asked, attempt } = await startConnecting(WORKSPACE_ID, session);
      issuerWillIdentify({ ...ADA, nonce: asked.searchParams.get('nonce')! });

      const back = await comeBack(
        { code: 'a-code', state: asked.searchParams.get('state')! },
        `${somebodyElse}; ${attempt}`,
      );

      expect(back.headers.get('location')).toBe('/');
      expect(await storedRows()).toEqual([]);
      expect(await listed(WORKSPACE_ID, OTHER_USER_ID)).toEqual([]);
    });

    it('refuses a reply carrying another connection’s proof, and stores nothing', async () => {
      await issuerIsReachable();
      const session = await signInAs();
      const { attempt } = await startConnecting(WORKSPACE_ID, session);

      const back = await comeBack(
        { code: 'a-code', state: 'a-state-from-somewhere-else' },
        `${session}; ${attempt}`,
      );

      expect(back.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
      expect(await storedRows()).toEqual([]);
    });

    it('refuses to start one for a workspace this account does not have', async () => {
      const session = await signInAs();

      const res = await SELF.fetch(
        'http://cockpit.test/v1/workspaces/ws-nobody-has/connections/teams/connect',
        { redirect: 'manual', headers: { cookie: session } },
      );

      expect(res.headers.get('location')).toBe('/w/ws-nobody-has?connections=refused');
      expect(await storedRows()).toEqual([]);
    });

    /**
     * A deployment nobody has given a sealing key to stores nothing rather
     * than storing a credential in the clear, and says so before sending
     * anybody to Microsoft at all.
     */
    describe('where the deployment cannot seal a credential', () => {
      beforeEach(() => {
        delete env.CONNECTOR_CREDENTIAL_KEY;
      });
      afterEach(() => {
        env.CONNECTOR_CREDENTIAL_KEY = 'Y29ja3BpdC10ZXN0LWNvbm5lY3Rvci1rZXktMDAwMDA=';
      });

      it('refuses without sending anybody away, and stores nothing', async () => {
        const session = await signInAs();

        const res = await SELF.fetch(
          `http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/connections/teams/connect`,
          { redirect: 'manual', headers: { cookie: session } },
        );

        expect(res.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=refused`);
        expect(await storedRows()).toEqual([]);
      });
    });
  });

  describe('a saved-message index write that fails does not undo the connection itself', () => {
    /**
     * `connect_source_account` above has already committed by the time
     * `rememberConnection` runs (found in review, PR 491): a transient
     * failure writing the register's own index must not report "refused"
     * for an account that is, in fact, connected - and reconnecting the
     * same account is exactly the repair, since both writes upsert on the
     * same four key columns.
     */
    it('still reports connected, and the account still shows up, when the register index cannot be written', async () => {
      await env.DB.prepare(
        'ALTER TABLE connector_directory RENAME TO connector_directory_out_of_reach',
      ).run();
      try {
        const res = await connect(ADA);
        expect(res.headers.get('location')).toBe(`/w/${WORKSPACE_ID}?connections=connected`);
      } finally {
        await env.DB.prepare(
          'ALTER TABLE connector_directory_out_of_reach RENAME TO connector_directory',
        ).run();
      }

      expect(await storedRows()).toHaveLength(1);
      expect((await listed()).map((one) => one.displayName)).toEqual(['Ada Lovelace']);
    });
  });

  describe('disconnecting removes the source account and the credential it held', () => {
    async function disconnect(
      sourceAccountId: string,
      commandId: string,
      workspaceId = WORKSPACE_ID,
    ): Promise<Response> {
      return asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId,
          issuedAt: '2026-09-18T10:00:00.000Z',
          workspaceId,
          sourceAccountId,
        }),
      });
    }

    it('takes the row and the credential together, and it stays gone', async () => {
      await connect(ADA);
      const [one] = await listed();

      const res = await disconnect(one!.id, '018f0000-0000-7000-8000-0000000004b1');

      expect({ status: res.status, said: await res.text() }).toMatchObject({ status: 200 });
      expect(await storedRows()).toEqual([]);
      expect(await listed()).toEqual([]);
    });

    it('leaves the workspace’s other connections alone', async () => {
      await connect(ADA);
      await connect(MICHAEL);
      const [ada] = await listed();

      await disconnect(ada!.id, '018f0000-0000-7000-8000-0000000004b2');

      expect((await listed()).map((one) => one.displayName)).toEqual(['Michael']);
    });

    /**
     * The id is the one handle a request holds on a connection, so naming
     * another Workspace's is refused rather than quietly matching nothing.
     */
    it('refuses one named from a workspace it does not belong to', async () => {
      await connect(ADA);
      const [ada] = await listed();

      const res = await disconnect(
        ada!.id,
        '018f0000-0000-7000-8000-0000000004b3',
        OTHER_WORKSPACE_ID,
      );

      expect(res.status).toBe(404);
      expect(await storedRows()).toHaveLength(1);
    });

    it('refuses one that is already gone', async () => {
      await connect(ADA);
      const [ada] = await listed();
      await disconnect(ada!.id, '018f0000-0000-7000-8000-0000000004b4');

      const again = await disconnect(ada!.id, '018f0000-0000-7000-8000-0000000004b5');

      expect(again.status).toBe(404);
    });
  });

  describe('two tabs acting on one workspace end up agreeing about what is connected', () => {
    /**
     * Two tabs, or a double press: both walks reach the store, and what
     * decides the outcome is the unique index rather than either of them
     * looking first. The issuer answers both at once, because otherwise they
     * are not at once - one would finish before the other looked, and this
     * would pass against a schema with no rule in it at all.
     */
    it('connects one account when two tabs connect the same one at once', async () => {
      await issuerIsReachable();
      const session = await signInAs();
      const [one, two] = await Promise.all([
        startConnecting(WORKSPACE_ID, session),
        startConnecting(WORKSPACE_ID, session),
      ]);
      issuerWillIdentify({ ...ADA, nonce: one.asked.searchParams.get('nonce')! }, 'code-one');
      issuerWillIdentify({ ...ADA, nonce: two.asked.searchParams.get('nonce')! }, 'code-two');
      const together = issuerAnswersTogether(2);

      const both = Promise.all([
        comeBack(
          { code: 'code-one', state: one.asked.searchParams.get('state')! },
          `${session}; ${one.attempt}`,
        ),
        comeBack(
          { code: 'code-two', state: two.asked.searchParams.get('state')! },
          `${session}; ${two.attempt}`,
        ),
      ]);
      while (!together.allArrived()) await new Promise((resolve) => setTimeout(resolve, 5));
      together.answer();
      const [first, second] = await both;

      expect([first.headers.get('location'), second.headers.get('location')]).toEqual([
        `/w/${WORKSPACE_ID}?connections=connected`,
        `/w/${WORKSPACE_ID}?connections=connected`,
      ]);
      expect(await storedRows()).toHaveLength(1);
      expect(await listed()).toHaveLength(1);
    });

    it('shows the other tab it gone on its next read', async () => {
      await connect(ADA);
      const [ada] = await listed();

      await asUser('http://cockpit.test/v1/commands/disconnect_source_account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: '018f0000-0000-7000-8000-0000000004c1',
          issuedAt: '2026-09-18T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          sourceAccountId: ada!.id,
        }),
      });

      expect(await listed()).toEqual([]);
    });
  });
});
