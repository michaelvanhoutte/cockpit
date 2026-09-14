import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import {
  ACCOUNT_NAME,
  OTHER_USER_ID,
  asUser,
  inStoreAsItIs,
  seedRegister,
  signInAs,
  startFromEmpty,
} from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), the same reasoning
 * `text-learning-rules.test.ts` beside this file gives: whether a pinned
 * example lands, changes, or goes for good is a fact about the store, not
 * about a pure function ("Pin an example of how you want a note written",
 * issue 397).
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-14T10:00:00.000Z';
const LATER = '2026-09-14T10:00:01.000Z';

async function pin(
  fields: { exampleId?: string; note?: string; title?: string; description?: string },
  userId?: string,
  issuedAt: string = AT,
) {
  return asUser(
    'http://cockpit.test/v1/commands/pin_text_example',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commandId: nextId(),
        issuedAt,
        workspaceId: ACCOUNT_WIDE,
        exampleId: fields.exampleId ?? nextId(),
        note: fields.note ?? 'bel novy ivm afspraak',
        title: fields.title ?? 'Novy bellen over de afspraak',
        description: fields.description ?? '',
      }),
    },
    userId,
  );
}

function editExample(
  exampleId: string,
  fields: { note: string; title: string; description?: string },
  issuedAt: string = LATER,
) {
  return asUser('http://cockpit.test/v1/commands/edit_pinned_example', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      commandId: nextId(),
      issuedAt,
      workspaceId: ACCOUNT_WIDE,
      exampleId,
      note: fields.note,
      title: fields.title,
      description: fields.description ?? '',
    }),
  });
}

function deleteExample(exampleId: string, issuedAt: string = LATER) {
  return asUser('http://cockpit.test/v1/commands/delete_pinned_example', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt, workspaceId: ACCOUNT_WIDE, exampleId }),
  });
}

type PinnedExampleWire = { id: string; note: string; title: string; description: string | null };

async function pinnedExamplesFor(userId?: string): Promise<PinnedExampleWire[]> {
  const response = await asUser('http://cockpit.test/v1/text-learning-rules', {}, userId);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { pinnedExamples: PinnedExampleWire[] };
  return body.pinnedExamples;
}

/** Reads the row straight from the store, for the cases about what actually ended up in it. */
async function rowFor(exampleId: string) {
  const rows = await inStoreAsItIs(ACCOUNT_NAME, (sql) =>
    sql
      .exec<{ note: string; title: string; description: string | null }>(
        'SELECT note, title, description FROM pinned_text_examples WHERE tenant_id = ? AND id = ?',
        ACCOUNT_NAME,
        exampleId,
      )
      .toArray(),
  );
  return rows[0] ?? null;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  await signInAs();
  await signInAs(OTHER_USER_ID);
  seq = 0;
});

describe('What Cockpit is told', () => {
  describe('pinning an example', () => {
    it('adds it to the account’s pinned examples', async () => {
      const exampleId = nextId();

      expect((await pin({ exampleId, note: 'bel novy', title: 'Novy bellen' })).status).toBe(200);

      const examples = await pinnedExamplesFor();
      expect(examples).toHaveLength(1);
      expect(examples[0]).toMatchObject({ id: exampleId, note: 'bel novy', title: 'Novy bellen' });
    });

    it('stores an empty message as absent, the same as a cleared Item description', async () => {
      const exampleId = nextId();

      await pin({ exampleId, description: '' });

      expect((await rowFor(exampleId))?.description).toBeNull();
    });

    it('is refused when the note is blank', async () => {
      const response = await pin({ note: '   ' });
      expect(response.status).not.toBe(200);
      expect(await pinnedExamplesFor()).toHaveLength(0);
    });

    it('is refused when the title is blank', async () => {
      const response = await pin({ title: '' });
      expect(response.status).not.toBe(200);
      expect(await pinnedExamplesFor()).toHaveLength(0);
    });

    it('adds it once, not twice, when the same command is replayed', async () => {
      const body = {
        commandId: nextId(),
        issuedAt: AT,
        workspaceId: ACCOUNT_WIDE,
        exampleId: nextId(),
        note: 'bel novy',
        title: 'Novy bellen',
        description: '',
      };
      const once = () =>
        asUser('http://cockpit.test/v1/commands/pin_text_example', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const first = await once();
      const second = await once();

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(((await second.json()) as { applied: boolean }).applied).toBe(false);
      expect(await pinnedExamplesFor()).toHaveLength(1);
    });

    it('never reaches another account’s pinned examples', async () => {
      expect((await pin({ note: 'their own note' }, OTHER_USER_ID)).status).toBe(200);

      expect(await pinnedExamplesFor()).toHaveLength(0);
      expect(await pinnedExamplesFor(OTHER_USER_ID)).toHaveLength(1);
    });
  });

  describe('editing a pinned example', () => {
    it('replaces the note, title and message on the same row', async () => {
      const exampleId = nextId();
      await pin({ exampleId, note: 'bel novy', title: 'Novy bellen', description: 'Voor de afspraak.' });

      expect(
        (await editExample(exampleId, { note: 'mail novy', title: 'Novy mailen', description: 'Over de afspraak.' }))
          .status,
      ).toBe(200);

      const examples = await pinnedExamplesFor();
      expect(examples).toHaveLength(1);
      expect(examples[0]).toMatchObject({
        id: exampleId,
        note: 'mail novy',
        title: 'Novy mailen',
        description: 'Over de afspraak.',
      });
    });

    it('is refused when the example no longer exists', async () => {
      const response = await editExample(nextId(), { note: 'anything', title: 'Anything' });
      expect(response.status).not.toBe(200);
    });

    it('never reaches another account’s pinned example', async () => {
      const exampleId = nextId();
      await pin({ exampleId, note: 'their own note', title: 'Their own title' }, OTHER_USER_ID);

      const response = await editExample(exampleId, { note: 'stolen', title: 'Stolen' });

      expect(response.status).not.toBe(200);
      expect((await pinnedExamplesFor(OTHER_USER_ID))[0]).toMatchObject({ note: 'their own note' });
    });
  });

  describe('deleting a pinned example', () => {
    it('removes it for good', async () => {
      const exampleId = nextId();
      await pin({ exampleId });

      expect((await deleteExample(exampleId)).status).toBe(200);

      expect(await pinnedExamplesFor()).toHaveLength(0);
      // Gone from the row itself, not merely tombstoned - unlike a type or a
      // workspace, nothing else references a pinned example's id
      // (`schema.ts`'s own comment on `pinnedTextExamples`).
      expect(await rowFor(exampleId)).toBeNull();
    });

    it('is refused when the example no longer exists', async () => {
      const response = await deleteExample(nextId());
      expect(response.status).not.toBe(200);
    });

    it('never reaches another account’s pinned example', async () => {
      const exampleId = nextId();
      await pin({ exampleId, note: 'their own note' }, OTHER_USER_ID);

      const response = await deleteExample(exampleId);

      expect(response.status).not.toBe(200);
      expect(await pinnedExamplesFor(OTHER_USER_ID)).toHaveLength(1);
    });
  });
});
