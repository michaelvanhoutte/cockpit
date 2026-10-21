import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import {
  OTHER_USER_ID,
  USER_ID,
  WORKSPACE_ID,
  alsoWorkspaces,
  asUser,
  inTheStore,
  seedRegister,
  startFromEmpty,
} from '../seed.js';
import { issuerIsForgotten, issuerIsReachable } from '../issuer.js';
import { THE_CODE, textsSent, verifyCalls, verifyForgets, verifyWill } from '../verify.js';

/**
 * Integration level, through the real Worker, because connecting a phone
 * writes the account's store and the register's directory together and every
 * refusal is a status the route maps ("Connect a phone in Settings by
 * confirming a code texted to it", issue 1335). Twilio Verify is faked at the
 * network boundary (../verify.ts, served by ../issuer.ts), so the application
 * does its own request and reads Verify's own statuses. Reading a number is
 * the connector's L1; how the Settings entry draws all this is the web app's
 * F1, and the walk is tests/e2e/connections.test.ts.
 */

const OTHER_WORKSPACE_ID = 'ws-atlas';
const NUMBER = '+32470123456';
const TYPED = '0470 12 34 56';
const SECOND_NUMBER = '+32486123456';

const settings = env as unknown as Record<string, string | undefined>;
const TWILIO = {
  TWILIO_ACCOUNT_SID: 'AC-the-test-account',
  TWILIO_AUTH_TOKEN: 'a-token-that-proves-nothing-here',
  TWILIO_VERIFY_SERVICE_SID: 'VA-the-test-service',
  TWILIO_NUMBER: '+32460000000',
};

const connectionsOf = (workspaceId: string) => `http://cockpit.test/v1/workspaces/${workspaceId}/connections`;

function sendCode(number: string, workspaceId = WORKSPACE_ID, userId = USER_ID): Promise<Response> {
  return asUser(
    `${connectionsOf(workspaceId)}/twilio/phone/code`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number }) },
    userId,
  );
}

function confirmCode(number: string, code: string, workspaceId = WORKSPACE_ID, userId = USER_ID): Promise<Response> {
  return asUser(
    `${connectionsOf(workspaceId)}/twilio/phone/confirm`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number, code }) },
    userId,
  );
}

/** What the window would show for a Workspace: its connected source accounts. */
async function listed(workspaceId = WORKSPACE_ID, userId = USER_ID) {
  const res = await asUser(connectionsOf(workspaceId), {}, userId);
  expect(res.status).toBe(200);
  return ((await res.json()) as { sourceAccounts: { displayName: string; connectorId: string }[] }).sourceAccounts;
}

/** The register's index of connected numbers, which a push finds the account through. */
async function directory() {
  const rows = await env.DB.prepare(
    'SELECT connector_id, external_account_key, account_id, workspace_id FROM connector_directory',
  ).all<{ connector_id: string; external_account_key: string; account_id: string; workspace_id: string }>();
  return rows.results;
}

async function offeredConnectors(): Promise<string[]> {
  const res = await asUser('http://cockpit.test/v1/connectors');
  expect(res.status).toBe(200);
  return ((await res.json()) as { connectors: { id: string }[] }).connectors.map((one) => one.id);
}

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
  vi.useRealTimers();
  issuerIsForgotten();
});

