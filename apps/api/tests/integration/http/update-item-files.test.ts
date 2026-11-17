import { beforeEach, describe, expect, inject, it } from 'vitest';
import { SELF, env, applyD1Migrations } from 'cloudflare:test';
import type { Attachment, Item } from '@cockpit/shared';
import { USER_ID, WORKSPACE_ID, accountOf, asUser, seedRegister, startFromEmpty, withoutTheGuide } from '../seed.js';
import { ORIGIN, connected, mcp } from './connected-apps.support.js';

interface ToolAnswer {
  isError?: boolean;
  content: { type: string; text: string }[];
}

/**
 * Integration level, through the whole Worker: a connected app adding and
 * removing an Item's files ("MCP changes and deletes: add and remove files in
 * create_item and update_item", issue 1813). Every case enters through `/mcp`
 * and checks the account's own record and the attachments bucket, since that the
 * bytes are put, recorded with the size R2 measured, and served back by the
 * download route and the link `find_items` gives are facts about the Worker, the
 * store and R2 together. How a file argument is read is proved at L1
 * (tests/unit/mcp/files.test.ts).
 */

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await withoutTheGuide();
});

let seq = 0;
const nextId = () => `018f0000-0000-7000-8000-${String(++seq).padStart(12, '0')}`;

async function anItem(message: string): Promise<string> {
  const itemId = nextId();
  const captured = await asUser(`${ORIGIN}/v1/commands/capture_item`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt: '2026-01-01T00:00:00.000Z', workspaceId: WORKSPACE_ID, itemId, message }),
  });
  expect(captured.status).toBe(200);
  return itemId;
}

async function snapshot(): Promise<{ items: Item[]; attachments: Attachment[] }> {
  return (await (await asUser(`${ORIGIN}/v1/workspaces/${WORKSPACE_ID}/snapshot`)).json()) as { items: Item[]; attachments: Attachment[] };
}

/** The files the account holds for an Item, by name. */
async function filesOf(itemId: string): Promise<Attachment[]> {
  return (await snapshot()).attachments.filter((one) => one.itemId === itemId);
}

async function call(token: string, tool: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const answer = await mcp(token, 'tools/call', { name: tool, arguments: args });
  expect(answer.status).toBe(200);
  return ((await answer.json()) as { result: ToolAnswer }).result;
}
const textOf = (answer: ToolAnswer) => answer.content[0]!.text;

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3]);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
const file = (name: string, content_type: string, bytes: Uint8Array) => ({
  name,
  content_type,
  content_base64: Buffer.from(bytes).toString('base64'),
});
const objectsInBucket = async () => (await env.ATTACHMENTS.list()).objects.length;

