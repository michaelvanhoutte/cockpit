import { describe, expect, it } from 'vitest';
import { RefusedDelivery, type ConnectedAccountHost, type PushHost, type SourceItem } from '@cockpit/connector-sdk';
import { createTwilioConnector } from '../../src/index.js';

/**
 * L1: whether a request is a text Twilio signed, and the one pass that decides
 * what a signed text becomes, against a host that records what was asked of it
 * ("Text the Cockpit number and the note lands in the Inbox", issue 1336).
 * Signing here is done with Node's own HMAC rather than the package's, so a
 * slip in the package's cannot agree with itself. That the host's answer comes
 * from a real register and store is
 * apps/api/tests/integration/http/texting-the-cockpit-number.test.ts.
 */

const TOKEN = 'the-environments-auth-token';
const ADDRESS = 'https://cockpit.example.com/ingress/twilio/sms';
const PHONE = '+32470123456';

const connector = createTwilioConnector({
  accountSid: 'AC-the-account',
  authToken: TOKEN,
  verifyServiceSid: 'VA-the-service',
  number: '+32 460 00 00 00',
});

/** What Twilio sends for a text, with whatever a case changes. */
const aText = (params: Record<string, string> = {}): Record<string, string> => ({
  MessageSid: 'SM0001',
  AccountSid: 'AC-the-account',
  From: PHONE,
  To: '+32460000000',
  Body: 'call the plumber',
  NumMedia: '0',
  ...params,
});

