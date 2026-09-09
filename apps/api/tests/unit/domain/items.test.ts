import { describe, expect, it } from 'vitest';
import type { Item } from '@cockpit/shared';
import {
  applyProposedTexts,
  applySetDescription,
  applySetDismissed,
  applySetDone,
  applySetTitle,
  captureItem,
  decideWorkspace,
} from '../../../src/domain/items.js';

const MADE = '2026-08-12T10:00:00.000Z';
const LATER = '2026-08-12T10:00:01.000Z';
const LATEST = '2026-08-12T10:00:02.000Z';

const request = {
  commandId: '018f0000-0000-7000-8000-000000000001',
  workspaceId: 'ws-work',
  // Every capture names what kind of thing it is, so every one built here does.
  typeId: 'tenant-default-type-action',
};

function anItem(overrides: Partial<Item> = {}): Item {
  return {
    ...captureItem(
      {
        ...request,
        issuedAt: MADE,
        itemId: '018f0000-0000-7000-8000-000000000002',
        message: 'Make appointment with Novy',
      },
      'tenant-default',
    ),
    ...overrides,
  };
}

const done = (item: Item, at: string, isDone: boolean) =>
  applySetDone(item, { ...request, issuedAt: at, itemId: 'x', done: isDone });

const dismissed = (item: Item, at: string, isDismissed: boolean) =>
  applySetDismissed(item, { ...request, issuedAt: at, itemId: 'x', dismissed: isDismissed });

const titled = (item: Item, at: string, title: string) =>
  applySetTitle(item, { ...request, issuedAt: at, itemId: item.id, title })!;

const described = (item: Item, at: string, description: string) =>
  applySetDescription(item, { ...request, issuedAt: at, itemId: item.id, description })!;

describe('Capture', () => {
  describe('a thought captured in the app arrives yours to deal with', () => {
    it('has no source behind it and is stamped with the time it was made', () => {
      const item = anItem();
      expect(item.source).toBe('internal');
      expect(item.completedAt).toBeNull();
      expect(item.createdAt).toBe(MADE);
      expect(item.updatedAt).toBe(MADE);
    });

    // Which of the two texts a message becomes is decided in
    // packages/shared/tests/unit/domain/item.test.ts; what is asked here is
    // that capture asks it, and keeps the message itself beside the answer.
    it('is named by what was captured, and keeps what was captured as well', () => {
      const item = anItem();
      expect(item.title).toBe('Make appointment with Novy');
      expect(item.description).toBeNull();
      expect(item.capturedMessage).toBe('Make appointment with Novy');
    });
  });
});

