import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { WORKSPACE_THEMES } from '@cockpit/shared';
import type { Workspace } from '@cockpit/shared';
import { createDb } from '../../../src/db/client.js';
import { commands, items, workspaces } from '../../../src/db/schema.js';
import { TENANT_ID, WORKSPACE_ID, seedWorkspaces } from '../seed.js';

/**
 * Integration level, through the real Worker (`SELF.fetch`), because every rule
 * below is about what a query returns or what an index refuses - none of it
 * holds anywhere but against a real database. What a colour *is* is decided by
 * a pure function with its own unit test; the only thing asked here is whether
 * it was handed the colours already in use.
 *
 * What these cases write survives into the next one, so every case makes its
 * own workspace under a name no other case uses - `aName()`. A case that
 * reused a fixed name would pass alone and fail behind the case before it,
 * which is exactly what happened while this file was being written.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}
function aName(): string {
  seq += 1;
  return `Bookkeeping ${seq}`;
}

async function makeWorkspace(name: string, overrides: { workspaceId?: string } = {}) {
  return SELF.fetch('http://cockpit.test/v1/commands/create_workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: '2026-08-12T10:00:00.000Z',
      workspaceId: overrides.workspaceId ?? nextId(),
      name,
    }),
  });
}

async function renameWorkspace(workspaceId: string, name: string, overrides: { commandId?: string } = {}) {
  return SELF.fetch('http://cockpit.test/v1/commands/rename_workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: overrides.commandId ?? nextId(),
      issuedAt: '2026-08-12T10:00:00.000Z',
      workspaceId,
      name,
    }),
  });
}

async function deleteWorkspace(workspaceId: string, overrides: { commandId?: string } = {}) {
  return SELF.fetch('http://cockpit.test/v1/commands/delete_workspace', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: overrides.commandId ?? nextId(),
      issuedAt: '2026-08-12T11:00:00.000Z',
      workspaceId,
    }),
  });
}

async function setTheme(
  workspaceId: string,
  theme: { tint: string; ground: string; header: string },
  overrides: { commandId?: string } = {},
) {
  return SELF.fetch('http://cockpit.test/v1/commands/set_workspace_theme', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: overrides.commandId ?? nextId(),
      issuedAt: '2026-08-12T12:00:00.000Z',
      workspaceId,
      color: theme.tint,
      ground: theme.ground,
      header: theme.header,
    }),
  });
}

async function captureInto(workspaceId: string, title: string): Promise<string> {
  const itemId = nextId();
  await SELF.fetch('http://cockpit.test/v1/commands/capture_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt: '2026-08-12T10:30:00.000Z',
      workspaceId,
      itemId,
      title,
    }),
  });
  return itemId;
}

/** A workspace that exists, ready to be renamed or deleted. */
async function aWorkspace(): Promise<{ id: string; name: string }> {
  const id = nextId();
  const name = aName();
  await makeWorkspace(name, { workspaceId: id });
  return { id, name };
}

async function theWorkspaces(): Promise<Workspace[]> {
  const res = await SELF.fetch('http://cockpit.test/v1/workspaces');
  const body = (await res.json()) as { workspaces: Workspace[] };
  return body.workspaces;
}

async function storedNames(): Promise<string[]> {
  const rows = await createDb(env.DB).select({ name: workspaces.name }).from(workspaces);
  return rows.map((r) => r.name);
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await seedWorkspaces();
});