/** Twilio's scheme, written out independently: the address, then each name and value in name order. */
async function signedWith(token: string, url: string, params: Record<string, string>): Promise<string> {
  const text = url + Object.keys(params).sort().map((name) => name + params[name]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  let binary = '';
  for (const byte of signed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function request(
  params: Record<string, string>,
  how: { signature?: string | null; sentTo?: string; signedTo?: string; token?: string } = {},
): Promise<Request> {
  const signature =
    how.signature === undefined ? await signedWith(how.token ?? TOKEN, how.signedTo ?? ADDRESS, params) : how.signature;
  return new Request(how.sentTo ?? ADDRESS, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(signature === null ? {} : { 'x-twilio-signature': signature }),
    },
    body: new URLSearchParams(params).toString(),
  });
}

/** A host that has connected one phone, and a record of everything asked of it. */
function hostThatHasConnected(connected: string | null) {
  const askedAbout: string[] = [];
  const filed: SourceItem[] = [];
  const logged: string[] = [];
  const account: ConnectedAccountHost = {
    log: (_level, message) => void logged.push(message),
    getCredentials: async () => ({ credential: '' }),
    emitItem: async (item) => {
      filed.push(item);
      return 'filed';
    },
  };
  const host: PushHost = {
    log: (_level, message) => void logged.push(message),
    forAccount: async (key) => {
      askedAbout.push(key);
      return key === connected ? account : null;
    },
  };
  return { host, askedAbout, filed, logged };
}

describe('Capture', () => {
  describe('only texts Twilio signed are heard', () => {
    it('signs as Twilio documents it', async () => {
      // The worked example in Twilio's own documentation for validating a request.
      const documented = {
        CallSid: 'CA1234567890ABCDE',
        Caller: '+14158675309',
        Digits: '1234',
        From: '+14158675309',
        To: '+18005551212',
      };
      const asked = hostThatHasConnected(null);
      const signedByTwilio = new Request('https://mycompany.com/myapp.php?foo=1&bar=2', {
        method: 'POST',
        headers: { 'x-twilio-signature': 'RSOYDt4T1cUTdK1PDd93/VVr8B8=' },
        body: new URLSearchParams(documented).toString(),
      });
      const other = createTwilioConnector({
        accountSid: 'AC',
        authToken: '12345',
        verifyServiceSid: 'VA',
        number: '+32460000000',
      });

      const answer = await other.handleWebhook!(signedByTwilio, asked.host);

      expect(answer.status).toBe(200);
    });

    it.each([
      {
        situation: 'signed with the environment’s token',
        make: async () => request(aText()),
        status: 200,
      },
      {
        situation: 'signed with another token',
        make: async () => request(aText(), { token: 'another-token' }),
        status: 403,
      },
      {
        situation: 'a parameter changed after signing',
        make: async () => {
          const signed = await signedWith(TOKEN, ADDRESS, aText());
          return request(aText({ Body: 'call the electrician' }), { signature: signed });
        },
        status: 403,
      },
      {
        situation: 'a parameter added after signing',
        make: async () => request(aText({ Extra: 'x' }), { signature: await signedWith(TOKEN, ADDRESS, aText()) }),
        status: 403,
      },
      {
        situation: 'sent to an address other than the one signed',
        make: async () => request(aText(), { sentTo: 'https://elsewhere.example.com/ingress/twilio/sms' }),
        status: 403,
      },
      {
        situation: 'no signature',
        make: async () => request(aText(), { signature: null }),
        status: 403,
      },
      {
        situation: 'an empty signature',
        make: async () => request(aText(), { signature: '' }),
        status: 403,
      },
      {
        // The retry settings after # are for Twilio alone: it calls, and signs, the address without them.
        situation: 'the address configured with retry settings after # in Twilio, signed as it was called',
        make: async () => request(aText(), { signedTo: ADDRESS }),
        status: 200,
      },
    ])('$situation is answered $status', async ({ make, status }) => {
      const asked = hostThatHasConnected(PHONE);

      const answer = await connector.handleWebhook!(await make(), asked.host);

      expect(answer.status).toBe(status);
      // Nothing of any account is reached for a request nobody vouched for.
      expect(asked.askedAbout).toEqual(status === 200 ? [PHONE] : []);
      expect(asked.filed).toHaveLength(status === 200 ? 1 : 0);
    });

    it('does not read a form larger than any text can be unless it is signed', async () => {
      const asked = hostThatHasConnected(PHONE);
      const huge = new Request(ADDRESS, {
        method: 'POST',
        headers: { 'content-length': String(10 * 1024 * 1024), 'x-twilio-signature': 'anything' },
        body: 'Body=x',
      });

      const answer = await connector.handleWebhook!(huge, asked.host);

      expect(answer.status).toBe(403);
    });
  });

  describe('a signed text becomes a captured note only from a connected phone, and is always answered with nothing to send', () => {
    it('captures the words, keyed on the message Twilio numbered', async () => {
      const asked = hostThatHasConnected(PHONE);
      const body = 'x'.repeat(1_600);

      const answer = await connector.handleWebhook!(await request(aText({ Body: body, MessageSid: 'SM0042' })), asked.host);

      expect(asked.filed).toEqual([{ sourceId: 'SM0042', capturedMessage: body, sourceLink: null, sender: null, sourceTimestamp: null }]);
      expect(answer.status).toBe(200);
    });

    it.each([
      { situation: 'a text captured', phone: PHONE, params: {} },
      { situation: 'a number nobody connected', phone: null, params: {} },
      { situation: 'a text with no sender named', phone: PHONE, params: { From: '' } },
    ])('answers $situation 200 with an empty reply', async ({ phone, params }) => {
      const asked = hostThatHasConnected(phone);

      const answer = await connector.handleWebhook!(await request(aText(params)), asked.host);

      expect(answer.status).toBe(200);
      expect(answer.headers.get('content-type')).toContain('xml');
      expect(await answer.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    });

    it('drops a text from a number nobody connected, logging only the last four digits', async () => {
      const asked = hostThatHasConnected(PHONE);

      await connector.handleWebhook!(await request(aText({ From: '+32486999123' })), asked.host);

      expect(asked.filed).toEqual([]);
      expect(asked.logged).toHaveLength(1);
      expect(asked.logged[0]).toContain('9123');
      expect(asked.logged[0]).not.toContain('486');
      expect(asked.logged[0]).not.toContain('+32');
    });

    it('fails a text with no words in it after the phone is found, answering Twilio all the same', async () => {
      const asked = hostThatHasConnected(PHONE);

      const failure = await connector.handleWebhook!(await request(aText({ Body: '   ' })), asked.host).catch(
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(RefusedDelivery);
      expect((failure as RefusedDelivery).response.status).toBe(200);
      expect(asked.askedAbout).toEqual([PHONE]);
      expect(asked.filed).toEqual([]);
    });
  });

  describe('a text is an Item called Text message, not Text messages', () => {
    it('is called after one text, where the entry in Settings keeps the plural', () => {
      expect([connector.manifest.displayName, connector.manifest.itemSourceName]).toEqual([
        'Text messages',
        'Text message',
      ]);
    });
  });
});
