import { afterAll, describe, expect, it } from 'vitest';
import type { ClaudeProposal } from '@cockpit/shared';
import { ClaudeAiService, type CallFor, type ItemToPropose } from '../../src/ai/index.js';
import { buildProposeForClaude } from '../../src/ai/prompts/propose-for-claude.v1.js';

/** Whom these calls are for: nobody's, and no record is kept of them, the service being handed no recorder. */
const A_CONTRACT_RUN: CallFor = { accountName: 'contract-tests', itemId: null, triggeredBy: null };

/**
 * The contract tier for proposing what to do with an Item ("Propose what to do
 * with each item before you look", issue 1161): the real Claude API and the real
 * prompt, run on a pull request that changes a prompt and by hand -
 * `clean-up-a-note.v16.test.ts`'s class comment says why.
 *
 * **The set is modelled on the 15 Items graded by hand on 16 October 2026, never
 * those Items themselves**: the repository is public, so each is rewritten as an
 * invented Item of the same kind - a feature idea and a bug for the person's own
 * app, mails and messages wanting a reply, research, a document to prepare, a
 * quote, a saved idea, errands only a person can run, and one Item needing two
 * actions. The bar is the hand grading's: at least 13 right on the destination
 * and the gist of the prompt.
 */

const key = process.env.ANTHROPIC_API_KEY ?? '';
const spent = { calls: 0, input: 0, output: 0 };
const proposing = new ClaudeAiService(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined, (_model, usage) => {
  spent.calls += 1;
  spent.input += usage.input_tokens;
  spent.output += usage.output_tokens;
});
afterAll(() => console.log(`propose-for-claude.v1: ${JSON.stringify(spent)}`));

const COCKPIT = 'C:\\GitHub\\Cockpit';
const PORTAL = 'C:\\Work\\northwind-portal';
const FOLDERS = [COCKPIT, PORTAL, 'C:\\Users\\alex\\Documents\\Volleyball club'];

/** What an Item should be proposed: each action's destination and the words its prompt must carry, or nothing. */
type Expected = 'nothing' | { destination: 'cowork' | 'code'; gist: RegExp; folder?: string }[];

interface Case {
  item: ItemToPropose;
  expected: Expected;
}

function item(title: string, rest: Partial<ItemToPropose> = {}): ItemToPropose {
  return { title, description: null, source: null, sender: null, workspace: 'Personal', filedOn: [], ...rest };
}

const on = (dashboard: string, panel: string) => [{ dashboard, panel }];

const SET: Case[] = [
  {
    item: item('Let a Filter panel show what is due next week, not only this week', {
      workspace: 'Cockpit',
      filedOn: on('Product', 'Feature ideas'),
    }),
    expected: [{ destination: 'code', gist: /next week/i, folder: COCKPIT }],
  },
  {
    item: item('Inbox row flickers when a capture arrives from the phone', {
      description: 'Only on the desktop, and only while the Inbox is scrolled.',
      workspace: 'Cockpit',
      filedOn: on('Product', 'Bugs'),
    }),
    expected: [{ destination: 'code', gist: /flicker/i, folder: COCKPIT }],
  },
  {
    item: item('"Make it work, make it right, make it fast." - Kent Beck', { filedOn: on('Reading', 'Quotes') }),
    expected: 'nothing',
  },
  {
    item: item('Mail the corrected invoice for September', { description: 'The VAT number on the first one was wrong.' }),
    expected: [{ destination: 'cowork', gist: /ask/i }],
  },
  {
    item: item('Can you send me the release notes for 3.2 before Thursday?', {
      description: 'Hi Alex, the clinics want to know what changes for them. Thanks, Els',
      source: 'Gmail',
      sender: 'Els Maes',
      workspace: 'Northwind Health',
    }),
    expected: [{ destination: 'cowork', gist: /release notes/i }],
  },
  {
    item: item("Sara: can we move Thursday's sync to Friday?", {
      source: 'Teams',
      sender: 'Sara Okafor',
      workspace: 'Northwind Health',
    }),
    expected: [{ destination: 'cowork', gist: /friday/i }],
  },
  {
    item: item('Prepare the workshop for the Ghent team next month', { workspace: 'Northwind Health' }),
    expected: [{ destination: 'cowork', gist: /workshop[\s\S]*ask|ask[\s\S]*workshop/i }],
  },
  {
    item: item('Pick up the parcel from the collection point', {
      description: 'Closes at six, and they only hold it for a week.',
      source: 'Gmail',
      sender: 'ParcelPoint',
      filedOn: on('Day to day', 'Errands'),
    }),
    expected: 'nothing',
  },
  {
    item: item('Look into a cheaper energy tariff', {
      description: 'Your fixed rate ends on 1 December. Here is what we can offer you from then.',
      source: 'Gmail',
      sender: 'Voltra Energy',
      filedOn: on('Day to day', 'Admin & money'),
    }),
    expected: [{ destination: 'cowork', gist: /tariff|energy/i }],
  },
  {
    item: item('Idea: a podcast about running a one-person consultancy', { filedOn: on('Someday', 'Ideas to keep') }),
    expected: 'nothing',
  },
  {
    item: item('Clinic in Ghent reports slow logins since Monday - reply to Els once we know why', {
      description: 'Els says logging in takes 20 seconds or more, only at the Ghent clinic.',
      source: 'Gmail',
      sender: 'Els Maes',
      workspace: 'Northwind Health',
      filedOn: on('Patient portal', 'Bugs'),
    }),
    expected: [
      { destination: 'code', gist: /login/i, folder: PORTAL },
      { destination: 'cowork', gist: /Els/ },
    ],
  },
  {
    item: item("Bump the Node version in the portal's CI to 24", {
      workspace: 'Northwind Health',
      filedOn: on('Patient portal', 'Tech debt'),
    }),
    expected: [{ destination: 'code', gist: /node/i, folder: PORTAL }],
  },
  {
    item: item("Slides for Thursday's steering committee on the Q4 roadmap", {
      workspace: 'Northwind Health',
      filedOn: on('Day to day', 'This week'),
    }),
    expected: [{ destination: 'cowork', gist: /slides|presentation|deck/i }],
  },
  {
    item: item('Compare the three quotes for the new laptops', {
      description: 'Quotes from Dell, Lenovo and a local reseller are attached. We need four machines.',
      workspace: 'Northwind Health',
    }),
    expected: [{ destination: 'cowork', gist: /quote/i }],
  },
  {
    item: item('Call the dentist to move the appointment', { filedOn: on('Day to day', 'Errands') }),
    expected: 'nothing',
  },
];