describe('Workspace management', () => {
  describe('a new workspace is ready to use the moment it is made', () => {
    it('is one of the workspaces you have', async () => {
      const name = aName();

      const response = await makeWorkspace(name);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, applied: true });
      expect((await theWorkspaces()).map((w) => w.name)).toContain(name);
    });

    it('opens, with nothing in it yet', async () => {
      const workspaceId = nextId();
      const name = aName();
      await makeWorkspace(name, { workspaceId });

      const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${workspaceId}/snapshot`);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        workspace: { id: workspaceId, name },
        items: [],
        associations: [],
      });
    });

    it('leaves the workspaces that were already there alone', async () => {
      const before = await theWorkspaces();

      await makeWorkspace(aName());

      const after = await theWorkspaces();
      expect(after.filter((w) => before.some((b) => b.id === w.id))).toEqual(before);
    });

    it('is a different colour from the ones already there', async () => {
      // Which colour is a pure function with its own unit test. What this asks
      // is whether it was given the colours already in use, which is the half
      // that only exists once there is a database to read them from.
      const name = aName();
      await makeWorkspace(name);

      const all = await theWorkspaces();
      const seeded = all.find((w) => w.id === WORKSPACE_ID);
      const made = all.find((w) => w.name === name);
      expect(made?.color).toBeDefined();
      expect(made?.color).not.toBe(seeded?.color);
    });
  });

  describe('a workspace’s name is what you typed with the surrounding blanks removed, and no two workspaces share one', () => {
    it('stores the name without the blanks around it', async () => {
      const name = aName();

      await makeWorkspace(`  ${name}  `);

      expect(await storedNames()).toContain(name);
    });

    /**
     * The two ways a workspace is given a name. They answer to one rule, so
     * they answer to one table: a name refused when a workspace is made is
     * refused when one is renamed, and a row added here is asked of both.
     * Each returns the way to give a name, having arranged whatever it needs.
     */
    const naming = [
      { way: 'making one', prepare: () => Promise.resolve((typed: string) => makeWorkspace(typed)) },
      {
        way: 'renaming one',
        prepare: async () => {
          const subject = await aWorkspace();
          return (typed: string) => renameWorkspace(subject.id, typed);
        },
      },
    ];

    /**
     * One row per rule, not one per character. *Which* names are the same name
     * is decided in apps/api/tests/unit/domain/workspaces.test.ts and which
     * characters break a line in packages/shared/tests/unit/domain/item.test.ts,
     * each over its whole table; repeating either here would prove it twice and
     * would prove it at the slowest level there is. What is asked here is that
     * every rule is *reachable* down both paths, and refuses without storing.
     */
    const refusedNames: { situation: string; typed: (n: string) => string; refusal: number }[] = [
      { situation: 'a name another workspace already has', typed: (n) => n, refusal: 409 },
      { situation: 'the same name in another case', typed: (n) => n.toUpperCase(), refusal: 409 },
      { situation: 'a name that only collides once trimmed', typed: (n) => `  ${n} `, refusal: 409 },
      { situation: 'no name at all', typed: () => '', refusal: 400 },
      { situation: 'a name of nothing but blanks', typed: () => '   ', refusal: 400 },
      { situation: 'a name too long to read in a tab', typed: () => 'W'.repeat(61), refusal: 400 },
      { situation: 'a name broken across two lines', typed: () => 'Book\nkeeping', refusal: 400 },
    ];

    describe.each(naming)('$way', ({ prepare }) => {
      it.each(refusedNames)(
        'refuses $situation, and stores nothing',
        async ({ typed, refusal }) => {
          const taken = aName();
          await makeWorkspace(taken);
          const give = await prepare();
          const before = await storedNames();

          const response = await give(typed(taken));

          expect(response.status).toBe(refusal);
          expect(await storedNames()).toEqual(before);
        },
      );
    });

    it('says which workspace already has the name, as that workspace spells it', async () => {
      // Not as it was typed. "a workspace called work already exists", next to
      // a tab that plainly says Work, reads as a different workspace entirely.
      const taken = aName();
      await makeWorkspace(taken);

      const response = await makeWorkspace(taken.toLowerCase());

      expect(await response.json()).toEqual({ error: `a workspace called ${taken} already exists` });
    });

    it('renamed to the name it already has, changes nothing and is not refused', async () => {
      const subject = await aWorkspace();

      const response = await renameWorkspace(subject.id, subject.name);

      expect(response.status).toBe(200);
      expect((await theWorkspaces()).find((w) => w.id === subject.id)?.name).toBe(subject.name);
    });

    it('renamed to its own name in different capitalization, shows the new capitalization', async () => {
      // The one row the new name folds onto is the workspace itself. A plain
      // "is this name taken?" finds that row and refuses a rename that
      // collides with nothing, which is what this case is here to catch.
      const subject = await aWorkspace();

      const response = await renameWorkspace(subject.id, subject.name.toUpperCase());

      expect(response.status).toBe(200);
      expect((await theWorkspaces()).find((w) => w.id === subject.id)?.name).toBe(
        subject.name.toUpperCase(),
      );
    });

    it('renamed with blanks around it, stores the name without them', async () => {
      const subject = await aWorkspace();
      const wanted = aName();

      await renameWorkspace(subject.id, `  ${wanted}  `);

      expect((await theWorkspaces()).find((w) => w.id === subject.id)?.name).toBe(wanted);
    });

    it('renamed, gives up the name it used to have and holds the one it now has', async () => {
      // The half a rename that wrote only the name would get wrong. The index
      // holds the folded copy, so leaving it behind would keep the workspace
      // blocking a name nobody can see it under, while its real one went free
      // for a second workspace to take. Neither is visible in what the rename
      // returns; both are visible in what happens next.
      const subject = await aWorkspace();
      const wanted = aName();

      expect((await renameWorkspace(subject.id, wanted)).status).toBe(200);

      // The old name is free again...
      expect((await makeWorkspace(subject.name)).status).toBe(200);
      // ...and the new one is not.
      expect((await makeWorkspace(wanted.toUpperCase())).status).toBe(409);
    });

    it('gives the name back to a workspace that is not there any more', async () => {
      const gone = await aWorkspace();
      const subject = await aWorkspace();
      await deleteWorkspace(gone.id);

      expect((await theWorkspaces()).map((w) => w.id)).not.toContain(gone.id);
      expect((await makeWorkspace(gone.name)).status).toBe(200);
      // And to a rename, not only to a create: one rule, both paths.
      const second = await aWorkspace();
      await deleteWorkspace(second.id);
      expect((await renameWorkspace(subject.id, second.name)).status).toBe(200);
    });
  });

  describe('a deleted workspace is gone from everywhere you can reach it, and nothing it held is erased', () => {
    /**
     * One deletion, read five ways. Arranged once for the whole rule because
     * every case asks a different question of the same event, and each of
     * those questions is a different query with a different filter - which is
     * exactly how this breaks: right in one read path, forgotten in another.
     */
    let deleted: { id: string; name: string };
    let itemId: string;
    let untouched: { id: string; name: string };

    beforeEach(async () => {
      deleted = await aWorkspace();
      untouched = await aWorkspace();
      itemId = await captureInto(deleted.id, 'A note that outlives its workspace');
      await captureInto(untouched.id, 'A note in the workspace that stays');
      expect((await deleteWorkspace(deleted.id)).status).toBe(200);
    });

    it('is not one of the workspaces you have', async () => {
      expect((await theWorkspaces()).map((w) => w.id)).not.toContain(deleted.id);
    });

    it('cannot be opened any more', async () => {
      const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${deleted.id}/snapshot`);
      expect(res.status).toBe(404);
    });

    it('keeps the items that were in it', async () => {
      // Read straight from the database, because the whole point is that they
      // are no longer reachable through anything else: the router learns from
      // the history of where things were filed, so erasing them would erase
      // that. Nothing else can ask this question.
      const rows = await createDb(env.DB).select().from(items).where(eq(items.id, itemId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.workspaceId).toBe(deleted.id);
      expect(rows[0]?.deletedAt).toBeNull();
    });

    it('leaves the other workspaces and what is in them alone', async () => {
      expect((await theWorkspaces()).map((w) => w.id)).toContain(untouched.id);
      const res = await SELF.fetch(`http://cockpit.test/v1/workspaces/${untouched.id}/snapshot`);
      expect(res.status).toBe(200);
      const snapshot = (await res.json()) as { items: { title: string }[] };
      expect(snapshot.items.map((i) => i.title)).toEqual(['A note in the workspace that stays']);
    });

    it('lets a new workspace take the name it had', async () => {
      expect((await makeWorkspace(deleted.name)).status).toBe(200);
    });
  });

  describe('a workspace wears the colors chosen for it', () => {
    /** The theme a workspace is wearing, as the workspace list gives it back. */
    async function coloursOf(workspaceId: string) {
      const workspace = (await theWorkspaces()).find((w) => w.id === workspaceId);
      return { color: workspace?.color, ground: workspace?.ground, header: workspace?.header };
    }

    it('comes back in all three of them, not just the one on the dot', async () => {
      const subject = await aWorkspace();
      const chosen = WORKSPACE_THEMES[4]!;

      expect((await setTheme(subject.id, chosen)).status).toBe(200);

      expect(await coloursOf(subject.id)).toEqual({
        color: chosen.tint,
        ground: chosen.ground,
        header: chosen.header,
      });
    });

    it('leaves every other workspace wearing what it was wearing', async () => {
      const subject = await aWorkspace();
      const untouched = await aWorkspace();
      const before = await coloursOf(untouched.id);

      await setTheme(subject.id, WORKSPACE_THEMES[5]!);

      expect(await coloursOf(untouched.id)).toEqual(before);
    });

    it('lets two workspaces wear the same theme, which is the person’s business', async () => {
      // Unlike names, which are refused: two workspaces that look alike are
      // two the person chose to make look alike, and they are still told apart
      // by what the tabs say.
      const one = await aWorkspace();
      const other = await aWorkspace();
      const chosen = WORKSPACE_THEMES[6]!;

      expect((await setTheme(one.id, chosen)).status).toBe(200);
      expect((await setTheme(other.id, chosen)).status).toBe(200);

      expect(await coloursOf(one.id)).toEqual(await coloursOf(other.id));
    });

    it('refuses colors that are not a theme, and keeps the ones it had', async () => {
      // The palette is what keeps every combination legible, and a wire format
      // takes whatever it is given - so the rule has to be enforced here, not
      // only offered by the swatches.
      const subject = await aWorkspace();
      const before = await coloursOf(subject.id);

      const response = await setTheme(subject.id, {
        tint: WORKSPACE_THEMES[1]!.tint,
        ground: WORKSPACE_THEMES[2]!.ground,
        header: WORKSPACE_THEMES[3]!.header,
      });

      expect(response.status).toBe(400);
      expect(await coloursOf(subject.id)).toEqual(before);
    });
  });

  describe('a change to a workspace that no longer exists is refused and nothing is stored', () => {
    it.each([
      { situation: 'renaming it', change: (id: string) => renameWorkspace(id, aName()) },
      { situation: 'deleting it', change: (id: string) => deleteWorkspace(id) },
      { situation: 'coloring it', change: (id: string) => setTheme(id, WORKSPACE_THEMES[3]!) },
    ])('$situation', async ({ change }) => {
      const gone = await aWorkspace();
      await deleteWorkspace(gone.id);
      const before = await storedNames();

      const response = await change(gone.id);

      expect(response.status).toBe(404);
      expect(await storedNames()).toEqual(before);
    });
  });

  describe('the same delete sent twice deletes one workspace', () => {
    it('applies a delete replayed after reconnecting only once', async () => {
      const subject = await aWorkspace();
      const commandId = nextId();
      await deleteWorkspace(subject.id, { commandId });

      const replay = await deleteWorkspace(subject.id, { commandId });

      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, applied: false });
    });

    it('refuses a second delete of a workspace already deleted', async () => {
      // A fresh request id, so nothing recognises it as the same delete: the
      // workspace simply is not there to delete, which is the same 404 any
      // other change to a workspace that is gone gets.
      const subject = await aWorkspace();
      await deleteWorkspace(subject.id);

      expect((await deleteWorkspace(subject.id)).status).toBe(404);
    });
  });

  describe('no two workspaces share a name, whatever alphabet it is in', () => {
    /**
     * Which names count as the same name is a pure decision, and it is decided
     * in apps/api/tests/unit/domain/workspaces.test.ts - the whole case table
     * lives there, including the sharp s and the accent that is a different
     * letter rather than a different case. What is left here is what only a
     * real database answers: that a name refused this way comes back as a 409
     * and stores nothing, and that a row whose stored fold is missing is
     * refused too.
     *
     * Reusing the name of a workspace that is not there any more stays allowed,
     * and is proved by "gives the name back to a workspace that is not there
     * any more" above rather than repeated here - it needs a tombstone, which
     * is not something a pair of names can express.
     */
    it('refuses the second of two names that differ only in case, whatever alphabet', async () => {
      seq += 1;
      const name = `ÉTÉ ${seq}`;
      expect((await makeWorkspace(name)).status).toBe(200);
      const before = await storedNames();

      const response = await makeWorkspace(name.toLowerCase());

      expect(response.status).toBe(409);
      expect(await storedNames()).toEqual(before);
    });

    it('holds its name even when it was stored by a version that did not know the rule', async () => {
      // The row an older Cockpit wrote: a name and no folded copy of it,
      // exactly what the code serving requests during the deploy that
      // introduced the column produces. Written directly because that version
      // is not here to be asked, and there is no other way to arrange it.
      const name = aName();
      await env.DB.prepare(
        'INSERT INTO workspaces (id, tenant_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)',
      )
        .bind(nextId(), TENANT_ID, name, '#b58a2f', '2026-08-12T10:00:00.000Z')
        .run();

      expect((await makeWorkspace(name)).status).toBe(409);
    });
  });

  describe('a workspace name comes back exactly as it was typed', () => {
    // What sits between typing a name and reading it back is the command's
    // JSON, a STRICT table with its CHECKs, and the wire schema on the way out.
    // Any of them could change a character without anything else noticing.
    it.each([
      { situation: 'an ampersand', typed: 'Rock & Roll' },
      { situation: 'something that looks like markup', typed: '<script>' },
      { situation: 'an accent', typed: 'Réunion' },
      { situation: 'an emoji', typed: '📊 Numbers' },
    ])('$situation', async ({ typed }) => {
      seq += 1;
      const name = `${typed} ${seq}`;

      expect((await makeWorkspace(name)).status).toBe(200);

      expect((await theWorkspaces()).map((w) => w.name)).toContain(name);
    });
  });

  describe('the same name sent twice makes one workspace', () => {
    it('refuses the second and keeps the first', async () => {
      // Two separate attempts, not a replay: the second carries its own
      // request id and its own workspace id, so only the name is shared.
      const name = aName();

      expect((await makeWorkspace(name)).status).toBe(200);
      expect((await makeWorkspace(name)).status).toBe(409);

      expect((await storedNames()).filter((n) => n === name)).toHaveLength(1);
    });

    it('records nothing for the one it refused', async () => {
      const name = aName();
      await makeWorkspace(name);
      const refusedRequestId = nextId();

      await SELF.fetch('http://cockpit.test/v1/commands/create_workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          commandId: refusedRequestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: nextId(),
          name,
        }),
      });

      const logged = await createDb(env.DB)
        .select()
        .from(commands)
        .where(eq(commands.commandId, refusedRequestId));
      expect(logged).toHaveLength(0);
    });
  });
});
