import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PART_BYTES } from '../../src/tests';
import {
  emptyTheDatabase,
  sendEveryTestsPart,
  sendTestsArea,
  sendTestsTree,
  showTests,
  storedTests,
  testsAreas,
  testsTree,
  theTests,
  WRITE_KEY,
} from './support';

beforeEach(emptyTheDatabase);

/** Areas as the tree names them, about as many as the product has. */
const AREAS = testsAreas(37);
const A = 'aaaaaaa';
const B = 'bbbbbbb';
const C = 'ccccccc';

/** `commit`'s tests sent whole and shown. */
async function shown(commit: string) {
  await sendEveryTestsPart(commit, AREAS);
  expect((await showTests(commit)).status).toBe(200);
}

/** commit's tree and only its first count areas sent. */
async function unfinished(commit: string, count: number) {
  expect((await sendTestsTree(commit, testsTree(commit, AREAS))).status).toBe(200);
  for (const area of AREAS.slice(0, count)) expect((await sendTestsArea(commit, area)).status).toBe(200);
}

describe('Harness Monitor', () => {
  describe("main's tests are shown only once every part of them has arrived, and until then the ones before are", () => {
    it('the tree and all 37 areas sent, then shown, answers the new commit', async () => {
      await shown(A);
      await shown(B);

      expect(await theTests()).toMatchObject({ commit: B, coverageAvailable: true });
    });

    it('the tree and 20 areas sent, and not shown, still answers the commit before', async () => {
      await shown(A);
      await unfinished(B, 20);

      expect(await theTests()).toMatchObject({ commit: A });
    });

    it.each([
      { situation: 'with 17 areas still to come', send: async () => unfinished(B, 20), missing: /missing 17 parts: area "Area 21", area "Area 22", .*area "Area 37"\.$/ },
      { situation: 'with not even the tree sent', send: async () => {}, missing: /missing the tree\.$/ },
    ])('showing them $situation is refused, naming what is missing, and the ones before stay shown', async ({ send, missing }) => {
      await shown(A);
      await send();

      const response = await showTests(B);

      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(missing);
      expect(await theTests()).toMatchObject({ commit: A });
    });
  });

  describe("showing main's latest tests deletes the ones before and any left unfinished", () => {
    it.each([
      { situation: 'A shown, then B shown', before: async () => shown(A) },
      {
        situation: 'A shown and C left unfinished, then B shown',
        before: async () => {
          await shown(A);
          await unfinished(C, 5);
        },
      },
    ])('$situation leaves only B stored', async ({ before }) => {
      await before();

      await shown(B);

      expect(await storedTests()).toEqual({ commits: [{ commit: B, areas: 37 }], current: B });
    });
  });

  describe("sending main's next tests deletes any left unfinished, and keeps the ones shown", () => {
    it("A shown and C left unfinished, then B's tree sent, leaves A shown and C deleted", async () => {
      await shown(A);
      await unfinished(C, 5);

      expect((await sendTestsTree(B, testsTree(B, AREAS))).status).toBe(200);

      expect(await storedTests()).toEqual({
        commits: [
          { commit: A, areas: 37 },
          { commit: B, areas: 0 },
        ],
        current: A,
      });
    });
  });

  describe("sending main's tests again stores them once", () => {
    it('every part of B sent twice, then shown, holds one copy of B', async () => {
      await sendEveryTestsPart(B, AREAS);
      await sendEveryTestsPart(B, AREAS);
      expect((await showTests(B)).status).toBe(200);

      expect(await storedTests()).toEqual({ commits: [{ commit: B, areas: 37 }], current: B });
    });
  });

  describe("a part of main's tests that is refused stores nothing of it", () => {
    it.each([
      { situation: 'an area of the wrong shape', send: () => sendTestsArea(B, 'Area 1', { 'a.test.ts:3': 'line three' }), status: 400, error: /^Area "Area 1": "a.test.ts:3" is not a list/ },
      { situation: 'an area the tree does not name', send: () => sendTestsArea(B, 'Area 99'), status: 400, error: /names no area "Area 99"/ },
      { situation: 'a tree of the wrong shape', send: () => sendTestsTree(B, testsTree(B, AREAS, { coverageAvailable: 'yes' })), status: 400, error: /whether coverage was available/ },
    ])('$situation is refused, naming it', async ({ send, status, error }) => {
      await sendTestsTree(B, testsTree(B, AREAS));

      const response = await send();

      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: string }).error).toMatch(error);
      expect(await storedTests()).toEqual({ commits: [{ commit: B, areas: 0 }], current: null });
    });

    it('an area over the size one part may hold, sent without its length, is refused naming the limit, and nothing of it is stored', async () => {
      await sendTestsTree(B, testsTree(B, AREAS));
      // A stream of its own, not a Blob's, so the request declares no length.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_PART_BYTES + 1));
          controller.close();
        },
      });

      const response = await SELF.fetch(`https://monitor.test/v1/tests/main/${B}/areas/Area%201`, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip', authorization: `Bearer ${WRITE_KEY}` },
        body,
      });

      expect(response.status).toBe(413);
      expect(((await response.json()) as { error: string }).error).toMatch(/^Area "Area 1" is at least [\d,]+ bytes gzipped, over the 1,900,000 a part may hold/);
      expect(await storedTests()).toEqual({ commits: [{ commit: B, areas: 0 }], current: null });
    });

    it('an area sent before its tree is refused, and nothing is stored', async () => {
      const response = await sendTestsArea(B, 'Area 1');

      expect(response.status).toBe(409);
      expect(await storedTests()).toEqual({ commits: [], current: null });
    });
  });

  describe("a send reads which commit's tests are shown, so it can refuse to show older ones", () => {
    it('it answers none before any are shown, then the commit shown, not one still being sent', async () => {
      const current = async () => (await (await SELF.fetch('https://monitor.test/v1/tests/main')).json()) as Record<string, unknown>;
      expect(await current()).toEqual({ snapshot: 'main', current: null });

      await shown(A);
      await unfinished(B, 5);

      expect(await current()).toEqual({ snapshot: 'main', current: A });
    });
  });

  describe("the tests' answer gives the tests shown, their commit and whether coverage was available", () => {
    it('before anything is sent, it says nothing has arrived yet', async () => {
      expect(await theTests()).toEqual({ commit: null, coverageAvailable: null, tree: [], note: "No snapshot of main's tests has arrived yet." });
    });

    it('tests sent without coverage are answered as coverage not available, with their areas', async () => {
      await sendEveryTestsPart(A, AREAS, { coverageAvailable: false });
      await showTests(A);

      const answer = await theTests();

      expect(answer).toMatchObject({ commit: A, coverageAvailable: false });
      expect((answer.tree as { key: string; children: unknown[] }[]).map((n) => [n.key, n.children.length])).toEqual([['Area 1', 36]]);
    });

    it('asked with an Accept header naming JSON, it answers the same', async () => {
      await shown(A);

      const response = await SELF.fetch('https://monitor.test/tests', { headers: { accept: 'application/json' } });

      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toMatchObject({ commit: A });
    });
  });
});
