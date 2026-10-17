import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/ids.js';
import { panelFilterAsStored, panelFilterFrom, type FilterCondition } from '../../src/domain/panel.js';
import {
  captureItemSchema,
  moveItemToPanelSchema,
  proposeItemPanelSchema,
  proposeItemTextsSchema,
  setDuplicateSettledSchema,
  setPanelFilterSchema,
  setPanelSettingsSchema,
  setPanelSortSchema,
} from '../../src/commands.js';

describe('Capture', () => {
  describe('a capture missing what the app needs to track it, or carrying a type, is refused', () => {
    it.each([
      {
        // Without it a retry could not be recognised as one.
        situation: 'without a request id',
        capture: {
          issuedAt: new Date().toISOString(),
          workspaceId: 'ws-work',
          itemId: uuidv7(),
          message: 'x',
        },
      },
      // A capture carries no Type, and a key Zod does not know would be
      // dropped in silence, so the refusal is the schema's own.
      {
        situation: 'carrying a type id',
        capture: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: 'ws-work',
          itemId: uuidv7(),
          message: 'x',
          typeId: 'tenant-default-type-action',
        },
      },
      {
        situation: 'carrying an empty type id',
        capture: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: 'ws-work',
          itemId: uuidv7(),
          message: 'x',
          typeId: '',
        },
      },
    ])('$situation', ({ capture }) => {
      expect(captureItemSchema.safeParse(capture).success).toBe(false);
    });
  });

  describe('what is captured is text, and not more of it than a device can hold', () => {
    // Capped where a description is capped, and for the same reason: it lands
    // in the same snapshot, which every device holds a copy of.
    it.each([
      { situation: 'nothing at all', message: '', accepted: false },
      { situation: 'nothing but blanks', message: '   ', accepted: false },
      { situation: 'a message at the cap', message: 'x'.repeat(60_000), accepted: true },
      { situation: 'a message over the cap', message: 'x'.repeat(60_001), accepted: false },
      // Trimmed before it is measured, so blanks on the ends are not what puts
      // one over: they are not stored either.
      {
        situation: 'a message at the cap with blanks around it',
        message: `  ${'x'.repeat(60_000)}  `,
        accepted: true,
      },
      // The one text that runs to paragraphs on the way in - a dictated note
      // arrives with them - so line breaks are kept rather than refused.
      {
        situation: 'a message over several lines',
        message: 'Ask Novy\n\nabout part 11',
        accepted: true,
      },
    ])('$situation', ({ message, accepted }) => {
      const parsed = captureItemSchema.safeParse({
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId: 'ws-work',
        itemId: uuidv7(),
        message,
      });
      expect(parsed.success).toBe(accepted);
    });
  });

  describe('a complete capture is accepted', () => {
    it('takes the note as given', () => {
      const parsed = captureItemSchema.safeParse({
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId: 'ws-work',
        itemId: uuidv7(),
        message: 'Make appointment with Novy',
      });
      expect(parsed.success).toBe(true);
    });
  });

  /**
   * The second lock. What Cockpit proposes for a note is already refused
   * against these same rules where the answer is read
   * (apps/api/src/ai/note-texts.ts), so nothing can reach this with a bad
   * value - which is exactly why it is asked here rather than through anything:
   * a lock the way in cannot reach has to be tested where it stands, the way
   * the database's own constraints are.
   */
  describe('a reading that would not fit the two texts it lands in is refused', () => {
    const proposal = (over: Record<string, unknown> = {}) => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: 'ws-work',
      itemId: uuidv7(),
      title: 'Ask Novy about the Part 11 audit trail',
      description: 'A question about the Part 11 audit trail for the validation protocol.',
      readings: [],
      ...over,
    });

    it.each([
      { situation: 'a title longer than a row label may be', over: { title: 'x'.repeat(201) }, accepted: false },
      { situation: 'a title running over two lines', over: { title: 'Part\n11' }, accepted: false },
      { situation: 'a title saying nothing', over: { title: '  ' }, accepted: false },
      { situation: 'a message saying nothing', over: { description: '' }, accepted: false },
      { situation: 'no message at all', over: { description: undefined }, accepted: false },
      { situation: 'both texts as they should be', over: {}, accepted: true },
      { situation: 'no readings at all', over: { readings: undefined }, accepted: false },
      {
        situation: 'a reading offering another title, the note supporting more than one',
        over: {
          readings: [
            { title: 'Call Jan', description: '', meaning: "'jan' is a person's name" },
          ],
        },
        accepted: true,
      },
      {
        situation: 'a reading whose own title would not fit a row label',
        over: { readings: [{ title: 'x'.repeat(201), description: '', meaning: 'too long to offer' }] },
        accepted: false,
      },
    ])('is $situation accepted: $accepted', ({ over, accepted }) => {
      expect(proposeItemTextsSchema.safeParse(proposal(over)).success).toBe(accepted);
    });
  });

  /**
   * The second lock again, for how sure a proposed Panel is ("Propose the
   * closest Panel at capture, and draw a less certain one dashed", issue
   * 1107): the answer's reader already refuses a fit outside the two.
   */
  describe('a proposed panel says how sure it is only as clear or closest, and a withdrawn one says nothing', () => {
    const proposal = (over: Record<string, unknown>) => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: 'ws-work',
      itemId: uuidv7(),
      panelId: uuidv7(),
      reason: 'a compliance question',
      ...over,
    });

    it.each([
      { situation: 'a panel said to be clear', over: { fit: 'clear' }, accepted: true },
      { situation: 'a panel said to be the closest match', over: { fit: 'closest' }, accepted: true },
      { situation: 'a panel that does not say', over: {}, accepted: true },
      { situation: 'a panel said to be likely', over: { fit: 'likely' }, accepted: false },
      { situation: 'a withdrawal', over: { panelId: null, reason: '' }, accepted: true },
      { situation: 'a withdrawal said to be the closest match', over: { panelId: null, reason: '', fit: 'closest' }, accepted: false },
    ])('is $situation accepted: $accepted', ({ over, accepted }) => {
      expect(proposeItemPanelSchema.safeParse(proposal(over)).success).toBe(accepted);
    });
  });
});

