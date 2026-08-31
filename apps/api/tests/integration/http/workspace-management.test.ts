import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import type { Workspace } from '@cockpit/shared';
import { createDb } from '../../../src/db/client.js';
import { commands, workspaces } from '../../../src/db/schema.js';
import { WORKSPACE_ID, seedWorkspaces } from '../seed.js';

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

    it.each([
      { situation: 'a name another workspace already has', typed: (n: string) => n, refusal: 409 },
      { situation: 'the same name in another case', typed: (n: string) => n.toUpperCase(), refusal: 409 },
      { situation: 'a name that only collides once trimmed', typed: (n: string) => `  ${n} `, refusal: 409 },
      { situation: 'no name at all', typed: () => '', refusal: 400 },
      { situation: 'a name of nothing but blanks', typed: () => '   ', refusal: 400 },
      { situation: 'a name too long to read in a tab', typed: () => 'W'.repeat(61), refusal: 400 },
    ])('refuses $situation, and stores nothing', async ({ typed, refusal }) => {
      const taken = aName();
      await makeWorkspace(taken);
      const before = await storedNames();

      const response = await makeWorkspace(typed(taken));

      expect(response.status).toBe(refusal);
      expect(await storedNames()).toEqual(before);
    });

    it('says which workspace already has the name, as that workspace spells it', async () => {
      // Not as it was typed. "a workspace called work already exists", next to
      // a tab that plainly says Work, reads as a different workspace entirely.
      const taken = aName();
      await makeWorkspace(taken);

      const response = await makeWorkspace(taken.toLowerCase());

      expect(await response.json()).toEqual({ error: `a workspace called ${taken} already exists` });
    });

    it('gives the name back to a workspace that is not there any more', async () => {
      // Deleting is "Rename and delete a workspace" (issue 77), but the index
      // that holds only *live* workspaces apart, and the reads that skip a
      // tombstoned one, both ship here - so they are proved here rather than
      // going out untested. Tombstoned directly because nothing can yet ask
      // for it: there is no delete to enter through.
      const name = aName();
      const workspaceId = nextId();
      await makeWorkspace(name, { workspaceId });
      await createDb(env.DB)
        .update(workspaces)
        .set({ deletedAt: '2026-08-12T09:00:00.000Z' })
        .where(eq(workspaces.id, workspaceId));

      expect((await theWorkspaces()).map((w) => w.id)).not.toContain(workspaceId);
      expect((await makeWorkspace(name)).status).toBe(200);
    });
  });

  describe('no two workspaces share a name, whatever alphabet it is in', () => {
    // Every case makes both workspaces itself, because what it asks is whether
    // the second is refused *given* the first. The suffix is what keeps one
    // case's names out of the next one's way.
    //
    // Reusing the name of a workspace that is not there any more stays allowed,
    // and is proved by "gives the name back to a workspace that is not there
    // any more" above rather than repeated here - it needs a tombstone, which
    // is not something a pair of names can express.
    it.each([
      {
        situation: 'the same accented name in another case',
        first: (u: string) => `ÉTÉ ${u}`,
        then: (u: string) => `été ${u}`,
        answer: 409,
      },
      {
        situation: 'the same plain name in another case',
        first: (u: string) => `Personal ${u}`,
        then: (u: string) => `personal ${u}`,
        answer: 409,
      },
      {
        situation: 'a name whose sharp s is written out in the other case',
        first: (u: string) => `STRASSE ${u}`,
        then: (u: string) => `Straße ${u}`,
        answer: 409,
      },
      {
        situation: 'a name that differs by an accent rather than by case',
        first: (u: string) => `Reunions ${u}`,
        then: (u: string) => `Réunions ${u}`,
        answer: 200,
      },
    ])('$situation', async ({ first, then, answer }) => {
      seq += 1;
      const suffix = String(seq);
      expect((await makeWorkspace(first(suffix))).status).toBe(200);

      expect((await makeWorkspace(then(suffix))).status).toBe(answer);
    });
  });

  describe('a workspace name is a single line', () => {
    it.each([
      { situation: 'a name broken over two lines', typed: (n: string) => `${n}\nand more`, answer: 400 },
      { situation: 'a name with a tab in it', typed: (n: string) => `${n}\tand more`, answer: 400 },
      { situation: 'a name of ordinary text', typed: (n: string) => n, answer: 200 },
    ])('$situation', async ({ typed, answer }) => {
      const name = aName();

      const response = await makeWorkspace(typed(name));

      expect(response.status).toBe(answer);
      // Refused, not cleaned up: repairing input is where the bypasses live.
      if (answer === 400) expect(await storedNames()).not.toContain(name);
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