describe('MCP connections', () => {
  describe('a file sent over MCP becomes an Attachment of the item, as one uploaded in the form does', () => {
    it('puts a PDF on the item with the size R2 stored, and the download route serves it back', async () => {
      const { token } = await connected();
      const itemId = await anItem('Send the quote');

      const said = await call(token, 'update_item', { id: itemId, add_files: [file('quote.pdf', 'application/pdf', PDF)] });

      expect(said.isError).toBeFalsy();
      expect(textOf(said)).toContain('files: added "quote.pdf"');
      const [attached] = await filesOf(itemId);
      expect(attached).toMatchObject({ filename: 'quote.pdf', contentType: 'application/pdf', size: PDF.byteLength });
      const stored = await env.ATTACHMENTS.head(`${accountOf(USER_ID)}/${itemId}/${attached!.id}`);
      expect(stored?.size).toBe(attached!.size);
      const download = await asUser(`${ORIGIN}/v1/attachments/${attached!.id}`);
      expect(download.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF);
    });

    it('takes a call whose body is over the transport’s own 4 MiB, within the cap, and refuses one over the cap', async () => {
      const { token } = await connected();
      const itemId = await anItem('A large scan');
      const scan = (name: string, megabytes: number) => file(name, 'application/pdf', new Uint8Array(megabytes * 1024 * 1024).fill(9));

      const within = await call(token, 'update_item', { id: itemId, add_files: [scan('a.pdf', 5), scan('b.pdf', 5)] });
      const over = await call(token, 'update_item', { id: itemId, add_files: [scan('c.pdf', 5), scan('d.pdf', 5), file('e.pdf', 'application/pdf', PDF)] });

      expect(within.isError).toBeFalsy();
      expect((await filesOf(itemId)).map((one) => [one.filename, one.size])).toEqual([
        ['a.pdf', 5 * 1024 * 1024],
        ['b.pdf', 5 * 1024 * 1024],
      ]);
      expect(over.isError).toBe(true);
      expect(textOf(over)).toContain('10 MB');
    });

    it('captures one item with both files when create_item is given two', async () => {
      const { token } = await connected();

      const said = await call(token, 'create_item', {
        message: 'Quote and photo for Bart',
        workspace: 'Workspace 1',
        add_files: [file('quote.pdf', 'application/pdf', PDF), file('site.png', 'image/png', PNG)],
      });

      expect(said.isError).toBeFalsy();
      expect(textOf(said)).toContain('with "quote.pdf"');
      const items = (await snapshot()).items.filter((item) => item.capturedMessage === 'Quote and photo for Bart');
      expect(items).toHaveLength(1);
      expect((await filesOf(items[0]!.id)).map((one) => [one.filename, one.size])).toEqual([
        ['quote.pdf', PDF.byteLength],
        ['site.png', PNG.byteLength],
      ]);
    });

    it('leaves the other file where remove_files names one of two', async () => {
      const { token } = await connected();
      const itemId = await anItem('Two files');
      await call(token, 'update_item', {
        id: itemId,
        add_files: [file('quote.pdf', 'application/pdf', PDF), file('site.png', 'image/png', PNG)],
      });

      const said = await call(token, 'update_item', { id: itemId, remove_files: ['quote.pdf'] });

      expect(said.isError).toBeFalsy();
      expect(textOf(said)).toContain('removed "quote.pdf"');
      expect((await filesOf(itemId)).map((one) => one.filename)).toEqual(['site.png']);
    });

    it('refuses a name two files share and removes nothing', async () => {
      const { token } = await connected();
      const itemId = await anItem('Twins');
      await call(token, 'update_item', {
        id: itemId,
        add_files: [file('scan.png', 'image/png', PNG), file('scan.png', 'image/png', PNG), file('other.pdf', 'application/pdf', PDF)],
      });

      const said = await call(token, 'update_item', { id: itemId, remove_files: ['other.pdf', 'scan.png'] });

      expect(said.isError).toBe(true);
      expect(textOf(said)).toContain('none was removed');
      expect(await filesOf(itemId)).toHaveLength(3);
    });

    it('refuses a name the item has no file of, naming the files it has', async () => {
      const { token } = await connected();
      const itemId = await anItem('One file');
      await call(token, 'update_item', { id: itemId, add_files: [file('quote.pdf', 'application/pdf', PDF)] });

      const said = await call(token, 'update_item', { id: itemId, remove_files: ['invoice.pdf'] });

      expect(said.isError).toBe(true);
      expect(textOf(said)).toContain('no file called "invoice.pdf"');
      expect(textOf(said)).toContain('"quote.pdf"');
      expect(await filesOf(itemId)).toHaveLength(1);
    });

    it('stores nothing for a call refused on any argument, a bad file after a good one included', async () => {
      const { token } = await connected();
      const itemId = await anItem('Mixed');
      const before = await objectsInBucket();

      const said = await call(token, 'update_item', {
        id: itemId,
        add_files: [file('quote.pdf', 'application/pdf', PDF), file('setup.exe', 'application/zip', PNG)],
      });

      expect(said.isError).toBe(true);
      expect(await objectsInBucket()).toBe(before);
      expect(await filesOf(itemId)).toHaveLength(0);
    });

    it('refuses an id of no item, with no attachment row, and puts no object for it', async () => {
      const { token } = await connected();
      const before = await objectsInBucket();

      const said = await call(token, 'update_item', { id: nextId(), add_files: [file('quote.pdf', 'application/pdf', PDF)] });

      expect(said.isError).toBe(true);
      expect((await snapshot()).attachments).toHaveLength(0);
      expect(await objectsInBucket()).toBe(before);
    });
  });

  describe('find_items gives the link of a file an app added', () => {
    it('names the file with a link that, fetched with no cookie, gives the file', async () => {
      const { token } = await connected();
      const itemId = await anItem('A quote to send');
      await call(token, 'update_item', { id: itemId, add_files: [file('quote.pdf', 'application/pdf', PDF)] });

      const found = await call(token, 'find_items', { text: 'quote' });

      const link = /^- quote\.pdf: (https?:\/\/\S+)$/m.exec(textOf(found))?.[1];
      expect(link).toBeDefined();
      const opened = await SELF.fetch(link!);
      expect(opened.status).toBe(200);
      expect(new Uint8Array(await opened.arrayBuffer())).toEqual(PDF);
    });
  });
});
