import { describe, expect, it } from 'vitest';
import { TITLE_LENGTH, type Item } from '@cockpit/shared';
import { linkedItemId, linkedItemStatus, splitOffLinkText, splitOffTitle, splitRelations } from '../../src/splitOff';

const ORIGIN = 'https://cockpit.example';
const AT = '2026-10-01T09:00:00.000Z';

function anItem(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    tenantId: 't',
    workspaceId: 'w1',
    workspaceDecided: true,
    capturedMessage: null,
    capturedTimeZone: null,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    sourceResolvedAt: null,
    title: id,
    description: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    waitingSince: null,
    priority: null,
    prioritySetAt: null,
    dueDate: null,
    dueDateSetAt: null,
    dueDateChosenAt: null,
    seriesId: null,
    splitFromItemId: null,
    unseen: false,
    deletedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

describe('Item editing', () => {
  describe('text split off a description is named by its first line, and the whole of it is the new item’s description', () => {
    it.each([
      { situation: 'a plain line', text: 'Call the plumber', title: 'Call the plumber' },
      { situation: 'several lines', text: '\n\nBook the venue\nfor 40 people', title: 'Book the venue' },
      { situation: 'a bullet', text: '* Order the cake', title: 'Order the cake' },
      { situation: 'a task box', text: '- [ ] Send invites', title: 'Send invites' },
      { situation: 'a heading', text: '## Budget', title: 'Budget' },
      { situation: 'bold and a link', text: '**Pay** the [deposit](https://x.example)', title: 'Pay the deposit' },
      { situation: 'nothing but marks', text: '* ', title: 'Untitled' },
    ])('$situation', ({ text, title }) => {
      expect(splitOffTitle(text)).toBe(title);
    });

    it('cuts a first line longer than a title can be', () => {
      const title = splitOffTitle('a'.repeat(TITLE_LENGTH + 50));
      expect(title).toHaveLength(TITLE_LENGTH);
      expect(title.endsWith('…')).toBe(true);
    });

    it('leaves a link reading “Split off to:” and the new item’s name', () => {
      expect(splitOffLinkText('Book the venue')).toBe('Split off to: Book the venue');
    });
  });

  describe('a link to an item in a description shows that item’s status', () => {
    it.each([
      { situation: 'an item of this Cockpit', href: `${ORIGIN}/w/w1?item=abc`, item: 'abc' },
      { situation: 'one written without the address', href: '/w/w1?item=abc', item: 'abc' },
      { situation: 'another site', href: 'https://elsewhere.example/w/w1?item=abc', item: null },
      { situation: 'a page of this Cockpit that is no item', href: `${ORIGIN}/w/w1/settings?item=abc`, item: null },
      { situation: 'a mail address', href: 'mailto:ana@example.com', item: null },
    ])('names the item for $situation', ({ href, item }) => {
      expect(linkedItemId(href, ORIGIN)).toBe(item);
    });

    it.each([
      { situation: 'to do', over: {}, status: 'To do' },
      { situation: 'started', over: { startedAt: AT }, status: 'In progress' },
      { situation: 'finished', over: { completedAt: AT }, status: 'Done' },
      { situation: 'dismissed', over: { deletedAt: AT }, status: null },
    ])('reads $situation as its status', ({ over, status }) => {
      expect(linkedItemStatus([anItem('abc', over)], 'abc')).toBe(status);
    });

    it('shows nothing for an item the workspace does not hold', () => {
      expect(linkedItemStatus([anItem('abc')], 'gone')).toBeNull();
    });
  });

  describe('an item names the item it was split off from, and every item split off it', () => {
    it('reads both ways from the one link, leaving out dismissed items', () => {
      const original = anItem('o');
      const first = anItem('a', { splitFromItemId: 'o', createdAt: '2026-10-02T00:00:00.000Z' });
      const second = anItem('b', { splitFromItemId: 'o', createdAt: '2026-10-01T10:00:00.000Z' });
      const dismissed = anItem('c', { splitFromItemId: 'o', deletedAt: AT });
      const items = [original, first, second, dismissed, anItem('other')];

      expect(splitRelations(original, items)).toEqual({ from: null, off: [second, first] });
      expect(splitRelations(first, items)).toEqual({ from: original, off: [] });
    });

    it('names nothing it was split from when the workspace does not hold that item', () => {
      expect(splitRelations(anItem('a', { splitFromItemId: 'gone' }), []).from).toBeNull();
    });
  });
});
