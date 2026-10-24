import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
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
} from './support';

beforeEach(emptyTheDatabase);

/** The product's 37 areas, as the tree names them. */
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

    it('an area sent before its tree is refused, and nothing is stored', async () => {
      const response = await sendTestsArea(B, 'Area 1');

      expect(response.status).toBe(409);
      expect(await storedTests()).toEqual({ commits: [], current: null });
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
