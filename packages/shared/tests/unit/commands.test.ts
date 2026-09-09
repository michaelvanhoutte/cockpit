import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/ids.js';
import {
  captureItemSchema,
  moveItemToPanelSchema,
  proposeItemTextsSchema,
} from '../../src/commands.js';

describe('Capture', () => {
  describe('a capture missing what the app needs to track it is refused', () => {
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
      // Every Item is some kind of thing, so a capture that says nothing about
      // what kind never reaches the account. It stopped being optional when
      // both pickers stopped offering *No type*; a front door with nobody to
      // answer waits for auto-detection rather than writing an Item with none.
      {
        situation: 'saying nothing about what kind of thing it is',
        capture: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: 'ws-work',
          itemId: uuidv7(),
          message: 'x',
        },
      },
      // Guards the `min(1)` rather than the requirement above it: a blank
      // string is a field filled in with nothing, which is the shape a form
      // sends when somebody clears it.
      {
        situation: 'naming an empty type',
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
        typeId: 'tenant-default-type-action',
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
        typeId: 'tenant-default-type-action',
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
      ...over,
    });

    it.each([
      { situation: 'a title longer than a row label may be', over: { title: 'x'.repeat(201) }, accepted: false },
      { situation: 'a title running over two lines', over: { title: 'Part\n11' }, accepted: false },
      { situation: 'a title saying nothing', over: { title: '  ' }, accepted: false },
      { situation: 'a message saying nothing', over: { description: '' }, accepted: false },
      { situation: 'no message at all', over: { description: undefined }, accepted: false },
      { situation: 'both texts as they should be', over: {}, accepted: true },
    ])('is $situation accepted: $accepted', ({ over, accepted }) => {
      expect(proposeItemTextsSchema.safeParse(proposal(over)).success).toBe(accepted);
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
});
