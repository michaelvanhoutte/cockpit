import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/ids.js';
import { captureItemSchema, moveItemToPanelSchema } from '../../src/commands.js';

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
    ])('$situation', ({ capture }) => {
      expect(captureItemSchema.safeParse(capture).success).toBe(false);
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
