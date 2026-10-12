import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { MAX_RECORDING_BYTES, TRANSCRIPTION_PATH } from '@cockpit/shared';
import { STAND_IN_WORDS, TRANSCRIPTION_MODEL } from '../../../src/transcription/index.js';
import { ACCOUNT_NAME, OTHER_USER_ID, asUser, inTheStore, seedRegister, signInAs, startFromEmpty } from '../seed.js';

/**
 * Integration level, through `SELF.fetch`: the sign-in gate and the refusals only
 * hold through the real request path ("Dictate in Write with Whisper", issue
 * 1041). Whisper is replaced at the binding - `env.AI`, the horizontal
 * dependency - by something that counts how often it was asked and answers a
 * fixed transcription; what the real model makes of a real recording is the
 * contract tier (tests/contract/transcribe-a-recording.test.ts).
 */

const URL_OF = `http://cockpit.test${TRANSCRIPTION_PATH}`;
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5]);

let asked: { model: string; input: { audio: string } }[];

/** A Workers AI that transcribes everything as the same words, and remembers each question. */
function whisperAnswers(text = '  buy oat milk  '): void {
  asked = [];
  (env as unknown as { AI: unknown }).AI = {
    run: async (model: string, input: { audio: string }) => {
      asked.push({ model, input });
      return { text, transcription_info: { language: 'en' } };
    },
  };
}

function recorded(bytes: Uint8Array, init: RequestInit = {}, type = 'audio/webm;codecs=opus') {
  return {
    method: 'POST',
    headers: { 'content-type': type },
    body: bytes,
    ...init,
  } satisfies RequestInit;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  env.TRANSCRIPTION_STAND_IN = '';
  // Signed in first: signing in puts an issuer on the network, which a case replaces.
  await signInAs();
  asked = [];
});

afterEach(() => {
  Reflect.deleteProperty(env as unknown as Record<string, unknown>, 'AI');
  env.TRANSCRIPTION_STAND_IN = '';
});

