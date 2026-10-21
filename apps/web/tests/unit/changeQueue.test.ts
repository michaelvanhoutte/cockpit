import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, Item, WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { createChangeQueue } from '../../src/changeQueue';

/**
 * F1: the changes a tab has made and not yet had answered - which of them are
 * still drawn, in what order they reach the server, and when the browser is
 * told to hold the page. The server is a fake that answers when the test says,
 * so a slow one is a promise left open.
 */

const AT = '2026-10-20T09:00:00.000Z';
const BART = '11111111-1111-7111-8111-000000000001';

const priority = (value: 'high' | 'low' | null, workspaceId = 'ws-work'): CommandArgs => ({
  name: 'set_priority',
  payload: { commandId: `c-${String(value)}`, issuedAt: AT, workspaceId, itemId: BART, priority: value },
});

const done = (isDone: boolean): CommandArgs => ({
  name: 'set_done',
  payload: { commandId: `c-done-${String(isDone)}`, issuedAt: AT, workspaceId: 'ws-work', itemId: BART, done: isDone },
});

const aPanelRenamed = (): CommandArgs =>
  ({ name: 'rename_panel', payload: { commandId: 'c-rename', issuedAt: AT, workspaceId: 'ws-work', panelId: 'p-1', name: 'Today' } }) as unknown as CommandArgs;

/** The Workspace as the server sent it: the Item with no priority. */
const sent = (over: Partial<Item> = {}): WorkspaceSnapshot =>
  ({
    items: [{ id: BART, title: 'Reply to Bart', priority: null, completedAt: null, startedAt: null, ...over }],
    filings: [],
    panels: [],
  }) as unknown as WorkspaceSnapshot;

const priorityShown = (copy: WorkspaceSnapshot) => copy.items[0]!.priority;

/** A server that holds every request until the test answers it, in the order they arrive. */
function aServer() {
  const arrived: {
    change: CommandArgs;
    signal: AbortSignal;
    answer: (result?: CommandResult) => void;
    refuse: (error: Error) => void;
  }[] = [];
  const send = vi.fn(
    (change: CommandArgs, signal: AbortSignal) =>
      new Promise<CommandResult>((resolve, reject) => {
        arrived.push({
          change,
          signal,
          answer: (result = { ok: true, applied: true }) => resolve(result),
          refuse: reject,
        });
      }),
  );
  return { send, arrived };
}

