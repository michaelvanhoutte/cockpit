import { beforeEach, describe, expect, inject, it } from 'vitest';
import { applyD1Migrations, env } from 'cloudflare:test';
import { TASK_TYPE_ID, WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker (`asUser`), the same reasoning
 * `decision-history.test.ts` beside this file gives: whether editing a text
 * appends or updates a `text_corrections` row is a fact about the store, not
 * about a pure function - `textCorrectionFor` (apps/api/src/domain/text-
 * corrections.ts) is unit-tested for its own branching (the empty-title
 * guard), and this file is about what `command-service.ts` does with it
 * ("Learn how you write from the titles you correct", issue 394).
 *
 * What a proposal reads *back* from this table is the AI layer's own
 * concern, proved in note-cleanup.test.ts against the system prompt it
 * produces - this file is only about what gets written and when.
 */

let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

const AT = '2026-09-09T10:00:00.000Z';
const LATER = '2026-09-09T10:00:01.000Z';

async function send(command: string, body: Record<string, unknown>, issuedAt: string = AT) {
  return asUser(`http://cockpit.test/v1/commands/${command}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: nextId(), issuedAt, ...body }),
  });
}

/** An item captured with a note, so it has a `capturedMessage` to carry onto a correction row. */
async function anItem(message: string): Promise<string> {
  const itemId = nextId();
  expect(
    (await send('capture_item', { workspaceId: WORKSPACE_ID, itemId, message, typeId: TASK_TYPE_ID })).status,
  ).toBe(200);
  return itemId;
}

/**
 * Puts a live proposal on an Item directly, by row - `propose_item_texts` is
 * Cockpit's own to send (`note-cleanup.test.ts`, "the reading is Cockpit's to
 * do, and cannot be asked for from outside"), so there is no address a test
 * can post it to either, the same reasoning `propose` in `decision-
 * history.test.ts` gives for `propose_item_panel`.
 */
async function propose(itemId: string, title: string, description: string | null): Promise<void> {
  await inTheStore((sql) =>
    sql.exec(
      'UPDATE items SET title = ?, description = ?, texts_proposed_at = ? WHERE id = ?',
      title,
      description,
      AT,
      itemId,
    ),
  );
}

function setTitle(itemId: string, title: string, issuedAt: string = LATER) {
  return send('set_title', { workspaceId: WORKSPACE_ID, itemId, title }, issuedAt);
}

function setDescription(itemId: string, description: string | null, issuedAt: string = LATER) {
  return send('set_description', { workspaceId: WORKSPACE_ID, itemId, description }, issuedAt);
}

async function correctionsFor(itemId: string) {
  return inTheStore((sql) =>
    sql
      .exec<{
        item_id: string;
        captured_message: string;
        proposed_title: string;
        proposed_description: string | null;
        settled_title: string;
        settled_description: string | null;
        recorded_at: string;
        updated_at: string;
      }>(
        'SELECT item_id, captured_message, proposed_title, proposed_description, settled_title, settled_description, recorded_at, updated_at FROM text_corrections WHERE item_id = ?',
        itemId,
      )
      .toArray(),
  );
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
  seq = 0;
});

describe('Triage', () => {
  describe('changing a text Cockpit proposed is recorded with what it proposed', () => {
    it('records one row, holding both sides, when the title of a proposed Item is changed', async () => {
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, 'Reply to Bart with the numbers', 'The message Cockpit wrote.');

      expect((await setTitle(itemId, 'Mail Bart the numbers')).status).toBe(200);

      const rows = await correctionsFor(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        captured_message: 'Reply to Bart',
        proposed_title: 'Reply to Bart with the numbers',
        proposed_description: 'The message Cockpit wrote.',
        settled_title: 'Mail Bart the numbers',
        settled_description: 'The message Cockpit wrote.',
      });
    });

    it('records one row, holding both sides, when only the description is changed', async () => {
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, 'Reply to Bart with the numbers', 'The message Cockpit wrote.');

      expect((await setDescription(itemId, 'The message I actually want.')).status).toBe(200);

      const rows = await correctionsFor(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        proposed_title: 'Reply to Bart with the numbers',
        proposed_description: 'The message Cockpit wrote.',
        settled_title: 'Reply to Bart with the numbers',
        settled_description: 'The message I actually want.',
      });
    });

    it('updates the same row’s settled half, when the title is changed and then the description', async () => {
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, 'Reply to Bart with the numbers', 'The message Cockpit wrote.');
      await setTitle(itemId, 'Mail Bart the numbers', LATER);

      expect((await setDescription(itemId, 'The message I actually want.', '2026-09-09T10:00:02.000Z')).status).toBe(
        200,
      );

      const rows = await correctionsFor(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        proposed_title: 'Reply to Bart with the numbers',
        proposed_description: 'The message Cockpit wrote.',
        settled_title: 'Mail Bart the numbers',
        settled_description: 'The message I actually want.',
      });
    });

    it('updates the same row rather than appending a second, when an already-settled text is changed again', async () => {
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, 'Reply to Bart with the numbers', 'The message Cockpit wrote.');
      await setTitle(itemId, 'Mail Bart the numbers', LATER);

      expect((await setTitle(itemId, 'Mail Bart the final numbers', '2026-09-09T10:00:02.000Z')).status).toBe(200);

      const rows = await correctionsFor(itemId);
      expect(rows).toHaveLength(1);
      // The proposal stays frozen at the first edit; only the settled half moves.
      expect(rows[0]).toMatchObject({
        proposed_title: 'Reply to Bart with the numbers',
        settled_title: 'Mail Bart the final numbers',
      });
    });

    it('records no row, when a title is changed on an Item Cockpit never proposed for', async () => {
      const itemId = await anItem('Reply to Bart');

      expect((await setTitle(itemId, 'Mail Bart the numbers')).status).toBe(200);

      expect(await correctionsFor(itemId)).toHaveLength(0);
    });

    it('records no row, when a title is cleared to nothing', async () => {
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, 'Reply to Bart with the numbers', 'The message Cockpit wrote.');

      expect((await setTitle(itemId, '')).status).toBe(200);

      expect(await correctionsFor(itemId)).toHaveLength(0);
    });

    it('writes one row, not two, when the same edit command is replayed', async () => {
      const itemId = await anItem('Reply to Bart');
      await propose(itemId, 'Reply to Bart with the numbers', 'The message Cockpit wrote.');
      const body = {
        commandId: nextId(),
        issuedAt: LATER,
        workspaceId: WORKSPACE_ID,
        itemId,
        title: 'Mail Bart the numbers',
      };
      const once = () =>
        asUser('http://cockpit.test/v1/commands/set_title', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      await once();
      await once();

      expect(await correctionsFor(itemId)).toHaveLength(1);
    });
  });
});
