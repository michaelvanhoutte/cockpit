import { describe, expect, it } from 'vitest';
import { savedMessageFrom } from '../../src/activity.js';
import {
  ANOTHER_BOT_APP_ID,
  BOT_APP_ID,
  CONVERSATION,
  MESSAGE_ID,
  PERSON,
  TENANT,
  channelKeys,
  channelToken,
  saveToCockpitCall,
} from './bot-framework.js';

/**
 * L1: reading a save is a pure function of a token and a body, with the
 * signature check handed in - so every refusal below is provable without a
 * network, exactly as signing in proves its own (tests/unit/auth/oidc.test.ts
 * in apps/api).
 */

const NOW = new Date();

async function read(
  call: { token?: string; activity?: unknown } = {},
  appId = BOT_APP_ID,
): ReturnType<typeof savedMessageFrom> {
  return savedMessageFrom(
    { token: call.token ?? (await channelToken()), activity: call.activity ?? saveToCockpitCall() },
    await channelKeys(),
    { appId },
    NOW,
  );
}

describe('Capture', () => {
  describe('a message saved from Teams is read only from a call Microsoft signed for this Cockpit', () => {
    it.each([
      {
        situation: 'a call signed by the channel, for us',
        call: async () => ({}),
        expected: 'read',
      },
      {
        situation: 'a call signed with a key the channel never published',
        call: async () => ({ token: await channelToken({ forged: true }) }),
        expected: 'the call was not signed by the Bot Framework',
      },
      {
        situation: 'a call whose token ran out',
        call: async () => ({ token: await channelToken({ expiresIn: -60 }) }),
        expected: 'the call was not signed by the Bot Framework',
      },
      {
        situation: 'a call signed by somebody else entirely',
        call: async () => ({ token: await channelToken({ issuer: 'https://api.example.test' }) }),
        expected: 'the call was not signed by the Bot Framework',
      },
      {
        situation: 'a genuine call minted for another bot',
        call: async () => ({ token: await channelToken({ audience: ANOTHER_BOT_APP_ID }) }),
        expected: 'the call was signed for another bot',
      },
      {
        situation: 'a call whose signed address is not the one it came from',
        call: async () => ({ token: await channelToken({ serviceUrl: 'https://elsewhere.test/' }) }),
        expected: 'the call names another address',
      },
      {
        situation: 'a call carrying no token at all',
        call: async () => ({ token: '' }),
        expected: 'the call was not signed by the Bot Framework',
      },
      {
        situation: 'a click on something this app does not offer',
        call: async () => ({
          activity: saveToCockpitCall({
            value: { commandId: 'somethingElse', messagePayload: { id: MESSAGE_ID } },
          }),
        }),
        expected: 'the call is not a save',
      },
      {
        situation: 'a call that is not an action at all',
        call: async () => ({ activity: saveToCockpitCall({ type: 'message' }) }),
        expected: 'the call is not a save',
      },
      {
        situation: 'a call naming nobody at Microsoft',
        call: async () => ({
          activity: saveToCockpitCall({ from: { id: '29:1abc' }, channelData: {} }),
        }),
        expected: 'the call names nobody',
      },
      {
        situation: 'a save with nothing in the message',
        call: async () => {
          const activity = saveToCockpitCall() as { value: { messagePayload: { body: unknown } } };
          activity.value.messagePayload.body = { contentType: 'html', content: '' };
          return { activity };
        },
        expected: 'the call carries no message',
      },
      {
        // Refused for naming no address rather than for its shape, the
        // signed address being checked before anything in the body is read.
        situation: 'a body that is not a call at all',
        call: async () => ({ activity: 'not json we know' }),
        expected: 'the call names another address',
      },
    ])('$situation', async ({ call, expected }) => {
      const answer = await read(await call());

      expect(typeof answer === 'string' ? answer : 'read').toBe(expected);
    });
  });

  describe('a saved message keeps who sent it, when they sent it, and the way back to it', () => {
    it('reads the message, the sender, the time and the link out of the call', async () => {
      const answer = await read();

      expect(answer).toEqual({
        externalAccountKey: `${TENANT}:${PERSON}`,
        item: {
          source: 'teams',
          sourceId: `${CONVERSATION}:${MESSAGE_ID}`,
          sourceLink: `https://teams.microsoft.com/l/message/${CONVERSATION}/${MESSAGE_ID}?tenantId=${TENANT}`,
          sender: 'Grace Hopper',
          sourceTimestamp: '2026-09-15T09:20:00.000Z',
          title: 'Can you review the Q3 plan before Friday?',
          capturedMessage: 'Can you review the Q3 plan before Friday?',
        },
      });
    });

    it('builds the way back itself for a call that arrives without one', async () => {
      const activity = saveToCockpitCall() as {
        value: { messagePayload: { linkToMessage?: unknown } };
      };
      delete activity.value.messagePayload.linkToMessage;

      const answer = await read({ activity });

      expect(typeof answer === 'string' ? answer : answer.item.sourceLink).toBe(
        `https://teams.microsoft.com/l/message/${encodeURIComponent(CONVERSATION)}/${MESSAGE_ID}?tenantId=${TENANT}`,
      );
    });

    it('names a message by the conversation it is in as well as by itself', async () => {
      // Two conversations can hand out the same message id, so the pair is what
      // makes the same save land on the same Item and two different saves land
      // on two.
      const elsewhere = saveToCockpitCall({
        conversation: { id: '19:another@thread.v2', tenantId: TENANT },
      });

      const [here, there] = [await read(), await read({ activity: elsewhere })];

      expect(typeof here === 'string' || typeof there === 'string').toBe(false);
      expect((here as { item: { sourceId: string } }).item.sourceId).not.toBe(
        (there as { item: { sourceId: string } }).item.sourceId,
      );
    });

    it('captures what was written rather than the markup it arrived in', async () => {
      const activity = saveToCockpitCall() as { value: { messagePayload: { body: unknown } } };
      activity.value.messagePayload.body = {
        contentType: 'html',
        content: '<p>Line one</p><p>&lt;not a tag&gt; &amp; more</p>',
      };

      const answer = await read({ activity });

      expect(typeof answer === 'string' ? answer : answer.item.capturedMessage).toBe(
        'Line one\n<not a tag> & more',
      );
    });
  });
});
