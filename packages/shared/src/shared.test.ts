import { describe, expect, it } from 'vitest';
import { uuidv7 } from './ids.js';
import { captureItemSchema } from './commands.js';

describe('uuidv7', () => {
  it('produces valid v7 UUIDs', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sorts by creation time', () => {
    const earlier = uuidv7(1_000_000_000_000);
    const later = uuidv7(1_000_000_000_001);
    expect(earlier < later).toBe(true);
  });
});

describe('command schemas', () => {
  it('accepts a valid capture_item command', () => {
    const parsed = captureItemSchema.safeParse({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId: 'ws-work',
      itemId: uuidv7(),
      title: 'Make appointment with Novy',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a command without a commandId', () => {
    const parsed = captureItemSchema.safeParse({
      issuedAt: new Date().toISOString(),
      workspaceId: 'ws-work',
      itemId: uuidv7(),
      title: 'x',
    });
    expect(parsed.success).toBe(false);
  });
});