describe('Panels', () => {
  describe('a move that does not describe one arrangement is refused before it is sent', () => {
    const item = uuidv7();
    const other = uuidv7();
    const panel = uuidv7();
    const envelope = {
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: 'ws-work',
      itemId: item,
    };

    it.each([
      {
        situation: 'an order naming the same item twice',
        move: { ...envelope, panelId: panel, order: [item, other, item] },
      },
      {
        situation: 'an order without the item that moved',
        move: { ...envelope, panelId: panel, order: [other] },
      },
      {
        situation: 'a move to the Inbox carrying an order',
        move: { ...envelope, panelId: null, order: [item] },
      },
    ])('$situation', ({ move }) => {
      expect(moveItemToPanelSchema.safeParse(move).success).toBe(false);
    });

    it.each([
      {
        situation: 'the panel’s whole order with the item in it',
        move: { ...envelope, panelId: panel, order: [other, item] },
      },
      { situation: 'a move to the Inbox with no order', move: { ...envelope, panelId: null, order: [] } },
    ])('accepts $situation', ({ move }) => {
      expect(moveItemToPanelSchema.safeParse(move).success).toBe(true);
    });
  });

  describe('a Filter saved with an exclusion and Status values is stored and read back as it was saved', () => {
    const save = (conditions: unknown[]) =>
      setPanelFilterSchema.safeParse({
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId: 'ws-work',
        panelId: uuidv7(),
        rows: [conditions],
      });

    it('keeps the exclusion flag and the Status values through the schema, the stored text and the read', () => {
      const conditions: FilterCondition[] = [
        { field: 'priority', values: ['low'], exclude: true },
        { field: 'status', values: ['to_do'], exclude: true },
      ];
      const saved = save(conditions);
      expect(saved.success).toBe(true);
      if (!saved.success) return;

      const read = panelFilterFrom(panelFilterAsStored(saved.data.rows, saved.data.groupBy));

      expect(read?.rows).toEqual([conditions]);
    });

    it('refuses a Status value of Done, which a Filter never draws', () => {
      expect(save([{ field: 'status', values: ['done'] }]).success).toBe(false);
    });
  });

  describe('an Agent running condition is saved and read back like any other', () => {
    const save = (rows: unknown[][]) =>
      setPanelFilterSchema.safeParse({
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId: 'ws-work',
        panelId: uuidv7(),
        rows,
      });
    const agent: FilterCondition = { field: 'agent' };

    it.each([
      { situation: 'alone', rows: [[agent]] },
      {
        situation: 'beside a Panel is not condition in its row, keeping the exclusion',
        rows: [[agent, { field: 'panel', values: ['panel-q3'], exclude: true }]],
      },
      { situation: 'in two rows', rows: [[agent], [{ field: 'status' }, agent]] },
    ])('reads back $situation as it was saved', ({ rows }) => {
      const saved = save(rows);
      expect(saved.success).toBe(true);
      if (!saved.success) return;

      expect(panelFilterFrom(panelFilterAsStored(saved.data.rows, saved.data.groupBy))?.rows).toEqual(rows);
    });

    it('refuses it twice in one row, as a duplicate field is refused', () => {
      expect(save([[agent, agent]]).success).toBe(false);
    });
  });

  describe('a save naming Type is refused, since neither a Filter nor a Sort goes by Type any more', () => {
    const envelope = {
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: 'ws-work',
      panelId: uuidv7(),
    };

    it.each([
      {
        situation: 'a Filter with a Type condition',
        refused: setPanelFilterSchema.safeParse({ ...envelope, conditions: [{ field: 'type', values: ['type-note'] }] }),
      },
      {
        situation: 'a Sort with a Type criterion',
        refused: setPanelSortSchema.safeParse({ ...envelope, sort: [{ field: 'type', direction: 'asc' }] }),
      },
    ])('refuses $situation', ({ refused }) => {
      expect(refused.success).toBe(false);
    });
  });
});

