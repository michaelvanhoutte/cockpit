/**
 * Twenty descriptions of the kind an Item actually carries: things typed into
 * the box, and things pasted into it out of Notion, Slack and a mail client.
 * The spike round-trips each one and diffs the output against the input.
 */
export interface Sample {
  name: string;
  markdown: string;
}

const notionTable = `| Stage | Owner | Due |
| --- | --- | --- |
| Draft | Ana | Fri |
| Review | Ben | Mon |
| Ship | Cara | Wed |`;

export const samples: Sample[] = [
  { name: 'the first formatting set', markdown: 'A **bold** word, an *italic* one, a [link](https://example.com/a) and plain text.' },
  { name: 'a bullet list', markdown: '- milk\n- bread\n- eggs' },
  { name: 'a numbered list', markdown: '1. open the form\n2. type a description\n3. press Save' },
  { name: 'a nested list', markdown: '- release\n  - tag it\n  - write the notes\n- announce' },
  { name: 'a heading', markdown: '# Weekly review\n\nWhat happened.' },
  { name: 'a table pasted out of Notion', markdown: notionTable },
  { name: 'an image', markdown: 'Before\n\n![the failing panel](https://example.com/panel.png)\n\nAfter' },
  { name: 'a fenced code block', markdown: 'Run it:\n\n```bash\npnpm dev\n```' },
  { name: 'strikethrough', markdown: 'Ship on ~~Tuesday~~ Thursday.' },
  { name: 'a blockquote', markdown: '> They said it was fine.\n\nIt was not.' },
  { name: 'a task list', markdown: '- [ ] draft the issue\n- [x] read the options doc' },
  { name: 'inline code', markdown: 'Call `whatChanged(was, now)` first.' },
  { name: 'a mail-client paste, mixed', markdown: `## Handover\n\nThree things:\n\n1. The **staging** key rotates on Friday — see [the runbook](https://example.com/runbook).\n2. Panels:\n\n${notionTable}\n\n3. \`pnpm dev\` still needs Node 22.\n\n> Ask Ana if any of this is wrong.` },
  { name: 'a horizontal rule', markdown: 'Above\n\n---\n\nBelow' },
  { name: 'a hard line break', markdown: 'first line  \nsecond line' },
  { name: 'an autolink', markdown: 'See <https://example.com/deep/link?a=1&b=2>.' },
  { name: 'characters Markdown would otherwise eat', markdown: 'Costs 50% \* 2, uses `a_b_c`, and a literal \_underscore\_.' },
  { name: 'a bare angle bracket', markdown: 'Compare a < b and b > a.' },
  { name: 'nothing at all', markdown: '' },
  {
    name: 'sixty thousand characters',
    markdown: Array.from(
      { length: 500 },
      (_, index) => `${index + 1}. Paragraph ${index + 1} with **bold** and a [link](https://example.com/${index}).`,
    ).join('\n'),
  },
];
