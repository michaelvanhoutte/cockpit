import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { itemsInTheInbox, splitBlocksOf, type WorkspaceSnapshot } from '@cockpit/shared';
import { DASHBOARD_ID, WORKSPACE_ID, asUser, inTheStore } from '../seed.js';
import { aModelThatReads, nextId, postChange, splitting } from './note-cleanup.support.js';

/**
 * L2: *Split* ("Brainstorming: a note holding several ideas can't be taken
 * apart", issue 1828) through the real Worker and the real store, with the model
 * faked at the network boundary. Splitting moves rows between an Item, its
 * words, its Additions and its files in one transaction, and Undo moves them
 * back in another, so each holds only against a real store. The dialog that
 * sends them is the browser's (SplitDialog.test.tsx, the F3 walk); whether the
 * real model proposes a split that holds is the contract tier's
 * (tests/contract/propose-a-split.v1.test.ts).
 */

aModelThatReads();

/** What the queue was handed, held at its binding so nothing runs behind a case: a new Item's clean-up, and a story's rewrite. */
let held: { kind: string; itemId?: string; triggeredBy?: string }[] = [];
let realQueue: typeof env.ENRICHMENT;

beforeEach(() => {
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: (typeof held)[number]) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
});

/** Lets what a change queues after it has answered settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

const envelope = () => ({ commandId: nextId(), issuedAt: '2026-11-19T10:00:00.000Z', workspaceId: WORKSPACE_ID });

const THREE_PARAGRAPHS = 'Pay the rent before Friday.\n\nBook the ferry to Texel for the 7:45 boat.\n\nAsk Sam whether the quote is final.';

async function aNote(message = THREE_PARAGRAPHS): Promise<string> {
  const itemId = nextId();
  expect((await postChange('capture_item', { ...envelope(), itemId, message })).status).toBe(200);
  return itemId;
}

async function anAddition(itemId: string, message: string): Promise<string> {
  const additionId = nextId();
  expect((await postChange('append_to_item', { ...envelope(), itemId, additionId, message })).status).toBe(200);
  return additionId;
}

async function aFile(itemId: string, filename: string): Promise<string> {
  const attachmentId = nextId();
  const res = await asUser(`http://cockpit.test/v1/items/${itemId}/attachments`, {
    method: 'POST',
    headers: {
      'content-type': 'image/png',
      'x-attachment-id': attachmentId,
      'x-command-id': nextId(),
      'x-issued-at': '2026-11-19T10:00:00.000Z',
      'x-workspace-id': WORKSPACE_ID,
      'x-filename': encodeURIComponent(filename),
    },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(res.status).toBe(201);
  return attachmentId;
}

/** The device's small copy sent to the thumbnail route, which is how a pick is made. */
async function pickThumbnail(itemId: string, attachmentId: string) {
  const res = await asUser(`http://cockpit.test/v1/items/${itemId}/attachments/${attachmentId}/thumbnail`, {
    method: 'POST',
    headers: { 'content-type': 'image/webp', 'x-command-id': nextId(), 'x-issued-at': '2026-11-19T10:00:00.000Z', 'x-workspace-id': WORKSPACE_ID },
    body: new Uint8Array([1, 2, 3]),
  });
  expect(res.status).toBe(200);
}

const thumb = async (id: string) =>
  (await inTheStore((sql) => sql.exec<{ t: string | null }>('SELECT thumbnail_attachment_id AS t FROM items WHERE id = ?', id).toArray()))[0]!.t;

async function snapshot(): Promise<WorkspaceSnapshot> {
  const res = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceSnapshot;
}

const itemOf = async (id: string) => (await snapshot()).items.find((item) => item.id === id);

/** The blocks of an Item as the dialog draws them, read from the snapshot as the browser reads it. */
async function blocksOf(itemId: string) {
  const read = await snapshot();
  const item = read.items.find((one) => one.id === itemId)!;
  return splitBlocksOf(
    item,
    (read.additions ?? []).filter((addition) => addition.itemId === itemId),
    read.attachments.filter((file) => file.itemId === itemId),
  );
}

const split = (itemId: string, was: string, children: { itemId: string; title: string; blockIds: string[]; titleTyped?: boolean }[]) =>
  postChange('split_item', { ...envelope(), itemId, was, children });

