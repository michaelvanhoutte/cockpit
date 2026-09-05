import { describe, expect, it } from 'vitest';
import { Editor, defaultValueCtx, rootCtx } from '@milkdown/core';
import { getMarkdown } from '@milkdown/utils';
import { descriptionSyntax } from '../../../src/description/syntax';

/**
 * F1: what a description survives being opened and closed again.
 *
 * The editor parses Markdown into a document and prints that document back, so
 * anything its syntax does not know is gone at the moment the form opens -
 * which is why `descriptionSyntax` is wider than the toolbar, and why this is
 * the test that rule exists for.
 *
 * Below the browser, because parsing and printing needs a document and no
 * geometry: nothing here touches a caret, a selection or a toolbar. Those are
 * F3 walks in tests/e2e/item-editing.test.ts.
 */

/** A description written, opened in the form, and read back out. */
async function writtenAndReadBack(markdown: string): Promise<string> {
  const root = document.createElement('div');
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(descriptionSyntax)
    .create();
  const read = editor.action(getMarkdown());
  await editor.destroy();
  root.remove();
  return read;
}

const aTable = `| Stage | Owner |\n| --- | --- |\n| Draft | Ana |`;

describe('Item editing', () => {
  describe('a description comes back as it was written', () => {
    /**
     * `kept` is exact, including the places the text is tidied rather than
     * preserved: bullet markers unify on `*`, a table's columns are padded, a
     * rule becomes `***`. Written out rather than compared loosely, because a
     * loose comparison is what would let a dropped table through.
     */
    it.each([
      { situation: 'bold, italic and a link', written: 'A **bold** *word*, and a [link](https://example.com/a).', kept: 'A **bold** *word*, and a [link](https://example.com/a).\n' },
      { situation: 'a bullet list', written: '- milk\n- bread', kept: '* milk\n* bread\n' },
      { situation: 'a numbered list', written: '1. first\n2. second', kept: '1. first\n2. second\n' },
      { situation: 'a nested list', written: '- release\n  - tag it\n  - announce', kept: '* release\n  * tag it\n  * announce\n' },
      { situation: 'a heading, though no button makes one', written: '# Weekly review\n\nWhat happened.', kept: '# Weekly review\n\nWhat happened.\n' },
      { situation: 'a table, though no button makes one', written: aTable, kept: '| Stage | Owner |\n| ----- | ----- |\n| Draft | Ana   |\n' },
      { situation: 'an image, though no button makes one', written: '![the panel](https://example.com/p.png)', kept: '![the panel](https://example.com/p.png)\n' },
      { situation: 'a code block, though no button makes one', written: 'Run it:\n\n```bash\npnpm dev\n```', kept: 'Run it:\n\n```bash\npnpm dev\n```\n' },
      { situation: 'strikethrough, though no button makes one', written: 'Ship on ~~Tuesday~~ Thursday.', kept: 'Ship on ~~Tuesday~~ Thursday.\n' },
      { situation: 'a task list', written: '- [ ] draft it\n- [x] read it', kept: '* [ ] draft it\n* [x] read it\n' },
      { situation: 'a blockquote', written: '> They said it was fine.', kept: '> They said it was fine.\n' },
      { situation: 'nothing at all', written: '', kept: '' },
    ])('$situation', async ({ written, kept }) => {
      expect(await writtenAndReadBack(written)).toBe(kept);
    });

    // The cap on a description (apps/web/src/components/ItemForm.tsx), so the
    // longest one that can be stored is the longest one that has to survive.
    it('sixty thousand characters', async () => {
      const long = Array.from({ length: 500 }, (_, index) => `Paragraph ${index} with **bold**.`).join('\n\n');
      expect(long.length).toBeGreaterThan(10_000);

      expect(await writtenAndReadBack(long)).toBe(`${long}\n`);
    });

    /**
     * The one that decides the whole shape: a mail-client paste, where the
     * table is the third thing down and nothing about it looks special. It has
     * to arrive as a table rather than as three lines that happen to contain
     * pipes - a paragraph of pipes cannot be edited, does not read as a table,
     * and is one keystroke away from being escaped into nonsense.
     */
    it('a paste where the table is only part of it', async () => {
      const pasted = `## Handover\n\n1. The key rotates on Friday.\n\n${aTable}\n\nAsk Ana if this is wrong.`;
      const root = document.createElement('div');
      document.body.append(root);

      const editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, pasted);
        })
        .use(descriptionSyntax)
        .create();

      expect(root.querySelector('table')?.textContent).toContain('Ana');
      const read = editor.action(getMarkdown());
      expect(read).toContain('| Draft | Ana');
      expect(read).toContain('## Handover');
      expect(read).toContain('Ask Ana if this is wrong.');

      await editor.destroy();
      root.remove();
    });

    /**
     * Switching between the two views repeatedly must not keep moving the text.
     * The first pass tidies; every pass after it has to be a no-op, or the
     * description drifts a little further each time the form is opened.
     */
    it.each([
      { situation: 'a list, which is tidied on the way through', written: '- milk\n+ bread' },
      { situation: 'a table, which is padded on the way through', written: aTable },
      { situation: 'a rule, which changes marker', written: 'Above\n\n---\n\nBelow' },
    ])('$situation settles after one pass', async ({ written }) => {
      const once = await writtenAndReadBack(written);

      expect(await writtenAndReadBack(once)).toBe(once);
    });
  });

  describe('nothing written in a description becomes markup', () => {
    /**
     * A description will carry text a connector pulled out of Gmail, Slack or
     * Notion (architecture, "Security"), so the question is not what someone
     * types into their own form - it is what arrives in one.
     *
     * Kept as text rather than deleted: the syntax's `html` node prints the
     * source back out, so a paste that happens to contain a tag is still all
     * there. Deleting it would be safe and would also lose the sentence around
     * it.
     */
    it.each([
      { situation: 'a script tag', written: '<script>alert(1)</script>' },
      { situation: 'an image with a handler on it', written: '<img src=x onerror=alert(1)>' },
      { situation: 'a bare bold tag', written: 'a <b>bold</b> word' },
      { situation: 'an iframe', written: '<iframe src="https://example.com"></iframe>' },
    ])('$situation is text, and is still there', async ({ written }) => {
      const root = document.createElement('div');
      document.body.append(root);
      const editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, written);
        })
        .use(descriptionSyntax)
        .create();

      // Nothing of it was made into an element, and all of it reads as text.
      // `img[src]` rather than `img`: ProseMirror puts a source-less one of its
      // own at the end of an empty text block, which is its cursor and not this
      // description's content.
      expect(root.querySelector('script, iframe, b, [onerror], img[src]')).toBeNull();
      expect(root.textContent).toContain(written);
      expect(editor.action(getMarkdown()).trim()).toBe(written);

      await editor.destroy();
      root.remove();
    });
  });
});
