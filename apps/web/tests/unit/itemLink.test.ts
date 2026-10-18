import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyItemLink, itemLink, itemLinkAsHtml } from '../../src/itemLink';
import { aClipboard } from './support/clipboard';

/**
 * L1, and pure: the link and the titled anchor built from it ("Copy an Item's
 * link from its menu and its form", issue 1247). That the row's menu and the
 * form hand it the right Item is tests/unit/components/ItemRow.test.tsx's and
 * ItemForm.test.tsx's.
 */
describe('Item editing', () => {
  describe('a title is written into the copied link as it was written', () => {
    it.each([
      { situation: 'a plain title', title: 'Part 11', html: '<a href="L">Part 11</a>' },
      { situation: 'angle brackets', title: 'Fix <b>bold</b>', html: '<a href="L">Fix &lt;b&gt;bold&lt;/b&gt;</a>' },
      { situation: 'an ampersand', title: 'Q&A with Els', html: '<a href="L">Q&amp;A with Els</a>' },
      {
        situation: 'quotes',
        title: `Say "hi" to Bart's team`,
        html: '<a href="L">Say &quot;hi&quot; to Bart&#39;s team</a>',
      },
    ])('$situation', ({ title, html }) => {
      expect(itemLinkAsHtml('L', title)).toBe(html);
    });

    it('an address with an ampersand does not break out of the anchor', () => {
      expect(itemLinkAsHtml('https://x/?a=1&b=2', 't')).toBe('<a href="https://x/?a=1&amp;b=2">t</a>');
    });
  });

  describe('the link names the Item’s workspace and the Item, on the page’s own origin', () => {
    it('is the workspace address with the Item open', () => {
      expect(itemLink('https://cockpit.example', 'ws-work', 'abc-123')).toBe(
        'https://cockpit.example/w/ws-work?item=abc-123',
      );
    });
  });
});

const anItem = (title: string) => ({ id: 'item-1', title, nextAction: null });

describe('Item editing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('copying a link puts it on the clipboard as a URL and as a link titled with the Item', () => {
    it('writes both in one go', async () => {
      const { written } = aClipboard();

      const copied = await copyItemLink('ws-work', anItem('Part <11>'));

      const link = `${window.location.origin}/w/ws-work?item=item-1`;
      expect(copied).toBe(true);
      expect(written).toEqual([{ 'text/plain': link, 'text/html': `<a href="${link}">Part &lt;11&gt;</a>` }]);
    });

    it('titles an untitled Item the way its row names it, so the pasted link has something to click', async () => {
      const { written } = aClipboard();

      await copyItemLink('ws-work', anItem(''));

      expect(written[0]?.['text/html']).toMatch(/>Untitled<\/a>$/);
    });

    it('writes the plain address alone in a browser with no ClipboardItem', async () => {
      const { written, plain } = aClipboard({ withClipboardItem: false });

      const copied = await copyItemLink('ws-work', anItem('Part 11'));

      expect(copied).toBe(true);
      expect(written).toEqual([]);
      expect(plain).toEqual([`${window.location.origin}/w/ws-work?item=item-1`]);
    });

    it('says it did not copy where the browser refuses', async () => {
      aClipboard({ refuses: true });

      expect(await copyItemLink('ws-work', anItem('Part 11'))).toBe(false);
    });
  });
});
