import { describe, expect, it } from 'vitest';
import type { Workspace } from '@cockpit/shared';
import { createItemTool, readCapture, senderFrom } from '../../../src/mcp/create-item.js';

/**
 * L1: how an app's capture is read against the account's own names, and what
 * the tool tells the app. That it is the account as it is now, written where
 * the Inbox shows it, and refused with nothing written, is
 * tests/integration/http/connected-apps.test.ts's.
 */

const workspace = (id: string, name: string): Workspace => ({
  id,
  tenantId: 'tenant-default',
  name,
  color: '#6f62b5',
  bar: '#594e91',
  ground: '#e2e2df',
  header: '#2d2e35',
});
const HOME = workspace('ws-home', 'Home');
const WORK = workspace('ws-work', 'Work');

describe('Capture', () => {
  describe("an app's capture is read against the workspaces as they are", () => {
    it.each([
      {
        situation: 'a message alone, which waits undecided',
        args: { message: '  Ring the plumber  ' },
        workspaces: [HOME, WORK],
        read: { ok: true, message: 'Ring the plumber', workspaceId: HOME.id, decided: false },
      },
      {
        situation: 'a workspace named in another case',
        args: { message: 'Send the quote', workspace: 'work' },
        workspaces: [HOME, WORK],
        read: { ok: true, message: 'Send the quote', workspaceId: WORK.id, decided: true },
      },
      {
        situation: 'an empty workspace, read as none named',
        args: { message: 'Something', workspace: '' },
        workspaces: [HOME],
        read: { ok: true, message: 'Something', workspaceId: HOME.id, decided: false },
      },
    ])('$situation', ({ args, workspaces, read }) => {
      expect(readCapture(args, workspaces)).toEqual(read);
    });

    it.each([
      { situation: 'a workspace nobody has', args: { message: 'x', workspace: 'Garden' }, says: ['"Garden"', '"Home", "Work"'] },
      { situation: 'a workspace that is not a name at all', args: { message: 'x', workspace: 7 }, says: ['"Home", "Work"'] },
      { situation: 'a type, of any name', args: { message: 'x', type: 'Task' }, says: ['type is not an argument'] },
      { situation: 'an empty type', args: { message: 'x', type: '' }, says: ['type is not an argument'] },
      { situation: 'no message', args: {}, says: ['1 and 60,000'] },
      { situation: 'a message of spaces', args: { message: '   ' }, says: ['1 and 60,000'] },
      { situation: 'a message one over the limit', args: { message: 'x'.repeat(60_001) }, says: ['1 and 60,000'] },
      { situation: 'no arguments at all', args: undefined, says: ['message'] },
    ])('refuses $situation, saying what would do', ({ args, says }) => {
      const read = readCapture(args, [HOME, WORK]);
      expect(read.ok).toBe(false);
      for (const words of says) expect(read.ok ? '' : read.refusal).toContain(words);
    });

    it('refuses a capture with no workspace to put it in, and says to make one', () => {
      const read = readCapture({ message: 'Somewhere to go' }, []);
      expect(read).toEqual({ ok: false, refusal: expect.stringContaining('no workspace yet') });
    });

    it('takes a message of exactly the limit', () => {
      expect(readCapture({ message: 'x'.repeat(60_000) }, [HOME]).ok).toBe(true);
    });
  });

  describe("an app is told the account's own workspaces", () => {
    it('names each, in the description and as the only values allowed, and offers no type', () => {
      const tool = createItemTool([HOME, WORK]);
      expect(tool.name).toBe('create_item');
      expect(tool.inputSchema.required).toEqual(['message']);
      expect(tool.inputSchema.properties.workspace!.enum).toEqual(['Home', 'Work']);
      expect(tool.inputSchema.properties).not.toHaveProperty('type');
      expect(tool.description).toContain('"Home", "Work"');
      expect(tool.description).not.toMatch(/types?:/i);
    });

    it('offers no list of workspaces to choose from where there are none, rather than an empty one', () => {
      const tool = createItemTool([]);
      expect(tool.inputSchema.properties.workspace).not.toHaveProperty('enum');
      expect(tool.description).toContain('Workspaces: none yet');
    });
  });
});

describe('Capture', () => {
  describe("an app's captures are signed with the name it registered, never with half a character", () => {
    it.each([
      { situation: 'a plain name', name: '  Claude  ', sender: 'Claude' },
      { situation: 'a name of nothing but spaces', name: '   ', sender: null },
      { situation: 'a name too long, cut at the limit', name: 'a'.repeat(250), sender: 'a'.repeat(200) },
      { situation: 'a name too long whose limit falls inside an emoji', name: `${'a'.repeat(199)}😀tail`, sender: 'a'.repeat(199) },
    ])('$situation', ({ name, sender }) => {
      expect(senderFrom(name)).toBe(sender);
    });
  });
});