describe('Capture', () => {
  /**
   * L1: which workspace an item gets, and whether it gets one at all, is a
   * decision over the command and the item. That the Inbox then shows it in
   * every workspace, and stops, is a query and is proved against a real store
   * in apps/api/tests/integration/http/item-changes.test.ts.
   */
  describe('capture says where an item belongs, or that nobody has said yet', () => {
    it.each([
      {
        situation: 'a front door with no opinion, which is every one but the Capture page',
        asked: {},
        decided: true,
      },
      { situation: 'the Inbox’s own row, inside a workspace', asked: { workspaceDecided: true }, decided: true },
      {
        situation: 'the Capture page, left on Any workspace',
        asked: { workspaceDecided: false },
        decided: false,
      },
    ])('$situation', ({ asked, decided }) => {
      const item = captureItem(
        {
          ...request,
          ...asked,
          issuedAt: MADE,
          itemId: '018f0000-0000-7000-8000-000000000002',
          message: 'Make appointment with Novy',
        },
        'tenant-default',
      );
      expect(item.workspaceDecided).toBe(decided);
      // Either way it records the workspace it was captured from, which is
      // what a later router reads and what the foreign key needs.
      expect(item.workspaceId).toBe('ws-work');
    });
  });

  describe('an item gets its workspace the first time somebody says where it belongs, and keeps it', () => {
    const undecided = () => anItem({ workspaceDecided: false });

    it('takes the workspace it is put into, and stops belonging to none', () => {
      const settled = decideWorkspace(undecided(), 'ws-home', LATER);
      expect(settled).toEqual(expect.objectContaining({ workspaceId: 'ws-home', workspaceDecided: true }));
      expect(settled?.updatedAt).toBe(LATER);
    });

    it.each([
      { situation: 'put into the workspace it was captured from', into: 'ws-work' },
      { situation: 'put into another workspace', into: 'ws-home' },
    ])('$situation is still an answer', ({ into }) => {
      expect(decideWorkspace(undecided(), into, LATER)?.workspaceId).toBe(into);
    });

    /**
     * **The first answer wins, not the last one.** Everything else about an
     * item is last-write-wins on the command's clock; this is the one thing a
     * later command may not have an opinion about, because the question it
     * answers has already been answered.
     */
    it.each([
      { situation: 'moved again, later', at: LATEST },
      { situation: 'a command that was slow to arrive', at: MADE },
    ])('leaves an item that already belongs somewhere alone, $situation', ({ at }) => {
      expect(decideWorkspace(anItem(), 'ws-home', at)).toBeNull();
    });

    /**
     * A settling is never refused for being late - the question it answers has
     * nothing to be stale about - but `updatedAt` is what every other handler
     * measures staleness by, so it must not go backwards. Writing the command's
     * own clock into it would let commands they had rightly rejected through.
     */
    it.each([
      { situation: 'a settling made after the last change', at: LATEST, kept: LATEST },
      { situation: 'one that was slow to arrive', at: MADE, kept: LATER },
    ])('$situation leaves the time of the last change no earlier', ({ at, kept }) => {
      const undecided = anItem({ workspaceDecided: false, updatedAt: LATER });

      expect(decideWorkspace(undecided, 'ws-home', at)?.updatedAt).toBe(kept);
      // Late or not, it still answers the question.
      expect(decideWorkspace(undecided, 'ws-home', at)?.workspaceId).toBe('ws-home');
    });
  });
});

describe('Triage', () => {
  describe('an item is either yours to deal with or finished with', () => {
    it.each([
      { situation: 'finished with', act: (i: Item) => done(i, LATER, true), finished: LATER },
      {
        situation: 'finished with and then picked up again',
        act: (i: Item) => done(done(i, LATER, true)!, LATEST, false),
        finished: null,
      },
      {
        situation: 'dismissed after being finished with',
        act: (i: Item) => dismissed(done(i, LATER, true)!, LATEST, true),
        finished: LATER,
      },
    ])('says when it was $situation', ({ act, finished }) => {
      expect(act(anItem())?.completedAt).toBe(finished);
    });

    it('says when it was last changed, whichever way it went', () => {
      expect(done(anItem(), LATER, true)?.updatedAt).toBe(LATER);
      expect(done(anItem(), LATER, false)?.updatedAt).toBe(LATER);
    });
  });

  describe('a dismissed item leaves the lists but is never erased', () => {
    it('records when it was dismissed instead of dropping the item', () => {
      expect(dismissed(anItem(), LATER, true)?.deletedAt).toBe(LATER);
    });

    it('comes back when the dismissal is taken back, still yours to deal with', () => {
      const gone = dismissed(anItem(), LATER, true)!;
      const back = dismissed(gone, LATEST, false);

      // Nothing was erased, so what has to go is the record that it was
      // dismissed - without which a dismissal could never be undone.
      expect(back?.deletedAt).toBeNull();
      expect(back?.completedAt).toBeNull();
    });

    it('leaves an item that was finished with finished with when it comes back', () => {
      const finishedThenGone = dismissed(done(anItem(), LATER, true)!, LATEST, true)!;
      expect(dismissed(finishedThenGone, '2026-08-31T12:00:00.000Z', false)?.completedAt).toBe(LATER);
    });
  });
});

describe('Offline', () => {
  describe('a change made against an older version of an item is refused', () => {
    it.each([
      { situation: 'finishing with it', act: (i: Item) => done(i, LATER, true) },
      { situation: 'dismissing it', act: (i: Item) => dismissed(i, LATER, true) },
    ])('leaves the item alone rather than undoing the newer change when $situation', ({ act }) => {
      expect(act(anItem({ updatedAt: LATEST }))).toBeNull();
    });
  });
});

