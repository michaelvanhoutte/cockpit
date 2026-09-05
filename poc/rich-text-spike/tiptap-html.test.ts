import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';

const dangerous = [
  ['a script tag', '<script>alert(1)</script>'],
  ['an image with a handler', '<img src=x onerror=alert(1)>'],
  ['a bare bold tag', 'a <b>bold</b> word'],
  ['a javascript link', '[click](javascript:alert(1))'],
  ['a data link', '[click](data:text/html,hi)'],
  ['a vbscript link', '[click](vbscript:msgbox(1))'],
  ['a mailto link', '[mail](mailto:a@example.com)'],
  ['an http link', '[plain](http://example.com)'],
] as const;

describe('tiptap raw html and link schemes', () => {
  it('records what it keeps', async () => {
    const { Editor } = await import('@tiptap/core');
    const StarterKit = (await import('@tiptap/starter-kit')).default;
    const { Markdown } = await import('@tiptap/markdown');
    const report: string[] = ['# tiptap\n'];
    for (const [name, markdown] of dangerous) {
      const element = document.createElement('div');
      document.body.append(element);
      const editor = new Editor({
        element,
        extensions: [StarterKit, Markdown],
        content: markdown,
        contentType: 'markdown',
      });
      report.push(
        `- **${name}** — markdown: ${JSON.stringify(editor.getMarkdown())}; dom: ${JSON.stringify(editor.view.dom.innerHTML)}`,
      );
      editor.destroy();
      element.remove();
    }
    writeFileSync('tiptap-html-report.md', report.join('\n'), 'utf8');
  });
});
