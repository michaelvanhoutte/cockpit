import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations } from 'cloudflare:test';
import { ACCOUNT_WIDE, ITEM_TYPE_COLORS } from '@cockpit/shared';
import type { CommandName, CommandPayload, ItemType } from '@cockpit/shared';
import { WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level, through the real Worker, because every rule here is about
 * what a query returns or what an index refuses - whether a name is taken,
 * whether a deleted type is gone from the list, what order the types come back
 * in. What a fold *is* and which colour is free are pure and have their own
 * unit tests in apps/api/tests/unit/domain/item-types.test.ts.
 */
async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

let seq = 0;
const nextId = () => {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
};

const envelope = () => ({
  commandId: nextId(),
  issuedAt: '2026-09-04T10:00:00.000Z',
  workspaceId: ACCOUNT_WIDE,
});

/** The account's live types, as the page that manages them reads them. */
async function theTypes(): Promise<ItemType[]> {
  const response = await asUser('http://cockpit.test/v1/item-types');
  expect(response.status).toBe(200);
  return ((await response.json()) as { itemTypes: ItemType[] }).itemTypes;
}

const named = async (name: string) => (await theTypes()).find((type) => type.name === name);

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  await seedRegister();
});

describe('Capture', () => {
  describe('the types page lists every type of the account', () => {
    it('answers with the two an account starts with, in the order they were put in', async () => {
      expect((await theTypes()).map((type) => type.name)).toEqual(['Action', 'Thought']);
    });
  });

  describe('changing a type here changes it wherever it is shown', () => {
    it('renames it, and gives its old name back', async () => {
      const thought = (await named('Thought'))!;

      expect(
        (await postChange('rename_item_type', { ...envelope(), typeId: thought.id, name: 'Idea' }))
          .status,
      ).toBe(200);

      expect((await theTypes()).map((type) => type.name)).toEqual(['Action', 'Idea']);
      // The old name is free, which is what makes renaming reversible.
      expect(
        (await postChange('create_item_type', { ...envelope(), typeId: nextId(), name: 'Thought' }))
          .status,
      ).toBe(200);
    });

    it.each([
      { situation: 'a name another type already has', name: 'Action', answers: 409 },
      { situation: 'that name in another capitalisation', name: 'ACTION', answers: 409 },
      { situation: 'its own name back', name: 'Thought', answers: 200 },
      { situation: 'a name nothing has', name: 'Idea', answers: 200 },
    ])('renaming a type to $situation', async ({ name, answers }) => {
      const thought = (await named('Thought'))!;

      const response = await postChange('rename_item_type', {
        ...envelope(),
        typeId: thought.id,
        name,
      });

      expect(response.status).toBe(answers);
    });

    it('recolours it', async () => {
      const thought = (await named('Thought'))!;

      expect(
        (
          await postChange('set_item_type_color', {
            ...envelope(),
            typeId: thought.id,
            color: ITEM_TYPE_COLORS[5]!,
          })
        ).status,
      ).toBe(200);

      expect((await named('Thought'))?.color).toBe(ITEM_TYPE_COLORS[5]);
    });

    it('refuses a colour that is not one of the palette’s', async () => {
      const thought = (await named('Thought'))!;

      const response = await postChange('set_item_type_color', {
        ...envelope(),
        typeId: thought.id,
        color: '#123456',
      } as CommandPayload<'set_item_type_color'>);

      expect(response.status).toBe(400);
      expect((await named('Thought'))?.color).toBe(ITEM_TYPE_COLORS[1]);
    });
  });

  describe('an item whose type was deleted stays where it is, with no type', () => {
    it('takes the type off the list and leaves the item on it', async () => {
      const thought = (await named('Thought'))!;
      const itemId = nextId();
      await postChange('capture_item', {
        commandId: nextId(),
        issuedAt: '2026-09-04T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        message: 'Maybe split the pricing page',
        typeId: thought.id,
      });

      expect(
        (await postChange('delete_item_type', { ...envelope(), typeId: thought.id })).status,
      ).toBe(200);

      expect((await theTypes()).map((t) => t.name)).toEqual(['Action']);
      const snapshot = await asUser(`http://cockpit.test/v1/workspaces/${WORKSPACE_ID}/snapshot`);
      const held = (await snapshot.json()) as { items: { id: string; typeId: string | null }[] };
      // Still there, still pointing at a row nothing lists - which is what a
      // row with no type is drawn from. Nothing was rewritten to achieve it.
      expect(held.items.map((item) => item.id)).toContain(itemId);
    });

    it('gives the deleted type’s name back', async () => {
      const thought = (await named('Thought'))!;
      await postChange('delete_item_type', { ...envelope(), typeId: thought.id });

      expect(
        (await postChange('create_item_type', { ...envelope(), typeId: nextId(), name: 'Thought' }))
          .status,
      ).toBe(200);
      expect((await theTypes()).map((t) => t.name)).toEqual(['Action', 'Thought']);
    });
  });

  describe('the types are in the order you put them in', () => {
    it('answers in the order the last move left them', async () => {
      const [action, thought] = await theTypes();

      expect(
        (
          await postChange('reorder_item_types', {
            ...envelope(),
            typeId: thought!.id,
            typeIds: [thought!.id, action!.id],
          })
        ).status,
      ).toBe(200);

      expect((await theTypes()).map((type) => type.name)).toEqual(['Thought', 'Action']);
    });

    it.each([
      { situation: 'leaves one of them out', keep: 1, answers: 409 },
      { situation: 'names one the account does not have', extra: true, answers: 409 },
    ])('refuses an order that $situation', async ({ keep, extra, answers }) => {
      const types = await theTypes();
      const ids = types.map((type) => type.id);

      const response = await postChange('reorder_item_types', {
        ...envelope(),
        typeId: ids[0]!,
        typeIds: extra ? [...ids, '018f0000-0000-7000-8000-999999999999'] : ids.slice(0, keep),
      });

      expect(response.status).toBe(answers);
      // Refused whole: the order it had is the order it still has.
      expect((await theTypes()).map((type) => type.name)).toEqual(['Action', 'Thought']);
    });
  });

  describe('a change to a type that is not there is refused and nothing is stored', () => {
    const gone = '018f0000-0000-7000-8000-999999999999';

    it.each<{ situation: string; name: CommandName; change: () => CommandPayload<CommandName> }>([
      {
        situation: 'renaming it',
        name: 'rename_item_type',
        change: () => ({ ...envelope(), typeId: gone, name: 'Idea' }),
      },
      {
        situation: 'recolouring it',
        name: 'set_item_type_color',
        change: () => ({ ...envelope(), typeId: gone, color: ITEM_TYPE_COLORS[3]! }),
      },
      {
        situation: 'deleting it',
        name: 'delete_item_type',
        change: () => ({ ...envelope(), typeId: gone, name: undefined }),
      },
      {
        situation: 'putting it in an order',
        name: 'reorder_item_types',
        change: () => ({ ...envelope(), typeId: gone, typeIds: [gone] }),
      },
    ])('$situation', async ({ name, change }) => {
      const body = change();

      const response = await postChange(name, body);

      expect(response.status).toBe(404);
      expect(
        await inTheStore((sql) =>
          sql.exec('SELECT * FROM commands WHERE command_id = ?', body.commandId).toArray(),
        ),
      ).toHaveLength(0);
    });

    it('refuses a change to a type that was deleted a moment ago', async () => {
      const thought = (await named('Thought'))!;
      await postChange('delete_item_type', { ...envelope(), typeId: thought.id });

      const response = await postChange('rename_item_type', {
        ...envelope(),
        typeId: thought.id,
        name: 'Idea',
      });

      expect(response.status).toBe(404);
    });
  });
});
