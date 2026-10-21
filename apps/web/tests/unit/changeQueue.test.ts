import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, Item, SourceAccount, SourceAccountList, WorkspaceList, WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { createChangeQueue } from '../../src/changeQueue';
import { connectionsDrawnOver } from '../../src/connectionsDrawnAhead';

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

describe('Dashboards', () => {
  describe('a Dashboard change waiting for its answer never flips back while a read lands', () => {
    const renamed = (name: string): CommandArgs => ({
      name: 'rename_dashboard',
      payload: { commandId: `c-${name}`, issuedAt: AT, workspaceId: 'ws-work', dashboardId: 'd-reading', name },
    });
    /** The Workspace as a read holds it, with the Dashboard going by `name`. */
    const holding = (name: string) =>
      ({
        workspace: { id: 'ws-work' },
        dashboards: [{ id: 'd-reading', tenantId: 'tenant', workspaceId: 'ws-work', name }],
        items: [],
        panels: [],
        filings: [],
        layouts: [],
      }) as unknown as WorkspaceSnapshot;
    const nameShown = (copy: WorkspaceSnapshot) => copy.dashboards[0]!.name;

    it('keeps drawing the change under a read that began before its answer', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(renamed('Library'));
      await settle();
      const early = queue.readStarted();
      server.arrived[0]!.answer();
      await settle();

      queue.readLanded('ws-work', early);

      expect(nameShown(queue.drawnOver(holding('Reading')))).toBe('Library');
    });

    it('shows the server’s copy once a read that began after the answer has landed, another device’s later rename included', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(renamed('Library'));
      await settle();
      server.arrived[0]!.answer();
      await settle();
      const late = queue.readStarted();

      queue.readLanded('ws-work', late);

      expect(nameShown(queue.drawnOver(holding('Reading room')))).toBe('Reading room');
    });
  });
});

