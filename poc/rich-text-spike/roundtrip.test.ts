import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { samples } from './src/samples';

/** Round-trip a description through one candidate, and say what came back. */
type RoundTrip = (markdown: string) => Promise<string>;

async function milkdown(withGfm: boolean): Promise<RoundTrip> {
  const { Editor, rootCtx, defaultValueCtx } = await import('@milkdown/core');
  const { commonmark } = await import('@milkdown/preset-commonmark');
  const { gfm } = await import('@milkdown/preset-gfm');
  const { getMarkdown } = await import('@milkdown/utils');
  return async (markdown) => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
      })
      .use(commonmark)
      .use(withGfm ? gfm : [])
      .create();
    const out = editor.action(getMarkdown());
    await editor.destroy();
    root.remove();
    return out;
  };
}

async function tiptap(withTables: boolean): Promise<RoundTrip> {
  const { Editor } = await import('@tiptap/core');
  const StarterKit = (await import('@tiptap/starter-kit')).default;
  const { Markdown } = await import('@tiptap/markdown');
  const { TableKit } = await import('@tiptap/extension-table');
  const Image = (await import('@tiptap/extension-image')).default;
  return async (markdown) => {
    const element = document.createElement('div');
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit, Markdown, Image, ...(withTables ? [TableKit] : [])],
      content: markdown,
      contentType: 'markdown',
    });
    const out = editor.getMarkdown();
    editor.destroy();
    element.remove();
    return out;
  };
}

/** The words that survived, ignoring every syntax character. */
const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' ');

describe('round-trip', () => {
  it('reports what each candidate hands back', async () => {
    const candidates: Array<[string, RoundTrip]> = [
      ['milkdown-commonmark', await milkdown(false)],
      ['milkdown-gfm', await milkdown(true)],
      ['tiptap-starter', await tiptap(false)],
      ['tiptap-tables', await tiptap(true)],
    ];
    const report: string[] = [];
    for (const [name, run] of candidates) {
      report.push(`\n\n## ${name}\n`);
      for (const sample of samples) {
        let out: string;
        try {
          out = await run(sample.markdown);
        } catch (failure) {
          report.push(`### ${sample.name}: THREW — ${(failure as Error).message}\n`);
          continue;
        }
        const identical = out.trim() === sample.markdown.trim();
        const kept = words(out) === words(sample.markdown);
        const verdict = identical ? 'identical' : kept ? 'normalised' : 'LOST CONTENT';
        report.push(`### ${sample.name}: ${verdict}`);
        if (!identical) {
          report.push('```\nIN : ' + JSON.stringify(sample.markdown.slice(0, 400)));
          report.push('OUT: ' + JSON.stringify(out.slice(0, 400)) + '\n```');
        }
        report.push('');
      }
    }
    writeFileSync('roundtrip-report.md', report.join('\n'), 'utf8');
  });
});
