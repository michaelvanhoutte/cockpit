import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { RewriteHistoryEntry } from '@cockpit/shared';
import {
  SEEN_CHANGES_KEPT,
  noteFor,
  rememberSeenChange,
  seenChangeIn,
} from '../../src/cockpitChanges';
import { forgetEverything } from '../../src/session/forget';

/**
 * F1: the note under an item form's tabs is decided from the item's history and
 * what has been seen, both handed in, and what has been seen is kept in storage
 * handed in the way the dashboard filters' is - so none of this needs a browser,
 * and a browser that refuses storage is a case rather than a crash. That the
 * note is drawn, and goes when the tab is opened or a text saved, is
 * tests/unit/components/ItemForm.test.tsx.
 */

function aStore(seed: Record<string, string> = {}): Storage {
  const held = new Map(Object.entries(seed));
  return {
    get length() {
      return held.size;
    },
    key: (i: number) => [...held.keys()][i] ?? null,
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
    clear: () => held.clear(),
  } as Storage;
}

function aStoreThatRefuses(): Storage {
  const refuse = () => {
    throw new Error('storage is not available');
  };
  return {
    get length(): number {
      return refuse();
    },
    key: refuse,
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
    clear: refuse,
  } as unknown as Storage;
}

let nextId = 0;

/** An attempt that changed nothing, unless told otherwise. */
function anAttempt(overrides: Partial<RewriteHistoryEntry> = {}): RewriteHistoryEntry {
  nextId += 1;
  return {
    id: `attempt-${nextId}`,
    itemId: '11111111-1111-7111-8111-000000000001',
    titleBefore: 'call ann re q3 numbers',
    titleAfter: null,
    descriptionBefore: 'call ann re q3 numbers',
    descriptionAfter: null,
    proposedPanelName: null,
    status: 'rewritten',
    message: null,
    attemptedAt: '2026-10-01T09:00:00.000Z',
    looksAt: 'texts-and-panel',
    suggestedPanelBefore: null,
    suggestedPanelAfter: null,
    ...overrides,
  };
}

const PANEL = { id: 'p-compliance', name: 'Compliance', dashboardName: 'Day to day' };