describe('Capture', () => {
  describe('a recording is answered with the words said in it', () => {
    it('answers a signed-in recording with the words the model wrote, trimmed', async () => {
      whisperAnswers('  buy oat milk  ');

      const res = await asUser(URL_OF, recorded(AUDIO));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: 'buy oat milk' });
      expect(asked).toHaveLength(1);
      expect(asked[0]!.model).toBe(TRANSCRIPTION_MODEL);
      // The bytes reach the model whole, as base64.
      expect([...atob(asked[0]!.input.audio)].map((c) => c.charCodeAt(0))).toEqual([...AUDIO]);
    });

    it('answers with the stand-in’s words where there is no model to ask', async () => {
      env.TRANSCRIPTION_STAND_IN = 'true';

      const res = await asUser(URL_OF, recorded(AUDIO));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ text: STAND_IN_WORDS });
    });

    it.each([
      {
        situation: 'nobody is signed in',
        request: () => SELF.fetch(URL_OF, recorded(AUDIO)),
        status: 401,
      },
      {
        situation: 'the recording is empty',
        request: () => asUser(URL_OF, recorded(new Uint8Array(0))),
        status: 400,
      },
      {
        situation: 'the recording is more than five minutes’ worth of bytes',
        request: () => asUser(URL_OF, recorded(new Uint8Array(MAX_RECORDING_BYTES + 1))),
        status: 413,
      },
      {
        situation: 'what was sent is not a recording',
        request: () => asUser(URL_OF, recorded(AUDIO, {}, 'application/zip')),
        status: 415,
      },
    ])('refuses it, and never calls the model, when $situation', async ({ request, status }) => {
      whisperAnswers();

      const res = await request();

      expect(res.status).toBe(status);
      expect(asked).toHaveLength(0);
    });

    it('says so, rather than failing, where the environment cannot transcribe at all', async () => {
      const res = await asUser(URL_OF, recorded(AUDIO));

      expect(res.status).toBe(503);
    });

    it('accepts a recording of exactly five minutes’ worth of bytes', async () => {
      whisperAnswers('long');

      const res = await asUser(URL_OF, recorded(new Uint8Array(MAX_RECORDING_BYTES)));

      expect(res.status).toBe(200);
      expect(asked).toHaveLength(1);
    });
  });

  describe('an account is held to 20 transcriptions a minute', () => {
    const START = Date.parse('2026-10-12T10:00:00.000Z');

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: START });
    });
    afterEach(() => vi.useRealTimers());

    async function sendMany(count: number, userId?: string): Promise<number[]> {
      const statuses: number[] = [];
      for (let n = 0; n < count; n += 1) statuses.push((await asUser(URL_OF, recorded(AUDIO), userId)).status);
      return statuses;
    }

    it('transcribes the 20th in a minute and refuses the 21st without asking the model', async () => {
      whisperAnswers('words');

      const statuses = await sendMany(21);

      expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
      expect(statuses[20]).toBe(429);
      expect(asked).toHaveLength(20);
    });

    it('counts the refused ones, so an account that keeps asking stays refused', async () => {
      whisperAnswers('words');
      await sendMany(20);

      // Twenty more, all refused, half a minute later.
      vi.setSystemTime(START + 30_000);
      expect((await sendMany(20)).every((status) => status === 429)).toBe(true);

      // The twenty transcribed have aged out; the twenty refused have not.
      vi.setSystemTime(START + 61_000);
      expect(await sendMany(1)).toEqual([429]);
      expect(asked).toHaveLength(20);
    });

    it('transcribes again in the next minute', async () => {
      whisperAnswers('words');
      await sendMany(21);

      vi.setSystemTime(START + 61_000);

      expect(await sendMany(1)).toEqual([200]);
      expect(asked).toHaveLength(21);
    });

    it('does not count another account’s transcriptions', async () => {
      whisperAnswers('words');
      await sendMany(21);

      expect(await sendMany(1, OTHER_USER_ID)).toEqual([200]);
    });
  });

  describe('a recording is never kept', () => {
    /** How many rows each table of the register holds, bar the gateway's own record of the call. */
    async function registerRows(): Promise<Record<string, number>> {
      const { results } = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations'",
      ).all<{ name: string }>();
      const counts: Record<string, number> = {};
      for (const { name } of results) {
        if (name === 'provider_calls') continue;
        counts[name] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).first<{ n: number }>())!.n;
      }
      return counts;
    }

    async function accountRows(): Promise<Record<string, number>> {
      return inTheStore((sql) => {
        const counts: Record<string, number> = {};
        const tables = sql
          .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
          .toArray();
        for (const { name } of tables) {
          counts[name] = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`).one().n;
        }
        return counts;
      });
    }

    it('leaves nothing in the account’s store, the register or the attachments bucket, and nothing of it in the call’s record', async () => {
      whisperAnswers('buy oat milk');
      const before = { register: await registerRows(), account: await accountRows() };

      const res = await asUser(URL_OF, recorded(AUDIO));
      expect(res.status).toBe(200);

      expect(await registerRows()).toEqual(before.register);
      expect(await accountRows()).toEqual(before.account);
      expect((await env.ATTACHMENTS.list()).objects).toHaveLength(0);

      // The gateway records that a call was made, as it does for every paid call: who, what, how long.
      const { results } = await env.DB.prepare('SELECT * FROM provider_calls').all<Record<string, unknown>>();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        operation: 'transcribe-a-recording',
        account_name: ACCOUNT_NAME,
        model: TRANSCRIPTION_MODEL,
        outcome: 'ok',
      });
      expect(JSON.stringify(results[0])).not.toContain(asked[0]!.input.audio);
    });
  });

  describe('a deployment says whether it can turn a recording into words', () => {
    it.each([
      { situation: 'nothing was set up to transcribe', standIn: '', model: false, can: false },
      { situation: 'a stand-in transcribes', standIn: 'true', model: false, can: true },
      { situation: 'the model is bound', standIn: '', model: true, can: true },
    ])('$situation', async ({ standIn, model, can }) => {
      env.TRANSCRIPTION_STAND_IN = standIn;
      if (model) whisperAnswers();

      const res = await SELF.fetch('http://cockpit.test/health');

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ transcription: can });
    });
  });
});
