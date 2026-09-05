import { describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { samples } from './src/samples';

/**
 * Round-tripping twice must not move the text again. "Switch twice without
 * typing, and the description is unchanged" is a stated rule of issue 160, and
 * a serializer that re-escapes its own output fails it silently.
 */
async function milkdownRun() {
  const { Editor, rootCtx, defaultValueCtx } = await import('@milkdown/core');
  const { commonmark } = await import('@milkdown/preset-commonmark');
  const { gfm } = await import('@milkdown/preset-gfm');
  const { getMarkdown } = await import('@milkdown/utils');
  return async (markdown: string) => {
    const root = document.createElement('div');
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
      })
      .use(commonmark)
      .use(gfm)
      .create();
    const out = editor.action(getMarkdown());
    await editor.destroy();
    root.remove();
    return out;
  };
}

async function tiptapRun() {
  const { Editor } = await import('@tiptap/core');
  const StarterKit = (await import('@tiptap/starter-kit')).default;
  const { Markdown } = await import('@tiptap/markdown');
  const { TableKit } = await import('@tiptap/extension-table');
  const Image = (await import('@tiptap/extension-image')).default;
  return async (markdown: string) => {
    const element = document.createElement('div');
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit, Markdown, Image, TableKit],
      content: markdown,
      contentType: 'markdown',
    });
    const out = editor.getMarkdown();
    editor.destroy();
    element.remove();
    return out;
  };
}

describe('idempotence', () => {
  it('says whether a second round-trip moves the text again', async () => {
    const report: string[] = [];
    for (const [name, make] of [['milkdown-gfm', milkdownRun], ['tiptap-tables', tiptapRun]] as const) {
      const run = await make();
      report.push(`\n## ${name}\n`);
      for (const sample of samples) {
        const once = await run(sample.markdown);
        const twice = await run(once);
        const thrice = await run(twice);
        const settled = once === twice && twice === thrice;
        report.push(`### ${sample.name}: ${settled ? 'settles after one pass' : 'KEEPS MOVING'}`);
        if (!settled) {
          report.push('```\n1: ' + JSON.stringify(once.slice(0, 200)));
          report.push('2: ' + JSON.stringify(twice.slice(0, 200)));
          report.push('3: ' + JSON.stringify(thrice.slice(0, 200)) + '\n```');
        }
      }
    }
    writeFileSync('idempotence-report.md', report.join('\n'), 'utf8');
  });
});