describe('What Cockpit changed', () => {
  describe('the note under the tabs says Cockpit changed the title or description, naming only what it changed', () => {
    it.each([
      {
        situation: 'the title only',
        entries: [anAttempt({ titleAfter: 'Call Ann about the Q3 numbers' })],
        says: 'Cockpit changed the title',
      },
      {
        situation: 'the description only',
        entries: [anAttempt({ descriptionAfter: 'Call Ann about the Q3 numbers.' })],
        says: 'Cockpit changed the description',
      },
      {
        situation: 'both',
        entries: [anAttempt({ titleAfter: 'Call Ann', descriptionAfter: 'Call Ann about the Q3 numbers.' })],
        says: 'Cockpit changed the title and description',
      },
      {
        situation: 'the title and the suggested panel, which it leaves out',
        entries: [anAttempt({ titleAfter: 'Call Ann', suggestedPanelAfter: PANEL })],
        says: 'Cockpit changed the title',
      },
    ])('$situation', ({ entries, says }) => {
      expect(noteFor(entries, null)?.words).toBe(says);
    });

    it.each([
      { situation: 'only the suggested panel, which is in the tab and not the note', entries: [anAttempt({ looksAt: 'panel', suggestedPanelAfter: PANEL })] },
      { situation: 'nothing changed', entries: [anAttempt()] },
      { situation: 'it looked and left the note as it was', entries: [anAttempt({ status: 'left-as-is', message: 'nothing to act on' })] },
      { situation: 'an attempt still working', entries: [anAttempt({ status: 'pending' })] },
      { situation: 'an attempt that failed', entries: [anAttempt({ status: 'failed', message: '429' })] },
      { situation: 'no history at all', entries: [] },
    ])('no note for $situation', ({ entries }) => {
      expect(noteFor(entries, null)).toBeNull();
    });
  });

  describe('the note stays gone for the change that was seen, and returns for a newer one', () => {
    it('is gone once its change is seen', () => {
      const change = anAttempt({ titleAfter: 'Call Ann' });

      expect(noteFor([change], change.id)).toBeNull();
    });

    it('returns, for the new change, when Cockpit changes it again', () => {
      const seen = anAttempt({ titleAfter: 'Call Ann', attemptedAt: '2026-10-01T09:00:00.000Z' });
      const newer = anAttempt({ descriptionAfter: 'Call Ann.', attemptedAt: '2026-10-02T09:00:00.000Z' });

      expect(noteFor([newer, seen], seen.id)).toEqual({
        changeId: newer.id,
        words: 'Cockpit changed the description',
      });
    });

    it('does not return for a later change to the suggested panel alone', () => {
      const seen = anAttempt({ titleAfter: 'Call Ann', attemptedAt: '2026-10-01T09:00:00.000Z' });
      const panelOnly = anAttempt({
        looksAt: 'panel',
        suggestedPanelAfter: PANEL,
        attemptedAt: '2026-10-02T09:00:00.000Z',
      });

      expect(noteFor([panelOnly, seen], seen.id)).toBeNull();
    });
  });

  describe('what the person has seen is kept per item in this browser and forgotten at sign-out', () => {
    it('reads back as seen', () => {
      const store = aStore();
      rememberSeenChange(store, 'item-1', 'attempt-a');

      expect(seenChangeIn(store, 'item-1')).toBe('attempt-a');
    });

    it('keeps one item’s apart from another’s', () => {
      const store = aStore();
      rememberSeenChange(store, 'item-1', 'attempt-a');

      expect(seenChangeIn(store, 'item-2')).toBeNull();
    });

    it('keeps the latest change seen of an item, not every one', () => {
      const store = aStore();
      rememberSeenChange(store, 'item-1', 'attempt-a');
      rememberSeenChange(store, 'item-1', 'attempt-b');

      expect(seenChangeIn(store, 'item-1')).toBe('attempt-b');
    });

    it('forgets the oldest item once more are seen than the account’s own history reads back, and its note returns', () => {
      const store = aStore();
      for (let at = 0; at <= SEEN_CHANGES_KEPT; at += 1) rememberSeenChange(store, `item-${at}`, `attempt-${at}`);
      const change = anAttempt({ id: 'attempt-0', titleAfter: 'Call Ann' });

      expect(seenChangeIn(store, 'item-0')).toBeNull();
      expect(noteFor([change], seenChangeIn(store, 'item-0'))).not.toBeNull();
      expect(seenChangeIn(store, `item-${SEEN_CHANGES_KEPT}`)).toBe(`attempt-${SEEN_CHANGES_KEPT}`);
    });

    it.each([
      { situation: 'something that is not JSON', stored: 'attempt-a' },
      { situation: 'JSON that is not a list', stored: '{"item-1":"attempt-a"}' },
      { situation: 'a list holding things that are not pairs of ids', stored: '[1,null,["item-1"],["item-1",2]]' },
    ])('treats $situation as not seen', ({ stored }) => {
      const store = aStore({ 'cockpit.seen-changes': stored });

      expect(seenChangeIn(store, 'item-1')).toBeNull();
    });

    it.each([
      { situation: 'no storage at all', store: undefined },
      { situation: 'storage that refuses', store: aStoreThatRefuses() },
    ])('throws nothing with $situation', ({ store }) => {
      expect(seenChangeIn(store, 'item-1')).toBeNull();
      expect(() => rememberSeenChange(store, 'item-1', 'attempt-a')).not.toThrow();
    });

    it('is left nothing of when signing out', async () => {
      window.localStorage.clear();
      rememberSeenChange(window.localStorage, 'item-1', 'attempt-a');
      window.localStorage.setItem('somebody else', 'theirs');

      await forgetEverything(new QueryClient());

      expect(seenChangeIn(window.localStorage, 'item-1')).toBeNull();
      expect(window.localStorage.getItem('somebody else')).toBe('theirs');
      window.localStorage.clear();
    });
  });
});
