import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';

/**
 * What each candidate does with raw HTML in a description, with and without
 * the CommonMark preset's `html` node removed. Issue 160 requires markup to
 * come back as text.
 */
const dangerous = [
  ['a script tag', '<script>alert(1)</script>'],
  ['an image with a handler', '<img src=x onerror=alert(1)>'],
  ['a bare bold tag', 'a <b>bold</b> word'],
  ['a javascript link', '[click](javascript:alert(1))'],
  ['a data link', '[click](data:text/html,<script>alert(1)</script>)'],
  ['a vbscript link', '[click](vbscript:msgbox(1))'],
  ['a mailto link', '[mail](mailto:a@example.com)'],
  ['an http link', '[plain](http://example.com)'],
] as const;

describe('raw html and link schemes', () => {
  it('records what each candidate keeps', async () => {
    const { Editor, rootCtx, defaultValueCtx, editorViewCtx } = await import('@milkdown/core');
    const { commonmark, htmlSchema } = await import('@milkdown/preset-commonmark');
    const { gfm } = await import('@milkdown/preset-gfm');
    const { getMarkdown } = await import('@milkdown/utils');

    const report: string[] = ['# raw html and link schemes\n'];

    const milkdown = async (markdown: string, withoutHtml: boolean) => {
      const root = document.createElement('div');
      document.body.append(root);
      const plugins = withoutHtml
        ? commonmark.filter((plugin) => !htmlSchema.every((entry) => plugin === entry))
        : commonmark;
      const editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, markdown);
        })
        .use(plugins)
        .use(gfm)
        .create();
      const md = editor.action(getMarkdown());
      const html = editor.action((ctx) => ctx.get(editorViewCtx).dom.innerHTML);
      await editor.destroy();
      root.remove();
      return { md, html };
    };

    report.push('\n## Milkdown (commonmark + gfm, html node left in)\n');
    for (const [name, markdown] of dangerous) {
      const { md, html } = await milkdown(markdown, false);
      report.push(`- **${name}** — markdown: ${JSON.stringify(md)}; dom: ${JSON.stringify(html)}`);
    }

    writeFileSync('html-report.md', report.join('\n'), 'utf8');
  });
});
