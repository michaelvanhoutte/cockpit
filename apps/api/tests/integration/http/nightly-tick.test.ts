import { beforeEach, afterEach, describe, expect, inject, it, vi } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { ACCOUNT_NAME, alsoWorkspaces, seedRegister, startFromEmpty } from '../seed.js';
import { handleQueue, handleScheduled } from '../../../src/jobs/index.js';

/**
 * Integration level, against the real register and the real per-account
 * stores: what the once-a-night run actually does, now that the filing
 * summary it was first wired for is gone ("Show what the system learned, in a
 * sentence you can correct", issue 301; "Drop the nightly filing summary,
 * keep the sentence you wrote", issue 392).
 *
 * **Two rules that only hold together.** The run stops asking for summaries,
 * and a request for one written before that deploy and still waiting after it
 * is refused rather than acted on - the same deploy makes the first true and
 * the second necessary, and proving only the first would leave the interval
 * between the deploy and the queue draining untested.
 *
 * That the guest account is still put back on this same tick is
 * `../accounts/guest-reset.test.ts`'s question, which drives both ways in.
 */

async function runTheNight(): Promise<void> {
  // `ScheduledController` is not read by `handleScheduled` (the single cron
  // schedule wrangler.jsonc declares is the only one there is to dispatch
  // on), so an empty stand-in is the whole of what a test needs.
  await handleScheduled({} as never, env);
}

/** One message, and the two ways it can end, as the consumer is handed them. */
function oneRequestFor(body: unknown) {
  const message = {
    id: 'message-1',
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch = {
    queue: 'cockpit-enrichment',
    messages: [message],
    ackAll: () => {},
    retryAll: () => {},
  } as unknown as Parameters<typeof handleQueue>[0];
  return { batch, message };
}

let asked: ReturnType<typeof vi.spyOn>;
let complained: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  // Set, deliberately: the run must ask for nothing because there is nothing
  // left to ask for, not because this environment could not have paid for it.
  env.ANTHROPIC_API_KEY = 'a-key-that-proves-nothing-here';
  asked = vi.spyOn(env.ENRICHMENT, 'send');
  complained = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  env.ANTHROPIC_API_KEY = '';
  vi.restoreAllMocks();
});

describe('What Cockpit has learned', () => {
  /**
   * The fan-out this file was written for. It enumerated every account and
   * every Workspace once a night and asked for a paragraph about each, and
   * nothing ever read a word of it back - so the whole loop is gone and the
   * night's work is the guest account and nothing else.
   */
  describe('the nightly run asks for nothing about how you file', () => {
    it('asks for nothing, across every account and every workspace they hold', async () => {
      // Several accounts, several Workspaces each: the arrangement the old
      // fan-out queued the most under, so an accidental survivor would show
      // here rather than hide behind a one-Workspace account.
      await alsoWorkspaces();

      await runTheNight();

      expect(asked).not.toHaveBeenCalled();
    });
  });

  /**
   * The interval between the deploy and the queue draining. A request written
   * by the previous version of this Worker is still on the queue when this one
   * picks it up, and the discriminated union is what refuses it rather than
   * reading it as something else - the failure mode this issue named, proved
   * rather than assumed.
   */
  describe('a request for something Cockpit no longer does is refused, not mistaken for something else', () => {
    it.each([
      {
        situation: 'a summary asked for before it was dropped',
        body: { kind: 'summarize-workspace', accountName: ACCOUNT_NAME, workspaceId: 'ws-1' },
      },
      {
        situation: 'a request naming nothing this version has ever done',
        body: { kind: 'polish-the-brass', accountName: ACCOUNT_NAME, workspaceId: 'ws-1' },
      },
    ])('is set aside and said out loud, for $situation', async ({ body }) => {
      const { batch, message } = oneRequestFor(body);
      // Installed here rather than for the whole file: this is the only case
      // that reads it, and it wraps every request the runner itself makes.
      const wentOut = vi.spyOn(globalThis, 'fetch');

      await handleQueue(batch, env);

      // Set aside rather than tried again: no later delivery will make this
      // version understand it.
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
      expect(complained).toHaveBeenCalled();
      // And nothing was asked of the model on the way to refusing it, which
      // is what "refused rather than misread" has to mean to be worth
      // anything - a surviving branch would reach `aiFor` and pay for a call.
      const went = wentOut.mock.calls as unknown as unknown[][];
      expect(went.some((call) => String(call[0]).includes('anthropic.com'))).toBe(false);
    });
  });
});
