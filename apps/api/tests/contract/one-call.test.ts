import { afterAll, describe, expect, it } from 'vitest';
import type { EditToRemember, ItemToPlace, ItemToPropose } from '../../src/ai/index.js';
import type { PlaceTreeWorkspace } from '../../src/domain/spoken-path.js';
import { A_CONTRACT_RUN, claude, hasAKey } from './support/claude.js';

/**
 * The contract tier's check on Claude: **one call per prompt, on an ordinary
 * note, asserting only that the answer parses into that prompt's result** - the
 * request is accepted and what comes back is what the code reads. It runs on
 * every contract run, a pull request touching the AI layer and the weekly one
 * alike, because it is about five calls (`.github/workflows/contract.yml`). A
 * red check here means the API or the parsing moved, never the model's
 * judgement: what each prompt is held to is the behaviour suite beside it
 * (`clean-up-a-note.v17.test.ts` and the others), which runs only when it is
 * named and costs about a hundred calls.
 *
 * **Every prompt in `src/ai/prompts/` has a check here, named by its versioned
 * file** (`scripts/lib/contract-selection.test.mjs`), so a prompt added or
 * moved to a new version without one fails `pnpm test:scripts`.
 */

const spent = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
const asking = claude((_model, usage) => {
  spent.calls += 1;
  spent.input += usage.input_tokens;
  spent.cacheRead += usage.cache_read_input_tokens ?? 0;
  spent.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  spent.output += usage.output_tokens;
});
afterAll(() => console.log(`one-call: ${JSON.stringify(spent)}`));

const NOTE = 'call the dentist tomorrow to book a check-up';
const PANELS = [
  { id: '018f0000-0000-7000-8000-000000000001', name: 'Errands' },
  { id: '018f0000-0000-7000-8000-000000000002', name: 'Work' },
];
const TREE: PlaceTreeWorkspace[] = [
  {
    id: 'home',
    name: 'Home',
    dashboards: [{ id: 'home-day', name: 'Day to day', panels: [{ id: 'errands', name: 'Errands', kind: 'items' }] }],
  },
];

describe('Capture', () => {
  hasAKey();

  it('clean-up-a-note.v17 answers with a proposal, not a discard', async () => {
    const answer = await asking.cleanUpNote(NOTE, PANELS, [], [], [], null, { date: '2026-10-13', weekday: 'Tuesday' }, A_CONTRACT_RUN);
    expect(answer, JSON.stringify(answer)).toHaveProperty('proposal');
  });

  it('resolve-a-place.v1 answers with the places it read', async () => {
    const answer = await asking.resolvePlace('for home, errands', TREE, A_CONTRACT_RUN);
    expect(answer, JSON.stringify(answer)).toHaveProperty('named');
  });
});

describe('Triage', () => {
  hasAKey();

  it('choose-a-panel.v3 answers with a panel choice, not a discard', async () => {
    const item: ItemToPlace = { capturedMessage: NOTE, title: 'Book a dentist check-up', description: null };
    const answer = await asking.choosePanel(item, PANELS, [], [], A_CONTRACT_RUN);
    expect(answer, JSON.stringify(answer)).toHaveProperty('panel');
  });
});

describe('Agents', () => {
  hasAKey();

  it('propose-for-claude.v4 answers with a list of proposals, not a discard', async () => {
    const item: ItemToPropose = {
      title: 'Mail the corrected invoice for September',
      description: 'The VAT number on the first one was wrong.',
      source: null,
      sender: null,
      workspace: 'Personal',
      filedOn: [],
    };
    const answer = await asking.proposeForClaude(item, ['C:\\Users\\alex\\Documents'], [], [], A_CONTRACT_RUN);
    expect(answer, JSON.stringify(answer)).toHaveProperty('proposals');
  });

  it('remember-a-sentence.v1 answers with an offer, or with nothing worth remembering', async () => {
    const edit: EditToRemember = {
      title: 'Can you send me the Q3 VAT figures before Friday?',
      description: null,
      source: 'Gmail',
      sender: 'Ruben Claes',
      workspaces: ['Personal'],
      proposed: { destination: 'cowork', folder: '', prompt: 'Draft a reply to Ruben Claes, in English, promising the figures before Friday.' },
      sent: { destination: 'cowork', folder: '', prompt: 'Schrijf kort een antwoord aan Ruben Claes in het Nederlands.' },
    };
    const read = await asking.offerSentence(edit, [{ id: '018f0000-0000-7000-8000-000000000003', name: 'Personal' }], A_CONTRACT_RUN);
    // Declining to offer is an answer the code read; any other `none` is the answer not parsing.
    if ('none' in read) expect(read.none).toBe('nothing worth remembering');
    else expect(read).toHaveProperty('offer');
  });
});