describe('Workspace management', () => {
  describe('a Workspace change waiting for its answer never flips back while the list is read', () => {
    const renamed = (name: string): CommandArgs => ({
      name: 'rename_workspace',
      payload: { commandId: `c-${name}`, issuedAt: AT, workspaceId: 'ws-work', name },
    });
    const deleted = (): CommandArgs => ({
      name: 'delete_workspace',
      payload: { commandId: 'c-delete', issuedAt: AT, workspaceId: 'ws-work' },
    });
    /** The list as a read holds it, with the Workspace going by `name`. */
    const holding = (name: string) =>
      ({ workspaces: [{ id: 'ws-work', tenantId: 'tenant', name, color: '#6f62b5', bar: '', ground: '', header: '' }] }) as WorkspaceList;
    const nameShown = (list: WorkspaceList) => list.workspaces[0]?.name;

    it('keeps drawing the change under a read of the list that began before its answer', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(renamed('Client'));
      await settle();
      const early = queue.readStarted();
      server.arrived[0]!.answer();
      await settle();

      queue.readLanded(null, early);

      expect(nameShown(queue.drawnList(holding('Work')))).toBe('Client');
    });

    it('shows the server’s list once a read that began after the answer has landed, another device’s later rename included', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(renamed('Client'));
      await settle();
      server.arrived[0]!.answer();
      await settle();
      const late = queue.readStarted();

      queue.readLanded(null, late);

      expect(nameShown(queue.drawnList(holding('Working')))).toBe('Working');
    });

    it('keeps drawing the change when only the Workspace’s own read lands', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(renamed('Client'));
      await settle();
      server.arrived[0]!.answer();
      await settle();
      const late = queue.readStarted();

      queue.readLanded('ws-work', late);

      expect(nameShown(queue.drawnList(holding('Work')))).toBe('Client');
    });

    it('lets a read of the list leave an Item change alone', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(priority('high'));
      await settle();
      server.arrived[0]!.answer();
      await settle();
      const late = queue.readStarted();

      queue.readLanded(null, late);

      expect(priorityShown(queue.drawnOver(sent()))).toBe('high');
    });

    it('knows a Workspace is being deleted from the click until the list is read after the answer', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      expect(queue.deleting('ws-work')).toBe(false);
      void queue.enqueue(deleted());
      await settle();
      expect(queue.deleting('ws-work')).toBe(true);
      expect(queue.deleting('ws-home')).toBe(false);
      server.arrived[0]!.answer();
      await settle();
      expect(queue.deleting('ws-work')).toBe(true);

      queue.readLanded(null, queue.readStarted());

      expect(queue.deleting('ws-work')).toBe(false);
    });

    describe('a Workspace just added is not on the server yet', () => {
      const added = (workspaceId = 'ws-new'): CommandArgs => ({
        name: 'create_workspace',
        payload: { commandId: `c-add-${workspaceId}`, issuedAt: AT, workspaceId, panelId: 'p-first', name: 'Bookkeeping' },
      });

      it('knows it is being added from the click until the answer, and no longer after', async () => {
        const server = aServer();
        const queue = createChangeQueue({ send: server.send });
        expect(queue.adding('ws-new')).toBe(false);
        void queue.enqueue(added());
        expect(queue.adding('ws-new')).toBe(true);
        expect(queue.adding('ws-other')).toBe(false);
        await settle();
        expect(queue.adding('ws-new')).toBe(true);

        server.arrived[0]!.answer();
        await settle();

        expect(queue.adding('ws-new')).toBe(false);
        // Still drawn, until the list is read after the answer.
        expect(queue.drawnList({ workspaces: [] }).workspaces).toHaveLength(1);
        queue.readLanded(null, queue.readStarted());
        expect(queue.drawnList({ workspaces: [] }).workspaces).toHaveLength(0);
      });

      it('lets what waits on the add go once it is answered, and not before', async () => {
        const server = aServer();
        const queue = createChangeQueue({ send: server.send });
        void queue.enqueue(added());
        const released = vi.fn();
        void queue.afterAdding('ws-new').then(released);
        await settle();
        expect(released).not.toHaveBeenCalled();

        server.arrived[0]!.answer();
        await settle();

        expect(released).toHaveBeenCalledTimes(1);
      });

      it('lets what waits on the add go once it is refused, to meet the refusal of its own', async () => {
        const server = aServer();
        const queue = createChangeQueue({ send: server.send });
        void queue.enqueue(added()).catch(() => {});
        const released = vi.fn();
        void queue.afterAdding('ws-new').then(released);

        await settle();
        server.arrived[0]!.refuse(new Error('refused'));
        await settle();

        expect(released).toHaveBeenCalledTimes(1);
        expect(queue.adding('ws-new')).toBe(false);
      });

      it('has nothing to wait for when no add of that Workspace is out', async () => {
        const queue = createChangeQueue({ send: aServer().send });

        await expect(queue.afterAdding('ws-new')).resolves.toBeUndefined();
      });
    });
    it('stops drawing a refused delete, and the Workspace is there to read again', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(deleted()).catch(() => {});
      await settle();

      server.arrived[0]!.refuse(new Error('refused'));
      await settle();

      expect(queue.deleting('ws-work')).toBe(false);
      expect(nameShown(queue.drawnList(holding('Work')))).toBe('Work');
    });
  });
});

