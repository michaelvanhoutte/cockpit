import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { ACCOUNT_NAME, WORKSPACE_ID, asUser, inStoreAsItIs } from '../seed.js';
import { handleQueue } from '../../../src/jobs/index.js';
import type { EnrichmentJob } from '../../../src/jobs/enrichment.js';
import { ORIGIN, connected, mcp } from './connected-apps.support.js';
import { A_READING, aModelThatReads, asked, captureANote, duringThe, historyOf, isACleanUp, nextId, postChange, reading, textsOf, theModelIs } from './note-cleanup.support.js';

/**
 * Integration level: an Own note holding a web page or PDF link is read, and
 * becomes a note that says what the page says ("Capture link summaries", issue
 * 1853). The capture comes in through the real route or the connected-app
 * route, the job is the one the queue hands over (`handleQueue`), and the store
 * is real; what is faked is the model, at the network (`note-cleanup.support.ts`),
 * where Anthropic's web fetch answers as it does on the wire. Whether the real
 * model and the real fetch produce such an answer is the contract tier's
 * (apps/api/tests/contract/summarise-a-page.v1.test.ts).
 */

aModelThatReads();

const LINK = 'https://www.example.com/2026/build-times';
const PAGE = {
  readable: true,
  title: 'How we cut our build times',
  gist: 'A team explains how caching halved its build times.',
  bullets: ['Cache the dependencies', 'Split the tests', 'Measure first'],
  language: 'English',
};
const SUMMARY = `${PAGE.gist}\n\n- ${PAGE.bullets.join('\n- ')}`;
const NOT_READABLE = { readable: false, title: '', gist: '', bullets: [], language: '' };
const AS_TYPED = { source: 'internal', sender: null, link: null };

/** What the web fetch tool put in the answer: a page, or the error block a failed fetch is. */
const FETCHED = { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_fetch_result', url: LINK, content: { type: 'document' } } };
const FAILED = { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_fetch_tool_error', error_code: 'url_not_accessible' } };

/** How the model answers the page call. */
let onThePage: { says: unknown; fetch: unknown } | 'fails' = { says: PAGE, fetch: FETCHED };
/** How the model answers the page call of one link, where that differs from `onThePage`. */
let onThe: Record<string, { says: unknown; fetch: unknown } | 'fails'> = {};
/** Every page call made, as sent. */
let pageCalls: { system: string; message: string; tools: unknown; model: string }[] = [];

let held: EnrichmentJob[] = [];
let realQueue: typeof env.ENRICHMENT;

beforeEach(() => {
  onThePage = { says: PAGE, fetch: FETCHED };
  onThe = {};
  pageCalls = [];
  held = [];
  realQueue = env.ENRICHMENT;
  env.ENRICHMENT = {
    send: async (body: EnrichmentJob) => void held.push(body),
    sendBatch: async () => {
      throw new Error('nothing here sends a batch');
    },
  } as unknown as typeof env.ENRICHMENT;
  // The page call is answered here, every other call by the model `aModelThatReads` put on the network.
  const rest = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const sent = JSON.parse(input instanceof Request ? await input.clone().text() : String(init?.body ?? '{}')) as {
      model: string;
      system: { text: string }[];
      messages: { content: string }[];
      tools?: { type: string }[];
    };
    if (!sent.tools?.some((tool) => tool.type === 'web_fetch_20260209')) return rest(input, init);
    pageCalls.push({ system: sent.system.map((block) => block.text).join('\n'), message: sent.messages[0]!.content, tools: sent.tools, model: sent.model });
    const asked = /^The link: (\S+)/.exec(sent.messages[0]!.content)?.[1] ?? '';
    const answer = onThe[asked] ?? onThePage;
    if (answer === 'fails') throw new Error('the model could not be reached');
    return Response.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: sent.model,
      content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: {} }, answer.fetch, { type: 'text', text: JSON.stringify(answer.says) }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
});

afterEach(() => {
  env.ENRICHMENT = realQueue;
});

/** The note captured through the real route, and the clean-up it queued, held back until a case hands it over. */
async function captured(message: string): Promise<{ itemId: string; job: EnrichmentJob }> {
  const itemId = await captureANote({ message });
  return { itemId, job: await theJobFor(itemId) };
}

async function theJobFor(itemId: string): Promise<EnrichmentJob> {
  let job: EnrichmentJob | undefined;
  await vi.waitFor(
    () => {
      job = held.find((one) => one.kind === 'clean-up-a-note' && one.itemId === itemId);
      expect(job).toBeDefined();
    },
    { timeout: 10_000, interval: 25 },
  );
  return job!;
}

/** The held clean-up handed over as the queue would, on its `attempts`-th delivery; whether it asked to be tried again. */
async function delivered(job: EnrichmentJob, attempts = 1): Promise<{ retried: boolean }> {
  let retried = false;
  await handleQueue(
    {
      queue: 'cockpit-enrichment',
      messages: [
        {
          id: crypto.randomUUID(),
          timestamp: new Date('2026-11-13T10:00:00.000Z'),
          body: job,
          attempts,
          ack: () => {},
          retry: () => void (retried = true),
        },
      ],
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as Parameters<typeof handleQueue>[0],
    env,
  );
  return { retried };
}

/** Where an Item says it came from, read out of the store. */
async function sourceOf(itemId: string) {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ source_connector: string | null; sender: string | null; source_link: string | null }>(
        'SELECT source_connector, sender, source_link FROM items WHERE id = ? AND tenant_id = ?',
        itemId,
        ACCOUNT_NAME,
      )
      .toArray(),
  );
  const row = rows[0]!;
  return { source: row.source_connector ?? 'internal', sender: row.sender, link: row.source_link };
}

