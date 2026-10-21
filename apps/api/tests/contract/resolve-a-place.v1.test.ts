import { afterAll, describe, expect, it } from 'vitest';
import { ClaudeAiService, type CallFor } from '../../src/ai/index.js';
import { buildResolveAPlace } from '../../src/ai/prompts/resolve-a-place.v1.js';
import type { PlaceTreeWorkspace } from '../../src/domain/spoken-path.js';

/** Whom these calls are for: nobody's, and no record is kept of them, the service being handed no recorder. */
const A_CONTRACT_RUN: CallFor = { accountName: 'contract-tests', itemId: null, triggeredBy: null };

/**
 * The contract tier for reading which places a note's words mean ("File a
 * capture on the panels you name, read from the spoken path", issue 1116):
 * the real Claude API and the real prompt, run on a pull request that changes
 * a prompt and by hand - `clean-up-a-note.v17.test.ts`'s class comment says
 * why. The behaviour held is the one the prompt was written to get: words
 * mapped onto the names they plainly mean, in other letters, and a word that
 * matches nothing left out rather than guessed.
 */

const key = process.env.ANTHROPIC_API_KEY ?? '';
const spent = { calls: 0, input: 0, output: 0 };
const resolving = new ClaudeAiService(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined, (_model, usage) => {
  spent.calls += 1;
  spent.input += usage.input_tokens;
  spent.output += usage.output_tokens;
});
afterAll(() => console.log(`resolve-a-place.v1: ${JSON.stringify(spent)}`));

const TREE: PlaceTreeWorkspace[] = [
  {
    id: 'home',
    name: 'Home',
    dashboards: [
      {
        id: 'home-day',
        name: 'Day to day',
        panels: [
          { id: 'admin', name: 'Admin & money', kind: 'items' },
          { id: 'week', name: 'This week', kind: 'items' },
        ],
      },
    ],
  },
  {
    id: 'work',
    name: 'Work',
    dashboards: [{ id: 'work-day', name: 'Hiring', panels: [{ id: 'cv', name: 'Candidates', kind: 'items' }] }],
  },
];

async function resolve(words: string) {
  const answer = await resolving.resolvePlace(words, TREE, A_CONTRACT_RUN);
  if (!('named' in answer)) throw new Error(`nothing usable came back: ${answer.discarded}`);
  return answer.named;
}

describe('Capture', () => {
  it('has a key to ask with', () => {
    expect(key, 'set ANTHROPIC_API_KEY, or put it in apps/api/.dev.vars').not.toBe('');
    expect(buildResolveAPlace('for home', [])).toMatchObject({ version: 'v1', model: 'claude-haiku-4-5' });
  });

  describe('the words saying where a note goes are read as the names they plainly mean, and nothing else', () => {
    it('reads a dashboard and a panel said in other letters', async () => {
      expect(await resolve('Day to day, admin and money')).toEqual({
        workspace: null,
        dashboard: 'Day to day',
        panels: ['Admin & money'],
      });
    });

    it('reads a workspace said alone', async () => {
      expect(await resolve('for work')).toMatchObject({ workspace: 'Work', dashboard: null, panels: [] });
    });

    it('reads two panels said together', async () => {
      expect((await resolve('on admin and money and on this week')).panels).toEqual(['Admin & money', 'This week']);
    });

    it('leaves out a name it was not shown, rather than the nearest one', async () => {
      expect(await resolve('on the groceries list')).toEqual({ workspace: null, dashboard: null, panels: [] });
    });
  });
});