describe('Capture', () => {
  const note = { commandId: 'c-capture', issuedAt: AT, workspaceId: 'ws-work', itemId: BART, message: 'call bart' };
  /** The Workspace as a read holds it, with or without the Item the server made of the note. */
  const holding = (held: boolean): WorkspaceSnapshot =>
    ({
      workspace: { id: 'ws-work', tenantId: 'tenant' },
      items: held ? [{ id: BART, title: 'Call Bart.', completedAt: null }] : [],
      filings: [],
      panels: [],
    }) as unknown as WorkspaceSnapshot;
  const titlesShown = (copy: WorkspaceSnapshot) => copy.items.map((item) => item.title);

  describe('a capture the outbox holds is drawn, and never sent from here', () => {
    it('draws it through every read of the Workspace, and does not hold the page or the reads behind it', () => {
      const server = aServer();
      const leaving = { arm: vi.fn(), disarm: vi.fn() };
      const queue = createChangeQueue({ send: server.send, leaveGuard: leaving });

      queue.captures([note]);
      queue.readLanded('ws-work', queue.readStarted());

      expect(titlesShown(queue.drawnOver(holding(false)))).toEqual(['call bart']);
      expect(server.send).not.toHaveBeenCalled();
      expect(queue.unanswered()).toBe(0);
      expect(leaving.arm).not.toHaveBeenCalled();
    });

    it('stops drawing it once the outbox no longer holds it, as when it is refused or put back', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.captures([note]);

      queue.captures([]);

      expect(titlesShown(queue.drawnOver(holding(false)))).toEqual([]);
    });

    it.each([
      { situation: 'after the capture was drawn', capturedFirst: true },
      { situation: 'before the capture was drawn, as for a note the outbox lets this tab see late', capturedFirst: false },
    ])('draws a change made to its row on top of it, made $situation', async ({ capturedFirst }) => {
      const queue = createChangeQueue({ send: aServer().send });
      if (capturedFirst) queue.captures([note]);
      void queue.enqueue(priority('high'));
      if (!capturedFirst) queue.captures([note]);
      await settle();

      expect(queue.drawnOver(holding(false)).items.map((item) => item.priority)).toEqual(['high']);
    });

    it.each([
      { until: 'it has landed', settles: (queue: ReturnType<typeof createChangeQueue>) => queue.landed(note) },
      { until: 'the outbox has let it go, refused', settles: (queue: ReturnType<typeof createChangeQueue>) => queue.captures([]) },
    ])('sends a change made to its row only once $until, since the server has no Item before', async ({ settles }) => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      queue.captures([note]);
      void queue.enqueue(priority('high'));
      await settle();

      expect(server.send).not.toHaveBeenCalled();
      settles(queue);
      await settle();

      expect(server.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('a landed capture stays drawn until a read that began after it landed has landed', () => {
    it('keeps drawing it under a read that began before it landed, once, whether or not that read holds it', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.captures([note]);
      const early = queue.readStarted();
      queue.landed(note);

      queue.readLanded('ws-work', early);

      expect(titlesShown(queue.drawnOver(holding(false)))).toEqual(['call bart']);
      expect(titlesShown(queue.drawnOver(holding(true)))).toEqual(['Call Bart.']);
    });

    it('shows the server’s row once a read that began after it landed has landed', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.captures([note]);
      queue.landed(note);
      const late = queue.readStarted();

      queue.readLanded('ws-work', late);

      expect(titlesShown(queue.drawnOver(holding(true)))).toEqual(['Call Bart.']);
      // Another device dismissed it first: the read says so, and it is not drawn back.
      expect(titlesShown(queue.drawnOver(holding(false)))).toEqual([]);
    });

    it('stops drawing it when a read that began before it landed holds the stamp its answer gave', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.captures([note]);
      const early = queue.readStarted();
      queue.landed(note, '2026-10-21T10:00:02.000Z');

      queue.readLanded('ws-work', early, '2026-10-21T10:00:03.000Z');

      expect(titlesShown(queue.drawnOver(holding(false)))).toEqual([]);
    });

    it('keeps drawing it when only another Workspace is read', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.captures([note]);
      queue.landed(note);

      queue.readLanded('ws-home', queue.readStarted());
      queue.readLanded(null, queue.readStarted());

      expect(titlesShown(queue.drawnOver(holding(false)))).toEqual(['call bart']);
    });

    it('keeps drawing it after the outbox has let it go, which is when it is removed once it has landed whole', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.captures([note]);
      queue.landed(note);

      queue.captures([]);

      expect(titlesShown(queue.drawnOver(holding(false)))).toEqual(['call bart']);
    });

    it('says a landing is news once, so it is read for once', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.captures([note]);

      expect([queue.landed(note), queue.landed(note)]).toEqual([true, false]);
    });

    it('says a landing is not news for a capture it was never drawing', () => {
      const queue = createChangeQueue({ send: aServer().send });

      expect(queue.landed(note)).toBe(false);
    });

    it('stops drawing every capture when the tab forgets what it was answered, as signing out does', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.captures([note]);
      queue.landed(note);

      queue.forgetAnswered();

      expect(titlesShown(queue.drawnOver(holding(false)))).toEqual([]);
    });
  });
});