/** Lets what the queue does between an answer and the next request happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Item editing', () => {
  describe('a change waiting for its answer never flips back while a read lands', () => {
    it('keeps drawing the change under a read that began before the answer', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(priority('high'));
      await settle();
      const read = queue.readStarted();
      server.arrived[0]!.answer();
      await settle();

      queue.readLanded('ws-work', read);

      expect(priorityShown(queue.drawnOver(sent()))).toBe('high');
    });

    it('stops drawing the change once a read that began after the answer has landed, and the server’s value wins', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(priority('high'));
      await settle();
      server.arrived[0]!.answer();
      await settle();
      const read = queue.readStarted();

      // Another device wrote something else after this one's answer, and the read shows it.
      queue.readLanded('ws-work', read);

      expect(priorityShown(queue.drawnOver(sent({ priority: 'low' })))).toBe('low');
    });

    it('stops drawing the change when a read that began before the answer holds its stamp', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(priority('high'));
      await settle();
      const read = queue.readStarted();
      server.arrived[0]!.answer({ ok: true, applied: true, at: '2026-10-21T10:00:02.000Z' });
      await settle();

      // Another device wrote after this one, and the read, begun first, already shows both.
      queue.readLanded('ws-work', read, '2026-10-21T10:00:03.000Z');

      expect(priorityShown(queue.drawnOver(sent({ priority: 'low' })))).toBe('low');
    });

    it('keeps drawing the change when a read that began before the answer is older than its stamp', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(priority('high'));
      await settle();
      const read = queue.readStarted();
      server.arrived[0]!.answer({ ok: true, applied: true, at: '2026-10-21T10:00:02.000Z' });
      await settle();

      queue.readLanded('ws-work', read, '2026-10-21T10:00:01.000Z');

      expect(priorityShown(queue.drawnOver(sent()))).toBe('high');
    });

    it('draws the later of two changes to the same field while both wait', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(priority('high'));
      void queue.enqueue(priority('low'));

      expect(priorityShown(queue.drawnOver(sent()))).toBe('low');
    });

    it('lets a read of another Workspace leave a change alone', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(priority('high'));
      await settle();
      server.arrived[0]!.answer();
      await settle();
      const read = queue.readStarted();

      queue.readLanded('ws-personal', read);

      expect(priorityShown(queue.drawnOver(sent()))).toBe('high');
    });

    it('stops drawing a change that did not reach the server, and hands the failure to whoever made it', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      const made = queue.enqueue(priority('high'));
      made.catch(() => {});
      await settle();
      expect(priorityShown(queue.drawnOver(sent()))).toBe('high');

      server.arrived[0]!.refuse(new TypeError('Failed to fetch'));
      await settle();

      expect(priorityShown(queue.drawnOver(sent()))).toBeNull();
      await expect(made).rejects.toThrow('Failed to fetch');
    });

    it('draws the earlier change again when the later one is refused', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(priority('high'));
      const later = queue.enqueue(priority('low'));
      later.catch(() => {});
      await settle();
      server.arrived[0]!.answer();
      await settle();

      server.arrived[1]!.refuse(new Error('That item is locked.'));
      await settle();

      expect(priorityShown(queue.drawnOver(sent()))).toBe('high');
    });
  });

  describe('changes reach the server one at a time, in the order they were made', () => {
    it('sends the second only once the first is answered', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });

      void queue.enqueue(priority('high'));
      void queue.enqueue(priority('low'));
      await settle();
      expect(server.arrived.map((request) => request.change)).toEqual([priority('high')]);

      server.arrived[0]!.answer();
      await settle();

      expect(server.arrived.map((request) => request.change)).toEqual([priority('high'), priority('low')]);
    });

    it('sends a change that is not drawn ahead after the field change made before it', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });

      void queue.enqueue(priority('high'));
      void queue.enqueue(aPanelRenamed());
      await settle();
      expect(server.send).toHaveBeenCalledTimes(1);

      server.arrived[0]!.answer();
      await settle();

      expect(server.arrived.map((request) => request.change.name)).toEqual(['set_priority', 'rename_panel']);
    });

    it('sends an Undo pressed before the change it reverses is answered after it, and the screen shows it reversed', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });

      void queue.enqueue(done(true));
      void queue.enqueue(done(false));
      await settle();
      expect(server.arrived.map((request) => request.change)).toEqual([done(true)]);
      expect(queue.drawnOver(sent()).items[0]!.completedAt).toBeNull();

      server.arrived[0]!.answer();
      await settle();

      expect(server.arrived.map((request) => request.change)).toEqual([done(true), done(false)]);
    });

    it('still sends the changes after one that is refused', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      const first = queue.enqueue(priority('high'));
      first.catch(() => {});
      void queue.enqueue(priority('low'));
      await settle();

      server.arrived[0]!.refuse(new Error('That item is locked.'));
      await settle();

      expect(server.arrived.map((request) => request.change)).toEqual([priority('high'), priority('low')]);
      await expect(first).rejects.toThrow('That item is locked.');
    });

    it('gives up on a request that never answers, sends it back as not reached, and goes on to the next', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send, sendTimeoutMs: 20 });
      const hung = queue.enqueue(priority('high'));
      hung.catch(() => {});
      // It hangs too, in its turn; nobody is waiting on that here.
      queue.enqueue(priority('low')).catch(() => {});
      await settle();
      expect(server.arrived.map((request) => request.change)).toEqual([priority('high')]);

      await new Promise((resolve) => setTimeout(resolve, 60));

      await expect(hung).rejects.toThrow('That did not reach the server. Try again.');
      expect(server.arrived.map((request) => request.change)).toEqual([priority('high'), priority('low')]);
      expect(server.arrived[0]!.signal.aborted).toBe(true);
    });
  });

  describe('leaving the tab asks first while a change is unanswered', () => {
    function aTabThatCanBeLeft() {
      const guard = { arm: vi.fn(), disarm: vi.fn() };
      const server = aServer();
      return { guard, server, queue: createChangeQueue({ send: server.send, leaveGuard: guard }) };
    }

    it('arms the leave-site prompt while one change is unanswered, and not before or after', async () => {
      const { guard, server, queue } = aTabThatCanBeLeft();
      expect(guard.arm).not.toHaveBeenCalled();

      void queue.enqueue(priority('high'));
      await settle();
      expect(guard.arm).toHaveBeenCalledTimes(1);
      expect(guard.disarm).not.toHaveBeenCalled();

      server.arrived[0]!.answer();
      await settle();

      expect(guard.disarm).toHaveBeenCalledTimes(1);
    });

    it('stays armed until the last of several is answered, and is armed once', async () => {
      const { guard, server, queue } = aTabThatCanBeLeft();
      void queue.enqueue(priority('high'));
      void queue.enqueue(priority('low'));
      await settle();

      server.arrived[0]!.answer();
      await settle();
      expect(guard.disarm).not.toHaveBeenCalled();
      server.arrived[1]!.answer();
      await settle();

      expect(guard.arm).toHaveBeenCalledTimes(1);
      expect(guard.disarm).toHaveBeenCalledTimes(1);
    });

    it('lets go when the last change is refused', async () => {
      const { guard, server, queue } = aTabThatCanBeLeft();
      const only = queue.enqueue(priority('high'));
      only.catch(() => {});
      await settle();

      server.arrived[0]!.refuse(new Error('That item is locked.'));
      await settle();

      expect(guard.disarm).toHaveBeenCalledTimes(1);
    });

    it('counts a change answered but not yet read back as saved', async () => {
      const { server, queue } = aTabThatCanBeLeft();
      void queue.enqueue(priority('high'));
      await settle();
      server.arrived[0]!.answer();
      await settle();

      expect(queue.unanswered()).toBe(0);
    });
  });
});

describe('Panels', () => {
  describe('a filing waiting for its answer never flips back while a read lands', () => {
    it('keeps drawing a filing under a read that began before its answer, and stops once a later read has landed', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      const filedOn = (copy: WorkspaceSnapshot) => copy.filings.map((filing) => filing.panelId);
      const copy = { ...sent(), workspace: { id: 'ws-work' } } as unknown as WorkspaceSnapshot;
      void queue.enqueue({
        name: 'add_item_to_panel',
        payload: { commandId: 'c-add', issuedAt: AT, workspaceId: 'ws-work', itemId: BART, panelId: 'p-falcon', order: [BART] },
      });
      await settle();
      const early = queue.readStarted();
      server.arrived[0]!.answer();
      await settle();
      const late = queue.readStarted();

      queue.readLanded('ws-work', early);
      expect(filedOn(queue.drawnOver(copy))).toEqual(['p-falcon']);

      queue.readLanded('ws-work', late);
      expect(filedOn(queue.drawnOver(copy))).toEqual([]);
    });
  });
});
