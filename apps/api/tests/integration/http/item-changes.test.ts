import { beforeEach, describe, expect, inject, it } from 'vitest';
import { env, applyD1Migrations, SELF } from 'cloudflare:test';
import { WORKSPACE_THEMES } from '@cockpit/shared';
import type { CommandName, CommandPayload } from '@cockpit/shared';
import { WORKSPACE_ID, asUser, inTheStore, seedRegister, startFromEmpty } from '../seed.js';

/**
 * Integration level: real D1, and requests go through the real Worker
 * (`SELF.fetch`, bound to the app's own default export in
 * `apps/api/src/worker.ts`) rather than by calling the write path directly.
 * Routing, request validation and error-to-status mapping are as much a part
 * of the service's own infrastructure as the database is - see "Enter through
 * the real interface, not around it" in the testing skill.
 *
 * Naming: "command" is the architecture's word for the write path and is not
 * in the product's glossary, so it stays inside these helpers and out of
 * anything the runner prints.
 *
 * What a case reads back it reads out of the account's own store, because that
 * is where the data is; `inTheStore` opens the account first, exactly as the
 * request under test does.
 */
async function storedIn(table: string, column: string, value: string) {
  return inTheStore((sql) =>
    sql.exec(`SELECT * FROM ${table} WHERE ${column} = ?`, value).toArray(),
  );
}
async function postChange<N extends CommandName>(name: N, payload: CommandPayload<N>) {
  return asUser(`http://cockpit.test/v1/commands/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Two items can't share an id, so give every case a fresh one. */
let seq = 0;
function nextId(): string {
  seq += 1;
  return `018f0000-0000-7000-8000-${String(seq).padStart(12, '0')}`;
}

async function captureAnItem(overrides: Partial<CommandPayload<'capture_item'>> = {}) {
  const itemId = overrides.itemId ?? nextId();
  await postChange('capture_item', {
    commandId: nextId(),
    issuedAt: '2026-08-12T10:00:00.000Z',
    workspaceId: WORKSPACE_ID,
    itemId,
    message: 'Make appointment with Novy',
    ...overrides,
  });
  return itemId;
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, inject('migrations'));
  await startFromEmpty();
  // The account has to be in the register before any request can resolve it.
  // Its workspaces are not seeded from here: the store creates them itself the
  // first time one of these requests opens it.
  await seedRegister();
});

describe('Offline', () => {
  /**
   * The driver: the app is local-first, so changes made without a connection
   * queue on the client and are replayed once it returns. A replay must not
   * apply twice.
   */
  describe('a change replayed after reconnecting is applied only once', () => {
    it.each<{
      situation: string;
      name: CommandName;
      /** True when the change makes its own subject, so nothing is arranged. */
      makesIt?: true;
      change: (targetId: string, requestId: string) => CommandPayload<CommandName>;
    }>([
      {
        situation: 'making a workspace',
        name: 'create_workspace',
        makesIt: true,
        change: (targetId, requestId) => ({
          commandId: requestId,
          // The new workspace's own id, so a replay carries the same one.
          workspaceId: targetId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          name: `Bookkeeping ${targetId.slice(-4)}`,
        }),
      },
      {
        situation: 'saying what kind of thing something is',
        name: 'create_item_type',
        makesIt: true,
        change: (targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-09-04T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          typeId: targetId,
          name: `Question ${requestId.slice(-4)}`,
        }),
      },
      {
        situation: 'capturing a thought',
        name: 'capture_item',
        makesIt: true,
        change: (targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: targetId,
          message: 'Make appointment with Novy',
        }),
      },
      {
        situation: 'marking it done',
        name: 'set_done',
        change: (targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T11:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: targetId,
          done: true,
        }),
      },
      {
        situation: 'linking it to a person',
        name: 'associate',
        change: (targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T11:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: targetId,
          associationId: nextId(),
          kind: 'person',
          label: 'Anna',
        }),
      },
      {
        situation: 'renaming it',
        name: 'set_title',
        change: (targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T11:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: targetId,
          title: 'Part 11',
        }),
      },
      {
        situation: 'writing a description for it',
        name: 'set_description',
        change: (targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T11:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: targetId,
          description: 'Ask about the tolerances',
        }),
      },
      {
        // The one row that is about the workspace rather than something in it,
        // so `makesIt` is set to say there is nothing to arrange - the seeded
        // workspace is the subject and `targetId` goes unused.
        situation: 'coloring the workspace',
        name: 'set_workspace_theme',
        makesIt: true,
        change: (_targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T11:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          color: WORKSPACE_THEMES[3]!.tint,
          bar: WORKSPACE_THEMES[3]!.bar,
          ground: WORKSPACE_THEMES[3]!.ground,
          header: WORKSPACE_THEMES[3]!.header,
        }),
      },
    ])('$situation', async ({ name, makesIt, change }) => {
      const targetId = makesIt ? nextId() : await captureAnItem();
      const requestId = nextId();
      const body = change(targetId, requestId);

      const first = await postChange(name, body);
      const replay = await postChange(name, body);

      expect(first.status).toBe(200);
      expect((await first.json()) as { applied: boolean }).toMatchObject({ applied: true });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ ok: true, applied: false });

      expect(await storedIn('commands', 'command_id', requestId)).toHaveLength(1);
    });
  });

  describe('a change made against an older version of an item is recorded but changes nothing', () => {
    it('leaves the item as the newer change left it', async () => {
      const itemId = await captureAnItem();
      // Move the item on, so the change below is older than what it reflects.
      await postChange('set_done', {
        commandId: nextId(),
        issuedAt: '2026-08-12T12:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        done: true,
      });

      const outdatedRequestId = nextId();
      const response = await postChange('set_done', {
        commandId: outdatedRequestId,
        issuedAt: '2026-08-12T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        done: false,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, applied: false });
      const [item] = await storedIn('items', 'id', itemId);
      expect(item?.completed_at).toBe('2026-08-12T12:00:00.000Z');
      // Still recorded, so the history stays complete even when nothing moved.
      expect(await storedIn('commands', 'command_id', outdatedRequestId)).toHaveLength(1);
    });
  });
});

describe('Triage', () => {
  describe('a change to an item that no longer exists is refused and nothing is stored', () => {
    // A validly-shaped id that was never captured, so it clears request
    // validation and reaches the missing-item check.
    const goneItemId = '018f0000-0000-7000-8000-999999999999';

    it.each<{
      situation: string;
      name: CommandName;
      change: (requestId: string) => CommandPayload<CommandName>;
    }>([
      {
        situation: 'marking it done',
        name: 'set_done',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          done: true,
        }),
      },
      {
        situation: 'dismissing it',
        name: 'set_dismissed',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          dismissed: true,
        }),
      },
      {
        situation: 'linking it to a person',
        name: 'associate',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          associationId: nextId(),
          kind: 'person',
          label: 'Anna',
        }),
      },
      {
        situation: 'giving it a next action',
        name: 'set_next_action',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          nextAction: 'Call back',
        }),
      },
      {
        situation: 'giving it a priority',
        name: 'set_priority',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          priority: 'high',
        }),
      },
      {
        situation: 'renaming it',
        name: 'set_title',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          title: 'Part 11',
        }),
      },
      {
        situation: 'writing a description for it',
        name: 'set_description',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          description: 'Ask about the tolerances',
        }),
      },
    ])('$situation', async ({ name, change }) => {
      const requestId = nextId();

      const response = await postChange(name, change(requestId));

      expect(response.status).toBe(404);
      expect(await storedIn('commands', 'command_id', requestId)).toHaveLength(0);
    });
  });

  describe('a malformed change is refused and nothing is stored', () => {
    it('is rejected before it reaches the item', async () => {
      const itemId = nextId();

      const response = await asUser('http://cockpit.test/v1/commands/capture_item', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Missing the request id the whole replay story depends on. This is a
        // routing/validation wiring check, not a re-test of the schema itself
        // (already proven in packages/shared/tests/unit/commands.test.ts).
        body: JSON.stringify({
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          message: 'x',
        }),
      });

      expect(response.status).toBe(400);
      expect(await storedIn('items', 'id', itemId)).toHaveLength(0);
    });
  });
});

describe('Capture', () => {
  describe('capturing an item that already exists never creates a second copy', () => {
    it('keeps one item when the client retried without its original request id', async () => {
      const itemId = nextId();
      const capture = (requestId: string) =>
        postChange('capture_item', {
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          message: 'Make appointment with Novy',
        });

      await capture(nextId());
      // A different request id, same item: the client lost track of its own retry.
      await capture(nextId());

      expect(await storedIn('items', 'id', itemId)).toHaveLength(1);
    });
  });
});

describe('Associations', () => {
  describe('an item can be linked to a person and unlinked again', () => {
    it('stores the link, then removes it', async () => {
      const itemId = await captureAnItem();
      const associationId = nextId();

      await postChange('associate', {
        commandId: nextId(),
        issuedAt: '2026-08-12T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        associationId,
        kind: 'person',
        label: 'Anna',
      });
      expect(await storedIn('associations', 'id', associationId)).toHaveLength(1);

      await postChange('associate', {
        commandId: nextId(),
        issuedAt: '2026-08-12T10:01:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        associationId,
        kind: 'person',
        label: 'Anna',
        remove: true,
      });
      expect(await storedIn('associations', 'id', associationId)).toHaveLength(0);
    });
  });
});

describe('Capture', () => {
  /**
   * The workspace on a capture is client-supplied and only shape-validated,
   * so it is the one id that can name something that does not exist. The
   * database refuses it either way; what this pins is that the caller is told
   * what was wrong instead of getting an internal error.
   */
  describe('a thought captured into a workspace that does not exist is refused and nothing is stored', () => {
    it('says which workspace was missing', async () => {
      const response = await postChange('capture_item', {
        commandId: nextId(),
        issuedAt: '2026-08-12T10:00:00.000Z',
        workspaceId: 'ws-that-was-never-created',
        itemId: nextId(),
        message: 'Make appointment with Novy',
      });

      expect(response.status).toBe(404);
      expect((await response.json()) as { error: string }).toMatchObject({
        error: expect.stringContaining('ws-that-was-never-created'),
      });
    });

    it('leaves no trace of the attempt', async () => {
      const itemId = nextId();
      const requestId = nextId();
      await postChange('capture_item', {
        commandId: requestId,
        issuedAt: '2026-08-12T10:00:00.000Z',
        workspaceId: 'ws-that-was-never-created',
        itemId,
        message: 'Make appointment with Novy',
      });

      expect(await storedIn('items', 'id', itemId)).toHaveLength(0);
      expect(await storedIn('commands', 'command_id', requestId)).toHaveLength(0);
    });
  });
});

describe('Triage', () => {
  /**
   * The timestamp constraints reject a day no calendar has, and the times on a
   * change come from the client, so this is reachable from outside - which per
   * the testing strategy is exactly when the caller-visible answer is the thing
   * to pin. It is a 400 from request validation rather than the 500 a raw
   * constraint violation would produce, and this is what keeps it that way.
   */
  describe('a change timed to a day no calendar has is refused and nothing is stored', () => {
    // The item exists in every case, so the impossible date is the only thing
    // left that can refuse the change - otherwise a missing item would refuse
    // it first and these would pass without the timestamps being reached.
    it.each<{
      situation: string;
      name: CommandName;
      change: (requestId: string, itemId: string) => CommandPayload<CommandName>;
    }>([
      {
        situation: 'capturing a thought',
        name: 'capture_item',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-02-31T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: nextId(),
          message: 'Make appointment with Novy',
        }),
      },
      {
        situation: 'marking it done',
        name: 'set_done',
        change: (requestId, itemId) => ({
          commandId: requestId,
          issuedAt: '2026-02-31T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          done: true,
        }),
      },
    ])('$situation', async ({ name, change }) => {
      const itemId = await captureAnItem();
      const requestId = nextId();

      const response = await postChange(name, change(requestId, itemId));

      expect(response.status).toBe(400);
      expect(await storedIn('commands', 'command_id', requestId)).toHaveLength(0);
    });
  });
});

/**
 * Integration: what a text survives is a real column with a real cap, entered
 * the way the form enters it. What the form *sends* - only the fields that
 * changed - is a decision made before anything leaves the browser, and is
 * proved in apps/web/tests/unit/components/ItemForm.test.tsx.
 */
describe('Item editing', () => {
  describe('an item’s title and description are what you last saved', () => {
    const save = async (
      itemId: string,
      what: 'set_title' | 'set_description',
      value: string | null,
      at = '2026-08-12T12:00:00.000Z',
    ) =>
      postChange(what, {
        commandId: nextId(),
        issuedAt: at,
        workspaceId: WORKSPACE_ID,
        itemId,
        ...(what === 'set_title' ? { title: value as string } : { description: value }),
      } as CommandPayload<typeof what>);

    it.each([
      { situation: 'a title saved', what: 'set_title' as const, value: 'Part 11', column: 'title', stored: 'Part 11' },
      { situation: 'a title with blanks around it', what: 'set_title' as const, value: '  Part 11  ', column: 'title', stored: 'Part 11' },
      { situation: 'a title cleared', what: 'set_title' as const, value: '', column: 'title', stored: '' },
      { situation: 'a description saved', what: 'set_description' as const, value: 'Ask about the tolerances', column: 'description', stored: 'Ask about the tolerances' },
      // The one text meant to run to paragraphs, so the line breaks are the point.
      { situation: 'a description over several lines', what: 'set_description' as const, value: 'One\n\nTwo', column: 'description', stored: 'One\n\nTwo' },
      // Emptied is cleared: nothing in the product tells an item whose
      // description was emptied from one that never had a word.
      { situation: 'a description cleared', what: 'set_description' as const, value: '', column: 'description', stored: null },
      { situation: 'a description explicitly removed', what: 'set_description' as const, value: null, column: 'description', stored: null },
    ])('$situation', async ({ what, value, column, stored }) => {
      const itemId = await captureAnItem();

      const response = await save(itemId, what, value);

      expect(response.status).toBe(200);
      const [item] = await storedIn('items', 'id', itemId);
      expect(item?.[column]).toBe(stored);
    });

    it.each([
      { situation: 'a title over the cap', what: 'set_title' as const, value: 'x'.repeat(201) },
      { situation: 'a title broken over two lines', what: 'set_title' as const, value: 'Part\n11' },
      { situation: 'a description over the cap', what: 'set_description' as const, value: 'x'.repeat(60_001) },
    ])('$situation is refused and nothing is stored', async ({ what, value }) => {
      const itemId = await captureAnItem();
      const [before] = await storedIn('items', 'id', itemId);

      const response = await save(itemId, what, value);

      expect(response.status).toBe(400);
      const [after] = await storedIn('items', 'id', itemId);
      expect(after).toEqual(before);
    });
  });

  describe('the captured message is written when the item is made and never changes', () => {
    it('holds what was said, and holds it through everything the form can do', async () => {
      const itemId = await captureAnItem({ message: 'Ask Novy about part 11' });

      const [made] = await storedIn('items', 'id', itemId);
      expect(made?.captured_message).toBe('Ask Novy about part 11');
      // Capture writes no title deliberately: naming a thought is a second act,
      // and the row falls through to the captured message until somebody
      // performs it.
      expect(made?.title).toBe('');
      expect(made?.description).toBe(null);

      await postChange('set_title', {
        commandId: nextId(),
        issuedAt: '2026-08-12T12:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        title: 'Part 11',
      });
      await postChange('set_description', {
        commandId: nextId(),
        issuedAt: '2026-08-12T12:00:01.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        description: 'Tolerances, and the sign-off date',
      });

      const [after] = await storedIn('items', 'id', itemId);
      expect(after?.captured_message).toBe('Ask Novy about part 11');
      expect(after?.title).toBe('Part 11');
      expect(after?.description).toBe('Tolerances, and the sign-off date');
    });
  });
});

describe('Capture', () => {
  /**
   * Reuse and the race are both facts about a real store: whether a name is
   * already taken is a query, and whether two of them can exist at once is what
   * the unique index behind the check decides. The folding itself is proved
   * without one in tests/unit/domain/item-types.test.ts.
   */
  describe('naming a type already there reuses it; naming a new one creates it', () => {
    const makeType = (name: string) => ({
      commandId: nextId(),
      issuedAt: '2026-09-04T10:00:00.000Z',
      workspaceId: WORKSPACE_ID,
      typeId: nextId(),
      name,
    });

    it.each([
      { situation: 'the exact name', named: 'Action' },
      { situation: 'a different capitalisation', named: 'ACTION' },
      { situation: 'the name with blanks round it', named: '  action  ' },
    ])('leaves one type when it is named again with $situation', async ({ named }) => {
      // Every account starts with Action and Thought, so this names one it has.
      expect((await postChange('create_item_type', makeType(named))).status).toBe(200);

      expect(
        await inTheStore((sql) =>
          sql
            .exec("SELECT name FROM item_types WHERE folded_name = 'action'")
            .toArray(),
        ),
      ).toHaveLength(1);
    });

    it('makes a type nothing was going by', async () => {
      const request = makeType('Question');

      expect((await postChange('create_item_type', request)).status).toBe(200);

      expect(await storedIn('item_types', 'id', request.typeId)).toHaveLength(1);
    });

    it('leaves one type when two tabs name the same new one at once', async () => {
      // Two requests, two ids, one name, sent together: only the index behind
      // the check decides this, which is why it is here and not at L1.
      const [first, second] = await Promise.all([
        postChange('create_item_type', makeType('Question')),
        postChange('create_item_type', makeType('Question')),
      ]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(
        await inTheStore((sql) =>
          sql.exec("SELECT id FROM item_types WHERE folded_name = 'question'").toArray(),
        ),
      ).toHaveLength(1);
    });

    it('makes two types when two tabs name different ones at once', async () => {
      const [first, second] = await Promise.all([
        postChange('create_item_type', makeType('Question')),
        postChange('create_item_type', makeType('Decision')),
      ]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(
        await inTheStore((sql) =>
          sql
            .exec("SELECT id FROM item_types WHERE folded_name IN ('question', 'decision')")
            .toArray(),
        ),
      ).toHaveLength(2);
    });
  });

  describe('a capture naming a type this account does not have finds nothing', () => {
    it.each([
      { situation: 'a type of this account', ofThisAccount: true, answers: 200 },
      { situation: 'a type nothing here has', ofThisAccount: false, answers: 404 },
    ])('$situation', async ({ ofThisAccount, answers }) => {
      const [action] = await inTheStore((sql) =>
        sql.exec<{ id: string }>("SELECT id FROM item_types WHERE folded_name = 'action'").toArray(),
      );
      const itemId = nextId();

      const response = await postChange('capture_item', {
        commandId: nextId(),
        issuedAt: '2026-09-04T10:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        message: 'Make appointment with Novy',
        typeId: ofThisAccount ? action!.id : '018f0000-0000-7000-8000-999999999999',
      });

      expect(response.status).toBe(answers);
      expect(await storedIn('items', 'id', itemId)).toHaveLength(answers === 200 ? 1 : 0);
    });
  });
});