describe('Triage', () => {
  describe('settling a pair as not a duplicate ("Say a flagged pair is not a duplicate", issue 408)', () => {
    const envelope = {
      commandId: uuidv7(),
      issuedAt: '2026-09-09T10:00:00.000Z',
      workspaceId: 'ws-work',
    };
    const item = uuidv7();
    const other = uuidv7();

    it('refuses a pair naming the same item twice', () => {
      const settled = setDuplicateSettledSchema.safeParse({
        ...envelope,
        itemId: item,
        otherItemId: item,
        settled: true,
      });

      expect(settled.success).toBe(false);
    });

    it('accepts two different items, settled and taken back alike', () => {
      for (const settled of [true, false]) {
        expect(
          setDuplicateSettledSchema.safeParse({
            ...envelope,
            itemId: item,
            otherItemId: other,
            settled,
          }).success,
        ).toBe(true);
      }
    });
  });
});

describe('Panels', () => {
  describe('a save that cannot be a rename, or says nothing, is refused before it is sent', () => {
    const base = {
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: 'ws-work',
      panelId: uuidv7(),
    };

    it.each([
      { situation: 'a name of one character', changes: { name: 'x' }, accepted: true },
      { situation: 'a name of 60 characters', changes: { name: 'x'.repeat(60) }, accepted: true },
      { situation: 'a name of 61 characters', changes: { name: 'x'.repeat(61) }, accepted: false },
      { situation: 'a name of nothing but blanks', changes: { name: '   ' }, accepted: false },
      { situation: 'an empty name', changes: { name: '' }, accepted: false },
      { situation: 'Never propose alone', changes: { neverPropose: false }, accepted: true },
      { situation: 'read-only and formatting alone', changes: { readOnly: true, format: 'rich' }, accepted: true },
      { situation: 'a way of drawing nothing knows about', changes: { format: 'html' }, accepted: false },
      { situation: 'a column width the product offers', changes: { columns: 'wide' }, accepted: true },
      { situation: 'one list, said as null', changes: { columns: null }, accepted: true },
      { situation: 'a column width nothing offers', changes: { columns: 'huge' }, accepted: false },
      { situation: 'a column width in pixels', changes: { columns: 420 }, accepted: false },
      { situation: 'nothing at all', changes: {}, accepted: false },
    ])('$situation', ({ changes, accepted }) => {
      expect(setPanelSettingsSchema.safeParse({ ...base, ...changes }).success).toBe(accepted);
    });
  });
});