const answers = new Map<string, ClaudeProposal[]>();

async function propose(one: ItemToPropose): Promise<ClaudeProposal[]> {
  const known = answers.get(one.title);
  if (known) return known;
  const answer = await proposing.proposeForClaude(one, FOLDERS, A_CONTRACT_RUN);
  if (!('proposals' in answer)) throw new Error(`nothing usable came back for "${one.title}": ${answer.discarded}`);
  answers.set(one.title, answer.proposals);
  return answer.proposals;
}

/** Whether the proposals are what the grading would call right: each destination in order, each prompt carrying its gist. */
function isRight(proposals: ClaudeProposal[], expected: Expected): boolean {
  if (expected === 'nothing') return proposals.length === 1 && proposals[0]!.destination === 'nothing';
  if (proposals.length !== expected.length) return false;
  return expected.every((want, at) => {
    const got = proposals[at]!;
    return (
      got.destination === want.destination &&
      want.gist.test(got.prompt) &&
      (want.folder === undefined || got.folder === want.folder)
    );
  });
}

describe('Agents', () => {
  it('has a key to ask with', () => {
    expect(key, 'set ANTHROPIC_API_KEY, or put it in apps/api/.dev.vars').not.toBe('');
    expect(buildProposeForClaude(item('x'), [])).toMatchObject({ version: 'v1' });
  });

  describe('proposals match what was graded', () => {
    it('gets at least 13 of the 15-item set right on destination and the gist of the prompt', async () => {
      const results = await Promise.all(
        SET.map(async ({ item: one, expected }) => {
          const proposals = await propose(one).catch((error: unknown) => {
            console.log(String(error));
            return [];
          });
          return { title: one.title, right: isRight(proposals, expected), proposals };
        }),
      );
      for (const result of results.filter((one) => !one.right)) {
        console.log(`missed: ${result.title}\n${JSON.stringify(result.proposals, null, 2)}`);
      }
      expect(results.filter((one) => one.right).length).toBeGreaterThanOrEqual(13);
    });

    it('says to ask where an item lacks the recipient', async () => {
      const [first] = await propose(SET[3]!.item);
      expect(first).toMatchObject({ destination: 'cowork' });
      expect(first!.destination !== 'nothing' && first!.prompt).toMatch(/ask/i);
    });

    it('proposes nothing for a quote', async () => {
      expect(await propose(SET[2]!.item)).toEqual([{ destination: 'nothing', why: expect.any(String) }]);
    });

    it('sends a Cockpit feature idea on a Cockpit panel to Code', async () => {
      expect(await propose(SET[0]!.item)).toEqual([
        expect.objectContaining({ destination: 'code', folder: COCKPIT }),
      ]);
    });
  });
});
