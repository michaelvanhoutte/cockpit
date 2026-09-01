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
    title: 'Make appointment with Novy',
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
        situation: 'capturing a thought',
        name: 'capture_item',
        makesIt: true,
        change: (targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: targetId,
          title: 'Make appointment with Novy',
        }),
      },
      {
        situation: 'marking it done',
        name: 'set_status',
        change: (targetId, requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T11:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: targetId,
          status: 'done',
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
      await postChange('set_status', {
        commandId: nextId(),
        issuedAt: '2026-08-12T12:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        status: 'task',
      });

      const outdatedRequestId = nextId();
      const response = await postChange('set_status', {
        commandId: outdatedRequestId,
        issuedAt: '2026-08-12T11:00:00.000Z',
        workspaceId: WORKSPACE_ID,
        itemId,
        status: 'done',
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, applied: false });
      const [item] = await storedIn('items', 'id', itemId);
      expect(item?.status).toBe('task');
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
        name: 'set_status',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          status: 'done',
        }),
      },
      {
        situation: 'snoozing it until a date',
        name: 'snooze_until',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          until: '2026-09-01T08:00:00.000Z',
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
        situation: 'making it a goal for today',
        name: 'set_focus',
        change: (requestId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId: goneItemId,
          horizon: 'today',
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
          title: 'x',
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
          title: 'Make appointment with Novy',
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
        title: 'Make appointment with Novy',
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
        title: 'Make appointment with Novy',
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
          title: 'Make appointment with Novy',
        }),
      },
      {
        situation: 'snoozing it until a date',
        name: 'snooze_until',
        change: (requestId, itemId) => ({
          commandId: requestId,
          issuedAt: '2026-08-12T10:00:00.000Z',
          workspaceId: WORKSPACE_ID,
          itemId,
          until: '2026-02-31T08:00:00.000Z',
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