describe('Connector management', () => {
  describe('a phone is connected only once the code texted to it is typed back', () => {
    it('lists the number under the workspace it was connected from, and finds it in the register', async () => {
      expect((await sendCode(TYPED)).status).toBe(200);

      const confirmed = await confirmCode(TYPED, THE_CODE);

      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toEqual({ number: NUMBER });
      expect(await listed()).toMatchObject([{ displayName: NUMBER, connectorId: 'twilio' }]);
      expect(await directory()).toMatchObject([
        { connector_id: 'twilio', external_account_key: NUMBER, workspace_id: WORKSPACE_ID },
      ]);
    });

    it('keeps no credential of the phone but an empty one, sealed', async () => {
      await sendCode(TYPED);
      await confirmCode(TYPED, THE_CODE);

      const rows = await inTheStore((sql) => [
        ...sql.exec<{ encrypted_credential: string; credential_nonce: string }>(
          "SELECT encrypted_credential, credential_nonce FROM connector_accounts WHERE connector_id = 'twilio'",
        ),
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.encrypted_credential).not.toBe('');
      expect(rows[0]!.credential_nonce).not.toBe('');
    });

    it.each([
      {
        situation: 'a wrong code',
        arrange: async () => {
          await sendCode(TYPED);
        },
        code: '000000',
        says: /not the code/i,
      },
      {
        situation: 'a code Verify has stopped accepting because it lapsed',
        arrange: async () => {
          await sendCode(TYPED);
          verifyForgets(NUMBER);
        },
        code: THE_CODE,
        says: /no longer valid/i,
      },
      {
        situation: 'the right code after the wrong ones used the attempts up',
        arrange: async () => {
          await sendCode(TYPED);
          for (let attempt = 0; attempt < 5; attempt += 1) await confirmCode(TYPED, '000000');
        },
        code: THE_CODE,
        says: /no longer valid/i,
      },
      {
        situation: 'the right code once Verify answers that the checks of this verification are used up',
        arrange: async () => {
          await sendCode(TYPED);
          verifyWill({ check: 'is out of attempts' });
        },
        code: THE_CODE,
        says: /no longer valid/i,
      },
      {
        situation: 'a number that was never sent a code',
        arrange: async () => {},
        code: THE_CODE,
        says: /no longer valid/i,
      },
    ])('refuses $situation, and connects nothing', async ({ arrange, code, says }) => {
      await arrange();

      const res = await confirmCode(TYPED, code);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(says);
      expect(await listed()).toEqual([]);
      expect(await directory()).toEqual([]);
    });

    it('makes one connection of the same code confirmed twice', async () => {
      await sendCode(TYPED);

      const first = await confirmCode(TYPED, THE_CODE);
      const again = await confirmCode(TYPED, THE_CODE);

      expect([first.status, again.status]).toEqual([200, 400]);
      expect(await listed()).toHaveLength(1);
      expect(await directory()).toHaveLength(1);
    });

    it('makes one connection of a number confirmed again after a fresh code', async () => {
      await sendCode(TYPED);
      await confirmCode(TYPED, THE_CODE);
      await sendCode(TYPED);
      await confirmCode(TYPED, THE_CODE);

      expect(await listed()).toHaveLength(1);
    });

    it('lists both phones when a second is connected in the same workspace', async () => {
      await sendCode(TYPED);
      await confirmCode(TYPED, THE_CODE);
      await sendCode(SECOND_NUMBER);
      await confirmCode(SECOND_NUMBER, THE_CODE);

      expect((await listed()).map((one) => one.displayName).sort()).toEqual([NUMBER, SECOND_NUMBER]);
    });
  });

  describe('only a Belgian mobile number can be sent a code', () => {
    it.each([
      { situation: 'a Belgian landline', number: '+32 2 123 45 67' },
      { situation: 'a Dutch mobile', number: '+31 6 12345678' },
      { situation: 'letters', number: 'call me' },
      { situation: 'nothing', number: '' },
    ])('refuses $situation when sending a code, and Verify is never asked', async ({ number }) => {
      const res = await sendCode(number);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/Belgian mobile/);
      expect(verifyCalls).toEqual([]);
    });

    it('refuses the same numbers when confirming, and Verify is never asked', async () => {
      const res = await confirmCode('+31 6 12345678', THE_CODE);

      expect(res.status).toBe(400);
      expect(verifyCalls).toEqual([]);
      expect(await listed()).toEqual([]);
    });
  });

  describe('an account can ask for five codes an hour', () => {
    const MINUTE = 60_000;
    let start: number;

    beforeEach(() => {
      start = Date.now();
      vi.useFakeTimers({ toFake: ['Date'], now: start });
    });

    async function askFive(): Promise<number[]> {
      const statuses: number[] = [];
      for (let n = 0; n < 5; n += 1) {
        vi.setSystemTime(start + n * MINUTE);
        statuses.push((await sendCode(TYPED)).status);
      }
      return statuses;
    }

    it('sends the fifth code in an hour and refuses the sixth, without asking Verify', async () => {
      expect(await askFive()).toEqual([200, 200, 200, 200, 200]);
      vi.setSystemTime(start + 5 * MINUTE);

      const sixth = await sendCode(TYPED);

      expect(sixth.status).toBe(429);
      expect(((await sixth.json()) as { error: string }).error).toMatch(/too many codes/i);
      expect(textsSent()).toBe(5);
    });

    it('still sends another account its codes meanwhile', async () => {
      await askFive();
      vi.setSystemTime(start + 5 * MINUTE);

      const other = await sendCode(TYPED, WORKSPACE_ID, OTHER_USER_ID);

      expect(other.status).toBe(200);
      expect(textsSent()).toBe(6);
    });

    it('sends again an hour after the first code', async () => {
      await askFive();
      vi.setSystemTime(start + 5 * MINUTE);
      await sendCode(TYPED);

      vi.setSystemTime(start + 60 * MINUTE);

      expect((await sendCode(TYPED)).status).toBe(200);
      expect(textsSent()).toBe(6);
    });
  });

  describe('Twilio failing is said in Settings and connects nothing', () => {
    it.each([
      { situation: 'Verify refuses to send', how: { send: 'refuses' as const }, says: /another code/i },
      { situation: 'Verify fails sending', how: { send: 'is down' as const }, says: /could not be reached/i },
    ])('answers an error, and stores nothing, when $situation', async ({ how, says }) => {
      verifyWill(how);

      const res = await sendCode(TYPED);

      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toMatch(says);
      expect(await listed()).toEqual([]);
      expect(await directory()).toEqual([]);
    });

    it.each([
      { situation: 'Verify is unreachable on Confirm', how: 'is down' as const },
      { situation: 'Verify answers Confirm with something unreadable', how: 'is unreadable' as const },
    ])('answers an error, and connects nothing, when $situation', async ({ how }) => {
      await sendCode(TYPED);
      verifyWill({ check: how });

      const res = await confirmCode(TYPED, THE_CODE);

      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toMatch(/could not be reached/i);
      expect(await listed()).toEqual([]);
      expect(await directory()).toEqual([]);
    });
  });

  describe('only an environment with Twilio configured offers Text messages', () => {
    it('offers it, with the number to text, where the secrets are set', async () => {
      const res = await asUser('http://cockpit.test/v1/connectors');
      const offered = ((await res.json()) as { connectors: { id: string; displayName: string; textedCode?: { textTo: string } }[] })
        .connectors.find((one) => one.id === 'twilio');

      expect(offered).toMatchObject({ displayName: 'Text messages', textedCode: { textTo: '+32460000000' } });
    });

    it.each(Object.keys(TWILIO).map((name) => ({ situation: `${name} is not set`, name })))(
      'does not offer it, and answers sending a code with 404, where $situation',
      async ({ name }) => {
        delete settings[name];

        expect(await offeredConnectors()).not.toContain('twilio');
        const res = await sendCode(TYPED);
        expect(res.status).toBe(404);
        expect(verifyCalls).toEqual([]);
      },
    );

    it('does not offer it where nothing can seal what it connects', async () => {
      const key = settings.CONNECTOR_CREDENTIAL_KEY;
      delete settings.CONNECTOR_CREDENTIAL_KEY;
      try {
        expect(await offeredConnectors()).not.toContain('twilio');
        expect((await sendCode(TYPED)).status).toBe(404);
      } finally {
        settings.CONNECTOR_CREDENTIAL_KEY = key;
      }
    });
  });

  describe('a phone connected in one workspace is seen only there', () => {
    it('lists it in the workspace it was connected from and not in another', async () => {
      await sendCode(TYPED, OTHER_WORKSPACE_ID);
      await confirmCode(TYPED, THE_CODE, OTHER_WORKSPACE_ID);

      expect((await listed(OTHER_WORKSPACE_ID)).map((one) => one.displayName)).toEqual([NUMBER]);
      expect(await listed(WORKSPACE_ID)).toEqual([]);
    });

    it('refuses a workspace that does not exist, and asks Verify nothing', async () => {
      const res = await sendCode(TYPED, 'ws-nowhere');

      expect(res.status).toBe(404);
      expect(verifyCalls).toEqual([]);
    });
  });

  describe('the guest account cannot connect a phone', () => {
    it('refuses sending a code to the guest, and asks Verify nothing', async () => {
      const back = await SELF.fetch('http://cockpit.test/v1/sign-in/guest', { redirect: 'manual' });
      const cookie = back.headers
        .getSetCookie()
        .map((one) => one.split(';')[0]!)
        .find((one) => one.startsWith('cockpit_session='))!;
      const workspaces = await SELF.fetch('http://cockpit.test/v1/workspaces', { headers: { cookie } });
      const guestWorkspace = ((await workspaces.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;

      const res = await SELF.fetch(`${connectionsOf(guestWorkspace)}/twilio/phone/code`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ number: TYPED }),
      });

      expect(res.status).toBe(403);
      expect(verifyCalls).toEqual([]);
    });
  });
});
