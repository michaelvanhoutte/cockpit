import { describe, expect, it } from 'vitest';
import { itemLink } from '../../../src/index.js';

/**
 * L1: the link to an Item, which the browser copies ("Copy an Item's link from
 * its menu and its form", issue 1247) and the MCP tools hand to an app. That the
 * row's menu and the form copy it is apps/web/tests/unit/itemLink.test.ts's and
 * the components' tests; that create_item and find_items give it is
 * apps/api/tests/integration/http.
 */
describe('Item editing', () => {
  describe('the link names the Item’s workspace and the Item, on the page’s own origin', () => {
    it('is the workspace address with the Item open', () => {
      expect(itemLink('https://cockpit.example', 'ws-work', 'abc-123')).toBe(
        'https://cockpit.example/w/ws-work?item=abc-123',
      );
    });

    it('writes a workspace or Item id into the address as it is written', () => {
      expect(itemLink('https://cockpit.example', 'ws work/1', 'a&b')).toBe(
        'https://cockpit.example/w/ws%20work%2F1?item=a%26b',
      );
    });
  });
});