describe('Item editing', () => {
  describe('an uploaded file stays drawn until a read that began after its answer has landed', () => {
    const SCAN = '11111111-1111-7111-8111-0000000000a1';
    const upload = { commandId: 'c-upload', issuedAt: AT, workspaceId: 'ws-work', itemId: BART, attachmentId: SCAN, filename: 'scan.pdf', size: 5, contentType: 'application/pdf' } as const;
    /** The Workspace as a read holds it, with or without the file. */
    const holding = (held: boolean): WorkspaceSnapshot =>
      ({
        workspace: { id: 'ws-work', tenantId: 'tenant' },
        items: [{ id: BART }],
        attachments: held ? [{ id: SCAN, itemId: BART, filename: 'scan.pdf' }] : [],
        filings: [],
        panels: [],
      }) as unknown as WorkspaceSnapshot;
    const filesShown = (copy: WorkspaceSnapshot) => copy.attachments.map((file) => file.id);

    it('draws it through a read that began before the answer, once, whether or not that read holds it', () => {
      const queue = createChangeQueue({ send: aServer().send });
      const early = queue.readStarted();
      queue.attached(upload);

      queue.readLanded('ws-work', early);

      expect(filesShown(queue.drawnOver(holding(false)))).toEqual([SCAN]);
      expect(filesShown(queue.drawnOver(holding(true)))).toEqual([SCAN]);
    });

    it('shows the server’s copy once a read that began after the answer has landed', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.attached(upload);
      const late = queue.readStarted();

      queue.readLanded('ws-work', late);

      expect(filesShown(queue.drawnOver(holding(true)))).toEqual([SCAN]);
      // Another device removed it first: the read says so, and it is not drawn back.
      expect(filesShown(queue.drawnOver(holding(false)))).toEqual([]);
    });

    it('stops drawing it when a read that began before the answer holds the stamp the answer gave', () => {
      const queue = createChangeQueue({ send: aServer().send });
      const early = queue.readStarted();
      queue.attached(upload, '2026-10-21T10:00:02.000Z');

      queue.readLanded('ws-work', early, '2026-10-21T10:00:03.000Z');

      expect(filesShown(queue.drawnOver(holding(false)))).toEqual([]);
    });

    it('keeps drawing it when only another Workspace, or the list of Workspaces, is read', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.attached(upload);

      queue.readLanded('ws-home', queue.readStarted());
      queue.readLanded(null, queue.readStarted());

      expect(filesShown(queue.drawnOver(holding(false)))).toEqual([SCAN]);
    });

    it('is never sent from here, and holds neither the page nor the reads and changes behind it', async () => {
      const server = aServer();
      const leaving = { arm: vi.fn(), disarm: vi.fn() };
      const queue = createChangeQueue({ send: server.send, leaveGuard: leaving });

      queue.attached(upload);
      void queue.enqueue(priority('high'));
      await settle();

      expect(server.send).toHaveBeenCalledTimes(1);
      expect(server.arrived[0]!.change.name).toBe('set_priority');
      expect(leaving.arm).toHaveBeenCalledTimes(1);
      server.arrived[0]!.answer();
      await settle();
      expect(queue.unanswered()).toBe(0);
    });

    it('stops drawing it when the tab forgets what it was answered, as signing out does', () => {
      const queue = createChangeQueue({ send: aServer().send });
      queue.attached(upload);

      queue.forgetAnswered();

      expect(filesShown(queue.drawnOver(holding(false)))).toEqual([]);
    });
  });

  describe('a removed attachment stays drawn as gone until a read that began after its answer has landed', () => {
    const SCAN = '11111111-1111-7111-8111-0000000000a1';
    const removal: CommandArgs = { name: 'remove_attachment', payload: { commandId: 'c-remove', issuedAt: AT, workspaceId: 'ws-work', itemId: BART, attachmentId: SCAN } };
    const holding = (): WorkspaceSnapshot =>
      ({
        workspace: { id: 'ws-work', tenantId: 'tenant' },
        items: [{ id: BART }],
        attachments: [{ id: SCAN, itemId: BART, filename: 'scan.pdf' }],
        filings: [],
        panels: [],
      }) as unknown as WorkspaceSnapshot;

    it('is gone at once, stays gone under a read that began before the answer, and the server’s copy wins after one that began later', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      void queue.enqueue(removal);
      await settle();
      expect(queue.drawnOver(holding()).attachments).toEqual([]);
      const early = queue.readStarted();
      server.arrived[0]!.answer();
      await settle();

      queue.readLanded('ws-work', early);
      expect(queue.drawnOver(holding()).attachments).toEqual([]);

      queue.readLanded('ws-work', queue.readStarted());
      // Another device attached it again after this one’s removal, and the read says so.
      expect(queue.drawnOver(holding()).attachments).toHaveLength(1);
    });

    it('is drawn back when the server refuses it', async () => {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      const answer = queue.enqueue(removal);
      answer.catch(() => {});
      await settle();

      server.arrived[0]!.refuse(new Error('That item is locked.'));
      await settle();

      expect(queue.drawnOver(holding()).attachments).toHaveLength(1);
    });
  });
});