async function aPanel(name: string): Promise<string> {
  const panelId = nextId();
  expect((await postChange('add_panel', { ...envelope(), dashboardId: DASHBOARD_ID, panelId, name, kind: 'items' })).status).toBe(200);
  return panelId;
}

describe('Triage', () => {
  describe('a Split makes each ticked card a child Item holding its blocks, and the original keeps the rest', () => {
    it('makes two children from 3 paragraphs, an Addition and a file, and the original keeps what no card took', async () => {
      const original = await aNote();
      const addition = await anAddition(original, 'The ferry is 12 euro.');
      const file = await aFile(original, 'quote.png');
      const [rent, ferry] = [nextId(), nextId()];
      const blocks = await blocksOf(original);
      expect(blocks.map((block) => block.id)).toEqual(['p0', 'p1', 'p2', `a-${addition}`, `f-${file}`]);

      const answer = await split(original, THREE_PARAGRAPHS, [
        { itemId: rent, title: 'Pay the rent', blockIds: ['p0'] },
        { itemId: ferry, title: 'Book the ferry', blockIds: ['p1', `a-${addition}`, `f-${file}`] },
      ]);

      expect(answer.status).toBe(200);
      const read = await snapshot();
      expect(read.items.find((item) => item.id === original)?.description).toBe('Ask Sam whether the quote is final.');
      expect(read.items.find((item) => item.id === rent)).toMatchObject({ title: 'Pay the rent', description: 'Pay the rent before Friday.' });
      expect(read.items.find((item) => item.id === ferry)).toMatchObject({ title: 'Book the ferry', description: 'Book the ferry to Texel for the 7:45 boat.' });
      expect((read.additions ?? []).filter((one) => one.itemId === ferry).map((one) => one.message)).toEqual(['The ferry is 12 euro.']);
      expect((read.additions ?? []).filter((one) => one.itemId === original)).toEqual([]);
      expect(read.attachments.filter((one) => one.itemId === ferry).map((one) => one.filename)).toEqual(['quote.png']);
      expect(read.attachments.filter((one) => one.itemId === original)).toEqual([]);
      expect((read.children ?? []).filter((row) => row.parentId === original).map((row) => row.childId)).toEqual([rent, ferry]);
      expect(read.items.find((item) => item.id === original)).toMatchObject({ childrenCount: 2 });
    });

    it('leaves a block no card took in the original, as an unticked card does', async () => {
      const original = await aNote();
      const rent = nextId();

      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: rent, title: 'Pay the rent', blockIds: ['p0'] }])).status).toBe(200);

      expect((await itemOf(original))?.description).toBe('Book the ferry to Texel for the 7:45 boat.\n\nAsk Sam whether the quote is final.');
      expect(((await snapshot()).children ?? []).map((row) => row.childId)).toEqual([rent]);
    });

    it('applies the same split sent twice once', async () => {
      const original = await aNote();
      const rent = nextId();
      const children = [{ itemId: rent, title: 'Pay the rent', blockIds: ['p0'] }];

      expect((await split(original, THREE_PARAGRAPHS, children)).status).toBe(200);
      const again = await split(original, THREE_PARAGRAPHS, children);

      expect(again.status).toBe(200);
      expect(await again.json()).toMatchObject({ applied: false });
      expect(((await snapshot()).children ?? []).filter((row) => row.parentId === original)).toHaveLength(1);
      expect((await itemOf(original))?.description).toBe('Book the ferry to Texel for the 7:45 boat.\n\nAsk Sam whether the quote is final.');
    });

    it('puts the children inside the original and files them on no Panel, so none is in the Inbox, where the original is on a Panel', async () => {
      const original = await aNote();
      const panel = await aPanel('Home');
      expect((await postChange('add_item_to_panel', { ...envelope(), itemId: original, panelId: panel, order: [original] })).status).toBe(200);
      const [rent, ferry] = [nextId(), nextId()];

      expect(
        (
          await split(original, THREE_PARAGRAPHS, [
            { itemId: rent, title: 'Pay the rent', blockIds: ['p0'] },
            { itemId: ferry, title: 'Book the ferry', blockIds: ['p1'] },
          ])
        ).status,
      ).toBe(200);

      const read = await snapshot();
      expect(read.filings.filter((filing) => [rent, ferry].includes(filing.itemId))).toEqual([]);
      expect(await inTheStore((sql) => sql.exec('SELECT 1 FROM panel_items WHERE item_id IN (?, ?)', rent, ferry).toArray())).toEqual([]);
      const inbox = itemsInTheInbox(read.items, read.filings, read.children).map((item) => item.id);
      expect(inbox).not.toContain(rent);
      expect(inbox).not.toContain(ferry);
      expect(inbox).not.toContain(original);
    });

    it('settles an Item no Workspace owned yet in this one', async () => {
      const original = nextId();
      expect((await postChange('capture_item', { ...envelope(), itemId: original, message: THREE_PARAGRAPHS, workspaceDecided: false })).status).toBe(200);
      const rent = nextId();

      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: rent, title: 'Pay the rent', blockIds: ['p0'] }])).status).toBe(200);

      const row = (await inTheStore((sql) => sql.exec<{ workspace_decided: number }>('SELECT workspace_decided FROM items WHERE id = ?', original).toArray()))[0];
      expect(row?.workspace_decided).toBe(1);
    });

    it('makes a card with no block an Item holding its title', async () => {
      const original = await aNote();
      const empty = nextId();

      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: empty, title: 'Call the landlord', blockIds: [] }])).status).toBe(200);

      expect((await itemOf(empty))?.description).toBe('Call the landlord');
      expect((await itemOf(original))?.description).toBe(THREE_PARAGRAPHS);
    });

    it('refuses words that changed since the dialog was drawn, and a block the Item does not have, changing nothing', async () => {
      const original = await aNote();
      const rent = nextId();

      const stale = await split(original, 'Something it said before', [{ itemId: rent, title: 'Pay the rent', blockIds: ['p0'] }]);
      const unknown = await split(original, THREE_PARAGRAPHS, [{ itemId: rent, title: 'Pay the rent', blockIds: ['p7'] }]);

      expect(stale.status).toBe(400);
      expect(unknown.status).toBe(400);
      expect((await snapshot()).children ?? []).toEqual([]);
      expect((await itemOf(original))?.description).toBe(THREE_PARAGRAPHS);
    });

    it('queues each new Item to be cleaned up for a title and proposed for, and the original to be proposed for again, once', async () => {
      const original = await aNote();
      const [rent, ferry] = [nextId(), nextId()];
      const children = [
        { itemId: rent, title: 'Pay the rent', blockIds: ['p0'] },
        { itemId: ferry, title: 'Book the ferry', blockIds: ['p1'] },
      ];
      held = [];

      expect((await split(original, THREE_PARAGRAPHS, children)).status).toBe(200);
      await split(original, THREE_PARAGRAPHS, children);

      // Queued after the answers, so waited for rather than assumed. The original's own capture may still be arriving: only what the Split asked for is looked at.
      await vi.waitFor(
        () => {
          const cleanUps = held.filter((job) => job.kind === 'clean-up-a-note' && job.triggeredBy === 'split-in-app');
          expect(cleanUps.map((job) => job.itemId).sort()).toEqual([rent, ferry].sort());
          // What to do with each is proposed again where its words changed, and for each new one as for a capture.
          const proposals = held.filter((job) => job.kind === 'propose-for-claude' && [original, rent, ferry].includes(job.itemId ?? ''));
          expect(proposals.map((job) => job.itemId).sort()).toEqual([original, rent, ferry].sort());
        },
        { timeout: 10_000, interval: 25 },
      );
    });

    it('settles the texts of a card whose title was typed and asks no clean-up for it, and leaves the others proposed', async () => {
      const original = await aNote();
      const [typed, proposed] = [nextId(), nextId()];
      held = [];

      expect(
        (
          await split(original, THREE_PARAGRAPHS, [
            { itemId: typed, title: 'Ferry', blockIds: ['p1'], titleTyped: true },
            { itemId: proposed, title: 'Pay the rent', blockIds: ['p0'] },
          ])
        ).status,
      ).toBe(200);
      await settled();

      const rows = await inTheStore((sql) =>
        sql.exec<{ id: string; texts_settled_at: string | null }>('SELECT id, texts_settled_at FROM items WHERE id IN (?, ?)', typed, proposed).toArray(),
      );
      expect(rows.find((row) => row.id === typed)?.texts_settled_at).not.toBeNull();
      expect(rows.find((row) => row.id === proposed)?.texts_settled_at).toBeNull();
      const cleanUps = () => held.filter((job) => job.kind === 'clean-up-a-note' && job.triggeredBy === 'split-in-app').map((job) => job.itemId);
      await vi.waitFor(() => expect(cleanUps()).toContain(proposed), { timeout: 10_000, interval: 25 });
      expect(cleanUps()).toEqual([proposed]);
    });

    it('turns Keep its story up to date on for the original, asks no rewrite, and Undo puts back what it was', async () => {
      const [off, on] = [await aNote(), await aNote()];
      expect((await postChange('set_keeps_story', { ...envelope(), itemId: on, keepsStory: true })).status).toBe(200);
      const keeps = async (id: string) =>
        (await inTheStore((sql) => sql.exec<{ keeps_story: number }>('SELECT keeps_story FROM items WHERE id = ?', id).toArray()))[0]!.keeps_story;
      held = [];

      for (const [original, before] of [[off, false], [on, true]] as const) {
        const child = nextId();
        expect((await split(original, THREE_PARAGRAPHS, [{ itemId: child, title: 'Pay the rent', blockIds: ['p0'] }])).status).toBe(200);
        expect(await keeps(original)).toBe(1);
        const undone = await postChange('unsplit_item', {
          ...envelope(),
          itemId: original,
          description: THREE_PARAGRAPHS,
          kept: 'Book the ferry to Texel for the 7:45 boat.\n\nAsk Sam whether the quote is final.',
          keepsStory: before,
          children: [{ itemId: child, additionIds: [], attachmentIds: [] }],
        });
        expect(undone.status).toBe(200);
        expect(await keeps(original)).toBe(before ? 1 : 0);
      }
      await settled();
      expect(held.filter((job) => job.kind === 'rewrite-story')).toEqual([]);
    });

    it('settles the original’s words when it keeps its story, even where the cards took only an Addition', async () => {
      const original = await aNote();
      const addition = await anAddition(original, 'The ferry is 12 euro.');

      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: nextId(), title: 'Ferry', blockIds: [`a-${addition}`] }])).status).toBe(200);

      const row = (await inTheStore((sql) => sql.exec<{ texts_settled_at: string | null }>('SELECT texts_settled_at FROM items WHERE id = ?', original).toArray()))[0];
      expect(row?.texts_settled_at).not.toBeNull();
    });

    it('never rewrites the original, whatever its story setting', async () => {
      const original = await aNote();
      expect((await postChange('set_keeps_story', { ...envelope(), itemId: original, keepsStory: true })).status).toBe(200);
      held = [];

      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: nextId(), title: 'Pay the rent', blockIds: ['p0'] }])).status).toBe(200);
      await settled();

      expect(held.filter((job) => job.kind === 'rewrite-story')).toEqual([]);
    });
  });

  describe('Undo dismisses the new Items and restores the original', () => {
    it('splits and undoes an Item holding more Additions and files than one statement can name', async () => {
      const original = await aNote();
      const additions: string[] = [];
      for (let at = 0; at < 120; at += 1) additions.push(await anAddition(original, `Addition ${at}`));
      const ferry = nextId();
      const blockIds = ['p1', ...additions.map((id) => `a-${id}`)];

      const made = await split(original, THREE_PARAGRAPHS, [{ itemId: ferry, title: 'Book the ferry', blockIds }]);

      expect(made.status).toBe(200);
      expect(((await snapshot()).additions ?? []).filter((one) => one.itemId === ferry)).toHaveLength(120);
      const undone = await postChange('unsplit_item', {
        ...envelope(),
        itemId: original,
        description: THREE_PARAGRAPHS,
        kept: 'Pay the rent before Friday.\n\nAsk Sam whether the quote is final.',
        children: [{ itemId: ferry, additionIds: additions, attachmentIds: [] }],
      });
      expect(undone.status).toBe(200);
      expect(((await snapshot()).additions ?? []).filter((one) => one.itemId === original)).toHaveLength(120);
    });

    it('moves the thumbnail with its file, and gives it back to an original with none on Undo', async () => {
      const original = await aNote();
      const file = await aFile(original, 'quote.png');
      await pickThumbnail(original, file);
      const ferry = nextId();

      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: ferry, title: 'Book the ferry', blockIds: [`f-${file}`] }])).status).toBe(200);

      expect(await thumb(ferry)).toBe(file);
      expect(await thumb(original)).toBeNull();
      const undo = { itemId: original, description: THREE_PARAGRAPHS, kept: THREE_PARAGRAPHS, children: [{ itemId: ferry, additionIds: [], attachmentIds: [file] }] };
      expect((await postChange('unsplit_item', { ...envelope(), ...undo })).status).toBe(200);
      expect(await thumb(original)).toBe(file);
      expect(await thumb(ferry)).toBeNull();
    });

    it('leaves the original’s thumbnail where its file stays', async () => {
      const original = await aNote();
      const [file, other] = [await aFile(original, 'quote.png'), await aFile(original, 'other.png')];
      await pickThumbnail(original, file);
      const ferry = nextId();

      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: ferry, title: 'Book the ferry', blockIds: [`f-${other}`] }])).status).toBe(200);

      expect(await thumb(original)).toBe(file);
      expect(await thumb(ferry)).toBeNull();
    });

    it('keeps a thumbnail the original picked since, and leaves the child pointing at nothing', async () => {
      const original = await aNote();
      const [file, other] = [await aFile(original, 'quote.png'), await aFile(original, 'other.png')];
      await pickThumbnail(original, file);
      const ferry = nextId();
      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: ferry, title: 'Book the ferry', blockIds: [`f-${file}`] }])).status).toBe(200);
      await pickThumbnail(original, other);

      const undone = await postChange('unsplit_item', {
        ...envelope(),
        itemId: original,
        description: THREE_PARAGRAPHS,
        kept: THREE_PARAGRAPHS,
        children: [{ itemId: ferry, additionIds: [], attachmentIds: [file] }],
      });

      expect(undone.status).toBe(200);
      expect(await thumb(original)).toBe(other);
      expect(await thumb(ferry)).toBeNull();
    });

    it('leaves it all as it is when one of its Items was taken out of the original since, rather than give back words an Item still holds', async () => {
      const original = await aNote();
      const [rent, ferry] = [nextId(), nextId()];
      expect(
        (
          await split(original, THREE_PARAGRAPHS, [
            { itemId: rent, title: 'Pay the rent', blockIds: ['p0'] },
            { itemId: ferry, title: 'Book the ferry', blockIds: ['p1'] },
          ])
        ).status,
      ).toBe(200);
      expect((await postChange('remove_child', { ...envelope(), parentId: original, childId: ferry })).status).toBe(200);

      const undone = await postChange('unsplit_item', {
        ...envelope(),
        itemId: original,
        description: THREE_PARAGRAPHS,
        kept: 'Ask Sam whether the quote is final.',
        children: [
          { itemId: rent, additionIds: [], attachmentIds: [] },
          { itemId: ferry, additionIds: [], attachmentIds: [] },
        ],
      });

      expect(await undone.json()).toMatchObject({ applied: false });
      expect((await itemOf(original))?.description).toBe('Ask Sam whether the quote is final.');
      expect(await itemOf(rent)).toBeDefined();
      expect(await itemOf(ferry)).toBeDefined();
    });

    it('brings back its words, Addition and file, dismisses the children, and applies once', async () => {
      const original = await aNote();
      const addition = await anAddition(original, 'The ferry is 12 euro.');
      const file = await aFile(original, 'quote.png');
      const [rent, ferry] = [nextId(), nextId()];
      expect(
        (
          await split(original, THREE_PARAGRAPHS, [
            { itemId: rent, title: 'Pay the rent', blockIds: ['p0'] },
            { itemId: ferry, title: 'Book the ferry', blockIds: ['p1', `a-${addition}`, `f-${file}`] },
          ])
        ).status,
      ).toBe(200);
      const undo = {
        itemId: original,
        description: THREE_PARAGRAPHS,
        kept: 'Ask Sam whether the quote is final.',
        children: [
          { itemId: rent, additionIds: [], attachmentIds: [] },
          { itemId: ferry, additionIds: [addition], attachmentIds: [file] },
        ],
      };

      const first = await postChange('unsplit_item', { ...envelope(), ...undo });
      const second = await postChange('unsplit_item', { ...envelope(), ...undo });

      expect(first.status).toBe(200);
      expect(await second.json()).toMatchObject({ applied: false });
      const read = await snapshot();
      expect(read.items.find((item) => item.id === original)).toMatchObject({ description: THREE_PARAGRAPHS, childrenCount: 0 });
      expect(read.items.some((item) => [rent, ferry].includes(item.id))).toBe(false);
      expect((read.additions ?? []).filter((one) => one.itemId === original).map((one) => one.message)).toEqual(['The ferry is 12 euro.']);
      expect(read.attachments.filter((one) => one.itemId === original).map((one) => one.filename)).toEqual(['quote.png']);
    });

    it('leaves words edited since the Split as they are, and still dismisses the children', async () => {
      const original = await aNote();
      const rent = nextId();
      expect((await split(original, THREE_PARAGRAPHS, [{ itemId: rent, title: 'Pay the rent', blockIds: ['p0'] }])).status).toBe(200);
      expect((await postChange('set_description', { ...envelope(), issuedAt: '2026-11-19T10:05:00.000Z', itemId: original, description: 'My own words now.' })).status).toBe(200);

      const undone = await postChange('unsplit_item', {
        ...envelope(),
        issuedAt: '2026-11-19T10:06:00.000Z',
        itemId: original,
        description: THREE_PARAGRAPHS,
        kept: 'Book the ferry to Texel for the 7:45 boat.\n\nAsk Sam whether the quote is final.',
        children: [{ itemId: rent, additionIds: [], attachmentIds: [] }],
      });

      expect(undone.status).toBe(200);
      expect((await itemOf(original))?.description).toBe('My own words now.');
      expect(await itemOf(rent)).toBeUndefined();
    });
  });

  describe('the proposal names at most 6 Items from at most 40 blocks; with Claude down, one card holds everything', () => {
    const propose = (itemId: string) => asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/items/${itemId}/split-proposal`, { method: 'POST' });

    it('reads only the first 40 blocks and keeps at most 6 cards, each holding only blocks it was shown', async () => {
      const original = await aNote(Array.from({ length: 45 }, (_, at) => `Paragraph number ${at + 1}`).join('\n\n'));
      await aFile(original, 'secret-contents.png');
      splitting.answer = {
        language: 'English',
        items: [
          { title: 'First', blocks: [1, 2, 99] },
          ...[3, 4, 5, 6, 7, 8].map((n) => ({ title: `Item ${n}`, blocks: [n] })),
          { title: 'Too late', blocks: [41, 44] },
        ],
      };

      const answer = await propose(original);

      expect(answer.status).toBe(200);
      const { cards } = (await answer.json()) as { cards: { title: string; blockIds: string[] }[] };
      expect(cards).toHaveLength(6);
      expect(cards[0]).toEqual({ title: 'First', blockIds: ['p0', 'p1'] });
      expect(splitting.asked).toHaveLength(1);
      const sent = splitting.asked[0]!.item;
      expect(sent).toContain('(the first 40 of 46)');
      expect(sent).toContain('Paragraph number 40');
      expect(sent).not.toContain('Paragraph number 41');
      // A file is named, and nothing else of it leaves.
      expect(sent).not.toContain('secret-contents');
    });

    it.each([
      ['the model cannot be reached', () => { splitting.fails = true; }],
      ['the model answers nothing usable', () => { splitting.answer = { language: 'English', items: [{ title: '', blocks: [1] }] }; }],
    ])('answers no cards, and so one card in the dialog, where %s', async (_what, arrange) => {
      const original = await aNote();
      arrange();

      const answer = await propose(original);

      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ cards: null });
    });

    it('answers no cards, asking nothing, where there is no key or fewer than two blocks', async () => {
      const [one, many] = [await aNote('Just one idea.'), await aNote()];

      expect(await (await propose(one)).json()).toEqual({ cards: null });
      env.ANTHROPIC_API_KEY = '';
      expect(await (await propose(many)).json()).toEqual({ cards: null });

      expect(splitting.asked).toEqual([]);
    });

    it('does not name an Item of another Workspace', async () => {
      const original = await aNote();
      const answer = await asUser(`http://cockpit.test/v1/workspaces/another-workspace/items/${original}/split-proposal`, { method: 'POST' });
      expect(answer.status).toBe(404);
    });
  });
});
