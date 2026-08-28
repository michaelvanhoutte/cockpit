import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/ids.js';
import { captureItemSchema } from '../../src/commands.js';

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
          title: 'x',
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
        title: 'Make appointment with Novy',
      });
      expect(parsed.success).toBe(true);
    });
  });
});