describe('Connector management', () => {
  describe('a connection change waiting for its answer never flips back while the connections are read', () => {
    const disconnected: CommandArgs = {
      name: 'disconnect_source_account',
      payload: { commandId: 'c-gone', issuedAt: AT, workspaceId: 'ws-work', sourceAccountId: 'account-teams' },
    };
    const TEAMS = { id: 'account-teams' } as SourceAccount;
    const MAIL = { id: 'account-mail' } as SourceAccount;
    const holding = (): SourceAccountList => ({ sourceAccounts: [MAIL, TEAMS] });
    const shown = (queue: ReturnType<typeof createChangeQueue>) =>
      queue.drawnList(holding(), connectionsDrawnOver('ws-work', () => undefined)).sourceAccounts.map((row) => row.id);
    const scope = 'sourceAccounts:ws-work';

    /** Sent under the scope its window gives its connection changes, and answered. */
    async function answered() {
      const server = aServer();
      const queue = createChangeQueue({ send: server.send });
      queue.enqueue(disconnected, undefined, scope).catch(() => {});
      await settle();
      return { server, queue };
    }

    it('draws the change from the moment it is made', async () => {
      const { queue } = await answered();

      expect(shown(queue)).toEqual(['account-mail']);
    });

    it('keeps drawing the change under a read of the connections that began before its answer', async () => {
      const { server, queue } = await answered();
      const early = queue.readStarted();
      server.arrived[0]!.answer();
      await settle();

      queue.readLanded(scope, early);

      expect(shown(queue)).toEqual(['account-mail']);
    });

    it('shows the server’s list once a read that began after the answer has landed', async () => {
      const { server, queue } = await answered();
      server.arrived[0]!.answer();
      await settle();
      const late = queue.readStarted();

      queue.readLanded(scope, late);

      expect(shown(queue)).toEqual(['account-mail', 'account-teams']);
    });

    it.each([
      { situation: 'the Workspace’s own read', landed: 'ws-work' },
      { situation: 'the list of Workspaces', landed: null },
      { situation: 'another Workspace’s connections', landed: 'sourceAccounts:ws-other' },
    ])('keeps drawing the change when only $situation lands', async ({ landed }) => {
      const { server, queue } = await answered();
      server.arrived[0]!.answer();
      await settle();
      const late = queue.readStarted();

      queue.readLanded(landed, late);

      expect(shown(queue)).toEqual(['account-mail']);
    });

    it('lets a read of the connections leave a Workspace’s change alone', async () => {
      const { server, queue } = await answered();
      void queue.enqueue(priority('high'));
      server.arrived[0]!.answer();
      await settle();
      server.arrived[1]!.answer();
      await settle();

      queue.readLanded(scope, queue.readStarted());

      expect(priorityShown(queue.drawnOver(sent()))).toBe('high');
    });

    it('draws the connection back when the server refuses the change', async () => {
      const { server, queue } = await answered();

      server.arrived[0]!.refuse(new Error('That connection is in use.'));
      await settle();

      expect(shown(queue)).toEqual(['account-mail', 'account-teams']);
    });
  });
});