const changesTo = (itemId: string) =>
  inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ name: string }>(
        "SELECT name FROM commands WHERE tenant_id = ? AND json_extract(payload, '$.itemId') = ? AND name != 'capture_item' ORDER BY received_at",
        ACCOUNT_NAME,
        itemId,
      )
      .toArray()
      .map((row) => row.name),
  );

describe('Capture', () => {
  describe('an Own note holding a web page link is titled with the page and described with its summary, from the site', () => {
    it('a bare link: the page title, the summary alone, the site as sender and the link as source', async () => {
      const { itemId, job } = await captured(LINK);

      await delivered(job);

      expect(await sourceOf(itemId)).toEqual({ source: 'web', sender: 'example.com', link: LINK });
      expect(await textsOf(itemId)).toMatchObject({ title: PAGE.title, description: SUMMARY, captured_message: LINK });
      expect(await changesTo(itemId)).toEqual(['read_pasted_link']);
    });

    it('a link with your words: your cleaned-up words first, then the summary', async () => {
      const { itemId, job } = await captured(`${LINK} read before the Friday call`);

      await delivered(job);

      expect(await textsOf(itemId)).toMatchObject({ title: PAGE.title, description: `${A_READING.message}\n\n${SUMMARY}` });
    });

    it('the Workspace names the source Web', async () => {
      const snapshot = await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`);

      expect(((await snapshot.json()) as { sourceNames: Record<string, string> }).sourceNames.web).toBe('Web');
    });

    it('a note captured over MCP is read as well', async () => {
      const { token } = await connected();
      const said = await mcp(token, 'tools/call', { name: 'create_item', arguments: { message: LINK, workspace: 'Workspace 1' } });
      expect(said.status).toBe(200);
      await vi.waitFor(() => expect(held.some((one) => one.kind === 'clean-up-a-note')).toBe(true), { timeout: 10_000, interval: 25 });
      const job = held.find((one) => one.kind === 'clean-up-a-note')!;

      await delivered(job);

      expect(await sourceOf((job as { itemId: string }).itemId)).toEqual({ source: 'web', sender: 'example.com', link: LINK });
    });
  });

  describe('a note with several links: the first 3 are each summarised under their page title, in the order they appear', () => {
    const B = 'https://blog.example.org/second';
    const C = 'https://news.example.net/third';
    const D = 'https://example.com/fourth';
    const pageOf = (title: string) => ({ says: { ...PAGE, title }, fetch: FETCHED });
    const summaryOf = (title: string) => `**${title}**

${SUMMARY}`;

    beforeEach(() => {
      onThe = { [LINK]: pageOf('First page'), [B]: pageOf('Second page'), [C]: pageOf('Third page'), [D]: pageOf('Fourth page') };
    });

    it('two links with words: the title from your words, then two summaries, each under its bold page title', async () => {
      const { itemId, job } = await captured(`compare ${LINK} and ${B}`);

      await delivered(job);

      expect(await textsOf(itemId)).toMatchObject({ title: A_READING.title, description: `${A_READING.message}

${summaryOf('First page')}

${summaryOf('Second page')}` });
      expect(await sourceOf(itemId)).toEqual({ source: 'web', sender: 'example.com', link: LINK });
      expect(await changesTo(itemId)).toEqual(['read_pasted_link']);
    });

    it('two links and no words: the first page’s title, and the summaries alone', async () => {
      const { itemId, job } = await captured(`${LINK}
${B}`);

      await delivered(job);

      expect(await textsOf(itemId)).toMatchObject({ title: 'First page', description: `${summaryOf('First page')}

${summaryOf('Second page')}` });
    });

    it('four links: the first three are asked, and the fourth is not', async () => {
      const { itemId, job } = await captured(`${LINK} ${B} ${C} ${D}`);

      await delivered(job);

      expect(pageCalls.map((call) => /^The link: (\S+)/.exec(call.message)![1])).toEqual([LINK, B, C]);
      expect((await textsOf(itemId))?.description).not.toContain('Fourth page');
    });

    it('the second of three not readable: the first and third are written, and the source is the first', async () => {
      onThe[B] = { says: NOT_READABLE, fetch: FETCHED };
      const { itemId, job } = await captured(`${LINK} ${B} ${C}`);

      await delivered(job);

      expect((await textsOf(itemId))?.description).toBe(`${A_READING.message}

${summaryOf('First page')}

${summaryOf('Third page')}`);
      expect(await sourceOf(itemId)).toEqual({ source: 'web', sender: 'example.com', link: LINK });
    });

    it('the first not readable: the source link and sender are the second’s', async () => {
      onThe[LINK] = { says: NOT_READABLE, fetch: FETCHED };
      const { itemId, job } = await captured(`${LINK} ${B}`);

      await delivered(job);

      expect(await sourceOf(itemId)).toEqual({ source: 'web', sender: 'blog.example.org', link: B });
    });

    it('none readable: the usual clean-up, and no source', async () => {
      onThe = { [LINK]: { says: NOT_READABLE, fetch: FETCHED }, [B]: { says: NOT_READABLE, fetch: FETCHED } };
      const { itemId, job } = await captured(`${LINK} ${B}`);

      await delivered(job);

      expect(await sourceOf(itemId)).toEqual(AS_TYPED);
      expect(await changesTo(itemId)).toEqual(['propose_item_texts']);
    });

    it('a site that does not answer, before the last try: the job is tried again and nothing is written', async () => {
      onThe[B] = 'fails';
      const { itemId, job } = await captured(`${LINK} ${B}`);

      expect(await delivered(job)).toEqual({ retried: true });

      expect(await sourceOf(itemId)).toEqual(AS_TYPED);
      expect(await changesTo(itemId)).toEqual([]);
    });

    it('a site that does not answer, on the last try: the others are written, and that link stays plain', async () => {
      onThe[B] = 'fails';
      const { itemId, job } = await captured(`${LINK} ${B}`);

      expect(await delivered(job, 4)).toEqual({ retried: false });

      expect(await textsOf(itemId)).toMatchObject({ title: 'First page', description: `${A_READING.message}\n\n${SUMMARY}` });
      expect((await textsOf(itemId))?.description).not.toContain('Second page');
      expect(await sourceOf(itemId)).toEqual({ source: 'web', sender: 'example.com', link: LINK });
    });
  });

  describe('the page is only ever shown to its own call, and its own call only the link', () => {
    it('the summary call carries the prompt and the link, and the clean-up call the note as typed', async () => {
      const { job } = await captured(`${LINK} read before the Friday call`);

      await delivered(job);

      expect(pageCalls).toHaveLength(1);
      expect(pageCalls[0]).toMatchObject({
        message: `The link: ${LINK}

The person's note, only a hint for which language to write in:
read before the Friday call`,
        model: 'claude-sonnet-5-5',
      });
      expect(pageCalls[0]!.system).not.toContain('Examples.');
      expect(asked.at(-1)?.note).toBe(`${LINK} read before the Friday call`);
      expect(asked.at(-1)?.system).not.toContain(PAGE.title);
    });

    it('an answer carrying a field it was not asked for is refused whole: the note stays as typed', async () => {
      onThePage = { says: { ...PAGE, priority: 'high', dueDate: '2026-12-01' }, fetch: FETCHED };
      const { itemId, job } = await captured(LINK);

      await delivered(job);

      expect(await sourceOf(itemId)).toEqual(AS_TYPED);
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
    });
  });

  describe('a page that cannot be read leaves a normal note, with no summary and no source', () => {
    it.each([
      { situation: 'the model says it is a login wall', page: { says: NOT_READABLE, fetch: FETCHED } },
      { situation: 'the web fetch returned an error block', page: { says: PAGE, fetch: FAILED } },
    ])('$situation', async ({ page }) => {
      onThePage = page;
      const { itemId, job } = await captured(LINK);

      await delivered(job);

      expect(await sourceOf(itemId)).toEqual(AS_TYPED);
      expect(await textsOf(itemId)).toMatchObject({ title: A_READING.title, description: A_READING.message });
      expect(await changesTo(itemId)).toEqual(['propose_item_texts']);
    });

    it('the call failing before the last try: tried again later, and nothing written', async () => {
      onThePage = 'fails';
      const { itemId, job } = await captured(LINK);

      expect(await delivered(job)).toEqual({ retried: true });

      expect(await sourceOf(itemId)).toEqual(AS_TYPED);
      expect(await changesTo(itemId)).toEqual([]);
    });

    it('the call failing on the last try: the usual clean-up, and no source', async () => {
      onThePage = 'fails';
      const { itemId, job } = await captured(LINK);

      expect(await delivered(job, 4)).toEqual({ retried: false });

      expect(await sourceOf(itemId)).toEqual(AS_TYPED);
      expect((await textsOf(itemId))?.title).toBe(A_READING.title);
    });

    it('no Claude key: nothing is read, and nothing is asked', async () => {
      const { itemId, job } = await captured(LINK);
      env.ANTHROPIC_API_KEY = '';

      await delivered(job);

      expect(pageCalls).toEqual([]);
      expect(await sourceOf(itemId)).toEqual(AS_TYPED);
    });
  });

  describe('the clean-up of the note failing does not spend the page read', () => {
    it('before the last try: tried again, with the page not written yet and the failure the clean-up’s own', async () => {
      const { itemId, job } = await captured(`${LINK} read before the Friday call`);
      theModelIs('fails');

      expect(await delivered(job)).toEqual({ retried: true });

      expect(await sourceOf(itemId)).toEqual(AS_TYPED);
      expect(await changesTo(itemId)).toEqual([]);
      expect((await historyOf(itemId))[0]).toMatchObject({ status: 'failed' });
    });

    it('the page call failing before the last try fails the attempt in the history', async () => {
      onThePage = 'fails';
      const { itemId, job } = await captured(LINK);

      expect(await delivered(job)).toEqual({ retried: true });

      expect((await historyOf(itemId))[0]).toMatchObject({ status: 'failed' });
    });
  });

  describe('the history records the texts the Item holds', () => {
    it('the page’s title and the description with its summary, not the clean-up’s own proposal', async () => {
      const { itemId, job } = await captured(`${LINK} read before the Friday call`);

      await delivered(job);

      expect((await historyOf(itemId))[0]).toMatchObject({ titleAfter: PAGE.title, descriptionAfter: `${A_READING.message}

${SUMMARY}` });
    });
  });

  describe('a text you edited before the read lands is kept, while the source, link and sender still land', () => {
    const editTitle = (itemId: string) =>
      postChange('set_title', { commandId: nextId(), issuedAt: '2026-09-09T10:00:01.000Z', workspaceId: WORKSPACE_ID, itemId, title: 'Mine' });

    it('a title edited while the note is being read', async () => {
      const { itemId, job } = await captured(LINK);
      reading.during = duringThe(isACleanUp, async () => expect((await editTitle(itemId)).status).toBe(200));

      await delivered(job);

      expect(await sourceOf(itemId)).toEqual({ source: 'web', sender: 'example.com', link: LINK });
      expect((await textsOf(itemId))?.title).toBe('Mine');
      expect((await historyOf(itemId))[0]).toMatchObject({ status: 'left-as-is' });
    });

    it('a title edited before the job ran: the page is still read in', async () => {
      const { itemId, job } = await captured(LINK);
      expect((await editTitle(itemId)).status).toBe(200);

      await delivered(job);

      expect(await sourceOf(itemId)).toEqual({ source: 'web', sender: 'example.com', link: LINK });
      expect((await textsOf(itemId))?.title).toBe('Mine');
    });
  });

  describe('a note that has a source link is never read again', () => {
    it('the same job delivered twice: nothing is called and nothing written the second time', async () => {
      const { itemId, job } = await captured(LINK);
      await delivered(job);
      const texts = await textsOf(itemId);
      onThePage = { says: { ...PAGE, title: 'Another title' }, fetch: FETCHED };

      await delivered(job);

      expect(pageCalls).toHaveLength(1);
      expect(await textsOf(itemId)).toEqual(texts);
      expect(await changesTo(itemId)).toEqual(['read_pasted_link']);
    });
  });
});