describe('Capture', () => {
  /**
   * L1: whether a proposal may be written is a decision over the item and the
   * proposal, and nothing else. That the reading happens at all, and that the
   * store refuses the same write for the same reason, is proved against a real
   * store in apps/api/tests/integration/http/note-cleanup.test.ts.
   */
  describe('a captured note is named by Cockpit until you edit either text, and by you after that', () => {
    const proposed = (item: Item) =>
      applyProposedTexts(item, {
        ...request,
        issuedAt: LATEST,
        itemId: item.id,
        title: 'Ask Novy about the Part 11 audit trail',
        description: 'A question about the Part 11 audit trail for the validation protocol.',
      });

    it.each([
      {
        situation: 'nothing has been edited since it was captured',
        before: (item: Item) => item,
        rewritten: true,
      },
      {
        situation: 'the title has been edited',
        before: (item: Item) => titled(item, LATER, 'Novy'),
        rewritten: false,
      },
      {
        situation: 'the description has been edited',
        before: (item: Item) => described(item, LATER, 'Mine to write'),
        rewritten: false,
      },
      {
        situation: 'Cockpit has already read the note once',
        before: (item: Item) => proposed(item)!,
        rewritten: true,
      },
    ])('is rewritten only where $situation', ({ before, rewritten }) => {
      const standing = before(anItem());

      const after = proposed(standing);

      expect(after === null).toBe(!rewritten);
      expect((after ?? standing).title).toBe(
        rewritten ? 'Ask Novy about the Part 11 audit trail' : standing.title,
      );
      expect((after ?? standing).description).toBe(
        rewritten
          ? 'A question about the Part 11 audit trail for the validation protocol.'
          : standing.description,
      );
    });

    it.each([
      { situation: 'the title', edit: (item: Item) => titled(item, LATER, 'Mine') },
      { situation: 'the description', edit: (item: Item) => described(item, LATER, 'Mine') },
    ])('takes both texts over the first time you edit $situation', ({ edit }) => {
      expect(edit(anItem()).textsSettledAt).toBe(LATER);
    });

    it('stays taken over at the moment you first took it, not the last time you typed', () => {
      const mine = titled(anItem(), LATER, 'Mine');
      expect(described(mine, LATEST, 'Also mine').textsSettledAt).toBe(LATER);
    });

    /**
     * The rule the whole feature is judged against: what somebody actually said
     * is a record, and nothing here may rewrite it - not the reading, and not
     * the edits that follow it.
     */
    it.each([
      { situation: 'Cockpit has read it', after: (item: Item) => proposed(item)! },
      { situation: 'Cockpit has read it twice', after: (item: Item) => proposed(proposed(item)!)! },
      { situation: 'both texts have been edited', after: (item: Item) => described(titled(item, LATER, 'Mine'), LATEST, 'Also mine') },
    ])('keeps what was captured exactly as it was said once $situation', ({ after }) => {
      expect(after(anItem()).capturedMessage).toBe('Make appointment with Novy');
    });
  });
});

describe('Offline', () => {
  /**
   * Cockpit reading a note is not a change somebody made, so it must not make
   * their own change look old. Distinct from the rule above: that one is about
   * Cockpit refusing to write, this one is about what it leaves behind when it
   * does write.
   */
  describe('an edit made on another device still lands after Cockpit has read the note', () => {
    it('is applied rather than refused for being older than the reading', () => {
      const read = applyProposedTexts(anItem(), {
        ...request,
        issuedAt: '2026-08-12T10:00:05.000Z',
        itemId: '018f0000-0000-7000-8000-000000000002',
        title: 'Ask Novy about the appointment',
        description: 'Make an appointment with Novy.',
      })!;

      // Typed a second after the capture, on a phone that only reached the
      // server after the reading had landed.
      expect(titled(read, LATER, 'Novy, appointment').title).toBe('Novy, appointment');
    });
  });
});
