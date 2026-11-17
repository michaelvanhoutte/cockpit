import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../../../src/mcp/create-item.js';
import { deleteItemTool, readItemId, restoreItemTool } from '../../../src/mcp/delete-item.js';

/**
 * L1: how an app's id is read, and what the two tools tell the app. Whose Item
 * it names, that it is dismissed as a swipe dismisses it and that the limit
 * reaches it is tests/integration/http/delete-item.test.ts.
 */

const ID = '018f0000-0000-7000-8000-000000000001';

describe('MCP connections', () => {
  describe('an app names the item to delete or restore by its id or the link that opens it', () => {
    it.each([
      { situation: 'a bare id', id: ID },
      { situation: 'a bare id in capitals, with spaces around it', id: `  ${ID.toUpperCase()} ` },
      { situation: 'the link find_items gives', id: `https://cockpit.example/w/ws-1?item=${ID}` },
      { situation: 'that link for an item in a workspace with an id of its own shape', id: `https://cockpit.example/w/${ID}?item=${ID}` },
    ])('reads $situation as the item', ({ id }) => {
      expect(readItemId({ id })).toEqual({ ok: true, itemId: ID });
    });

    it.each([
      { situation: 'no id', args: {} },
      { situation: 'no arguments at all', args: undefined },
      { situation: 'an id that is a number', args: { id: 7 } },
      { situation: 'words', args: { id: 'the quote task' } },
      { situation: 'an id with a character too many', args: { id: `${ID}0` } },
      { situation: 'a link with no item in it', args: { id: 'https://cockpit.example/w/ws-1' } },
      { situation: 'a link whose item is not an id', args: { id: 'https://cockpit.example/w/ws-1?item=7' } },
      { situation: 'an address that does not open an item of a workspace', args: { id: `https://cockpit.example/settings?item=${ID}` } },
      { situation: 'an address that is not a web one', args: { id: `ftp://cockpit.example/w/ws-1?item=${ID}` } },
    ])('refuses $situation, saying what to pass', ({ args }) => {
      const read = readItemId(args);
      expect(read).toEqual({ ok: false, refusal: expect.stringContaining('id of an item or the link that opens it') });
    });
  });

  describe('the tools are listed, and say what they do', () => {
    it('lists delete_item with an id, saying that deleting dismisses and restore_item undoes it', () => {
      const tool = deleteItemTool();

      expect(tool.name).toBe('delete_item');
      expect(tool.inputSchema.required).toEqual(['id']);
      expect(Object.keys(tool.inputSchema.properties)).toEqual(['id']);
      expect(tool.description).toContain('dismissed');
      expect(tool.description).toContain('restore_item brings it back');
    });

    it('lists restore_item with an id, saying that it brings back what delete_item dismissed', () => {
      const tool = restoreItemTool();

      expect(tool.name).toBe('restore_item');
      expect(tool.inputSchema.required).toEqual(['id']);
      expect(Object.keys(tool.inputSchema.properties)).toEqual(['id']);
      expect(tool.description).toContain('delete_item dismissed');
    });

    it('tells the model in the server instructions to use delete_item to delete or remove, and restore_item to undo it', () => {
      expect(SERVER_INSTRUCTIONS).toContain('Use delete_item when the user asks to delete or remove something in Cockpit');
      expect(SERVER_INSTRUCTIONS).toContain('restore_item to undo it');
    });
  });
});
