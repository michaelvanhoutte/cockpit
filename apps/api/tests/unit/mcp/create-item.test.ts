import { describe, expect, it } from 'vitest';
import type { ItemType, Workspace } from '@cockpit/shared';
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
  ground: '#f3f3f1',
  header: '#2d2e35',
});
const type = (id: string, name: string): ItemType => ({
  id,
  tenantId: 'tenant-default',
  name,
  color: '#6f62b5',
  position: 0,
  createdAt: '2026-08-12T00:00:00.000Z',
});

const HOME = workspace('ws-home', 'Home');
const WORK = workspace('ws-work', 'Work');
const TASK = type('type-task', 'Task');
const NOTE = type('type-note', 'Note');
const NOTE_ID = NOTE.id;

describe('Capture', () => {
  describe("an app's capture is read against the workspaces and types as they are", () => {
    it.each([
      {
        situation: 'a message alone, which waits undecided as a Note',
        args: { message: '  Ring the plumber  ' },
        workspaces: [HOME, WORK],
        types: [TASK, NOTE],
        read: { ok: true, message: 'Ring the plumber', workspaceId: HOME.id, decided: false, typeId: NOTE.id },
      },
      {
        situation: 'a workspace and a type named in another case',
        args: { message: 'Send the quote', workspace: 'work', type: 'TASK' },
        workspaces: [HOME, WORK],
        types: [TASK, NOTE],
        read: { ok: true, message: 'Send the quote', workspaceId: WORK.id, decided: true, typeId: TASK.id },
      },
      {
        situation: 'an account whose Note has gone, which captures as its first type',
        args: { message: 'Something' },
        workspaces: [HOME],
        types: [TASK],
        read: { ok: true, message: 'Something', workspaceId: HOME.id, decided: false, typeId: TASK.id },
      },
      {
        situation: 'an empty workspace or type, read as none named',
        args: { message: 'Something', workspace: '', type: null },
        workspaces: [HOME],
        types: [TASK, NOTE],
        read: { ok: true, message: 'Something', workspaceId: HOME.id, decided: false, typeId: NOTE.id },
      },
    ])('$situation', ({ args, workspaces, types, read }) => {
      expect(readCapture(args, workspaces, types, NOTE_ID)).toEqual(read);
    });

    it.each([
      { situation: 'a workspace nobody has', args: { message: 'x', workspace: 'Garden' }, says: ['"Garden"', '"Home", "Work"'] },
      { situation: 'a workspace that is not a name at all', args: { message: 'x', workspace: 7 }, says: ['"Home", "Work"'] },
      { situation: 'a type nobody has', args: { message: 'x', type: 'Errand' }, says: ['"Errand"', '"Task", "Note"'] },
      { situation: 'no message', args: {}, says: ['1 and 60,000'] },
      { situation: 'a message of spaces', args: { message: '   ' }, says: ['1 and 60,000'] },
      { situation: 'a message one over the limit', args: { message: 'x'.repeat(60_001) }, says: ['1 and 60,000'] },
      { situation: 'no arguments at all', args: undefined, says: ['message'] },
    ])('refuses $situation, saying what would do', ({ args, says }) => {
      const read = readCapture(args, [HOME, WORK], [TASK, NOTE], NOTE_ID);
      expect(read.ok).toBe(false);
      for (const words of says) expect(read.ok ? '' : read.refusal).toContain(words);
    });

    it('refuses a capture with no workspace to put it in, and says to make one', () => {
      const read = readCapture({ message: 'Somewhere to go' }, [], [TASK, NOTE], NOTE_ID);
      expect(read).toEqual({ ok: false, refusal: expect.stringContaining('no workspace yet') });
    });

    it('takes a message of exactly the limit', () => {
      expect(readCapture({ message: 'x'.repeat(60_000) }, [HOME], [NOTE], NOTE_ID).ok).toBe(true);
    });
  });

  describe("an app is told the account's own workspaces and types", () => {
    it('names each, in the description and as the only values allowed', () => {
      const tool = createItemTool([HOME, WORK], [TASK, NOTE]);
      expect(tool.name).toBe('create_item');
      expect(tool.inputSchema.required).toEqual(['message']);
      expect(tool.inputSchema.properties.workspace!.enum).toEqual(['Home', 'Work']);
      expect(tool.inputSchema.properties.type!.enum).toEqual(['Task', 'Note']);
      expect(tool.description).toContain('"Home", "Work"');
      expect(tool.description).toContain('"Task", "Note"');
    });

    it('offers no list of workspaces to choose from where there are none, rather than an empty one', () => {
      const tool = createItemTool([], [NOTE]);
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
