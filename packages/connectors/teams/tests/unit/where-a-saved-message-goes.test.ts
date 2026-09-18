import { describe, expect, it } from 'vitest';
import type { ConnectedAccountHost, PushHost, SourceItem } from '@cockpit/connector-sdk';
import { createTeamsConnector } from '../../src/index.js';
import {
  BOT_APP_ID,
  PERSON,
  TENANT,
  channelKeys,
  channelToken,
  saveToCockpitCall,
} from './bot-framework.js';

/**
 * L1: which connection a save belongs to, against a host that records what was
 * asked of it (docs/testing-strategy.md, "Connectors are tested in isolation
 * against a fake host"). That the host's own answer comes from a real register
 * and a real store is `apps/api/tests/integration/http/teams-ingress.test.ts`'s
 * question, not this file's.
 */

const CONNECTED = `${TENANT}:${PERSON}`;

/** A host that has connected one account, and a record of everything asked of it. */
function hostThatHasConnected(connected: string | null): {
  host: PushHost;
  keysAskedAbout: string[];
  filed: SourceItem[];
  credentialsOpened: string[];
} {
  const keysAskedAbout: string[] = [];
  const filed: SourceItem[] = [];
  const credentialsOpened: string[] = [];
  const account: ConnectedAccountHost = {
    log: () => {},
    getCredentials: async () => {
      credentialsOpened.push(connected!);
      return { credential: 'a token that proves nothing here' };
    },
    emitItem: async (item) => {
      filed.push(item);
    },
  };
  return {
    keysAskedAbout,
    filed,
    credentialsOpened,
    host: {
      log: () => {},
      forAccount: async (key) => {
        keysAskedAbout.push(key);
        return key === connected ? account : null;
      },
    },
  };
}

async function save(
  host: PushHost,
  call: { token?: string; activity?: unknown } = {},
): Promise<Response> {
  const connector = createTeamsConnector({ appId: BOT_APP_ID, keys: await channelKeys() });
  return connector.handleWebhook!(
    new Request('https://cockpit.test/ingress/teams/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${call.token ?? (await channelToken())}` },
      body: JSON.stringify(call.activity ?? saveToCockpitCall()),
    }),
    host,
  );
}

describe('Capture', () => {
  describe('a message saved from Teams is filed against the connection the call names', () => {
    it('files it where that Microsoft account is connected', async () => {
      const asked = hostThatHasConnected(CONNECTED);

      const answer = await save(asked.host);

      expect(asked.keysAskedAbout).toEqual([CONNECTED]);
      expect(asked.filed.map((item) => [item.source, item.sender])).toEqual([
        ['teams', 'Grace Hopper'],
      ]);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({
        composeExtension: { type: 'message', text: 'Saved to Cockpit.' },
      });
    });

    it('says so, and files nothing, where nobody has connected that account', async () => {
      const asked = hostThatHasConnected(null);

      const answer = await save(asked.host);

      expect(asked.filed).toEqual([]);
      expect(answer.status).toBe(200);
      expect(JSON.stringify(await answer.json())).toContain('not connected');
    });

    it('never opens a stored credential for a save it files', async () => {
      // What a message action carries is the message: the connection is what
      // says where it goes, and nothing about it has to be unsealed to put it
      // there.
      const asked = hostThatHasConnected(CONNECTED);

      await save(asked.host);

      expect(asked.credentialsOpened).toEqual([]);
    });
  });

  describe('a call this Cockpit did not believe is refused before any connection is looked up', () => {
    it.each([
      {
        situation: 'a signature no published key matches',
        token: () => channelToken({ forged: true }),
        status: 401,
      },
      {
        situation: 'a token minted for another bot',
        token: () => channelToken({ audience: 'another-bot' }),
        status: 401,
      },
      {
        situation: 'no token at all',
        token: async () => '',
        status: 401,
      },
      {
        situation: 'an action this app does not offer',
        token: () => channelToken(),
        activity: () => saveToCockpitCall({ value: { commandId: 'somethingElse' } }),
        status: 400,
      },
    ])('$situation', async ({ token, activity, status }) => {
      const asked = hostThatHasConnected(CONNECTED);

      const answer = await save(asked.host, {
        token: await token(),
        ...(activity ? { activity: activity() } : {}),
      });

      expect(answer.status).toBe(status);
      expect(asked.keysAskedAbout).toEqual([]);
      expect(asked.filed).toEqual([]);
      expect(asked.credentialsOpened).toEqual([]);
    });
  });

  describe('a save that cannot be filed fails the call rather than losing it', () => {
    it('lets the failure out, so Teams delivers the click again', async () => {
      const asked = hostThatHasConnected(CONNECTED);
      const failing: PushHost = {
        log: () => {},
        forAccount: async () => ({
          log: () => {},
          getCredentials: async () => ({}),
          emitItem: async () => {
            throw new Error('the store would not take it');
          },
        }),
      };

      await expect(save(failing)).rejects.toThrow('the store would not take it');
      expect(asked.filed).toEqual([]);
    });
  });
});
