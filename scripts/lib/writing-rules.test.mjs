//
// Two halves, and both are needed. The first proves each rule can tell a
// violation from the shape that merely looks like one, against text written
// here - which is the half that stops the check being narrowed into silence.
// The second runs them over the repository's own prose, which is the half that
// gates, and the half that calibrated every rule above: each citation it went
// red on is fixed in the tree, and each correct paragraph it went red on -
// wrapped prose, a bold phrase spanning two lines, a skill restating its own
// version of record - is a case below.
//

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  duplicateParagraphs,
  issueNumbersWithoutTitles,
  linesAdded,
  markdownFiles,
  nativePath,
  numberWords,
  prose,
  unbalancedEmphasis,
  unresolvedSectionCitations,
} from './writing-rules.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** The repository's prose, read once for the half that gates. */
const documents = markdownFiles(root).map((file) => ({
  file,
  source: readFileSync(nativePath(root, file), 'utf8'),
}));

const at = (file, { line }) => `${file}:${line}`;

describe('markdownFiles', () => {
  it('never enters a linked worktree, which is a whole second checkout inside this one', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'writing-rules-'));
    try {
      for (const [path, name] of [
        ['docs', 'own.md'],
        ['.claude/worktrees/branch/docs', 'somebody-elses.md'],
        ['node_modules/a-package', 'readme.md'],
        ['poc/spike', 'report.md'],
      ]) {
        mkdirSync(join(fixture, ...path.split('/')), { recursive: true });
        writeFileSync(join(fixture, ...path.split('/'), name), 'Prose.\n');
      }
      assert.deepEqual(markdownFiles(fixture), ['docs/own.md']);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe('linesAdded', () => {
  it('reads the lines a hunk adds, counted or not', () => {
    const diff = [
      'diff --git a/one.md b/one.md',
      '--- a/one.md',
      '+++ b/one.md',
      '@@ -3 +3 @@',
      '+changed',
      '@@ -20,0 +21,2 @@',
      '+added',
      '+added',
    ].join('\n');
    assert.deepEqual([...linesAdded(diff)], [['one.md', new Set([3, 21, 22])]]);
  });

  it('adds nothing for a hunk that only deletes', () => {
    const diff = ['--- a/one.md', '+++ b/one.md', '@@ -7,2 +6,0 @@', '-gone', '-gone'].join('\n');
    assert.deepEqual([...linesAdded(diff)], [['one.md', new Set()]]);
  });

  it('keeps each file to its own lines', () => {
    const diff = ['+++ b/one.md', '@@ -1 +1 @@', '+++ b/two.md', '@@ -9 +9 @@'].join('\n');
    assert.deepEqual([...linesAdded(diff)], [
      ['one.md', new Set([1])],
      ['two.md', new Set([9])],
    ]);
  });
});

describe('prose', () => {
  it('blanks fenced code, so an instruction is not read as a citation', () => {
    const source = ['Text.', '', '```bash', 'gh issue view 278', '```', '', 'More **text**.'].join('\n');
    assert.deepEqual(prose(source).filter(Boolean), ['Text.', 'More **text**.']);
  });

  it('blanks a fence indented into a list item, which is where samples sit', () => {
    const source = ['- A step:', '', '     ```bash', '     gh issue view 276', '     ```', '', 'After.'].join('\n');
    assert.deepEqual(prose(source).filter(Boolean), ['- A step:', 'After.']);
  });

  it('blanks inline code but keeps the line, so a violation can still name it', () => {
    const line = 'a `**glob**` b';
    assert.deepEqual(prose(line), [`a ${' '.repeat('`**glob**`'.length)} b`]);
    assert.equal(prose(line)[0].length, line.length);
  });
});

describe('issueNumbersWithoutTitles', () => {
  it('catches a bare issue number', () => {
    const found = issueNumbersWithoutTitles('The fix landed under issue 77, hours earlier.');
    assert.deepEqual(found, [{ line: 1, number: '77', text: 'The fix landed under issue 77, hours earlier.' }]);
  });

  it('leaves an issue number with its title before it alone', () => {
    assert.deepEqual(issueNumbersWithoutTitles('"Rename and delete a workspace" (issue 77) merged first.'), []);
  });

  it('leaves a title wrapped across two lines alone, because half these documents wrap', () => {
    const source = ['"Add a user on the admin page, so a second person no', 'longer needs SQL" (issue 231) is where this started.'].join('\n');
    assert.deepEqual(issueNumbersWithoutTitles(source), []);
  });

  it('leaves a number already named in this file alone where it comes back', () => {
    const source = ['"Panels hold the items filed into them" (issue 36) worked this out.', '', 'Issue 36 produced this surface, among others.'].join('\n');
    assert.deepEqual(issueNumbersWithoutTitles(source), []);
  });

  it('catches a second, untitled number in a new paragraph', () => {
    const source = ['"Rename and delete a workspace" (issue 77).', '', 'See also pull request 97.'].join('\n');
    assert.deepEqual(issueNumbersWithoutTitles(source).map(({ line, number }) => ({ line, number })), [{ line: 3, number: '97' }]);
  });

  it('leaves a bare #14 alone, because that is an open decision as often as an issue', () => {
    assert.deepEqual(issueNumbersWithoutTitles('What drives that is undecided - open decision #14 (§12).'), []);
  });

  it('does not let a named pull request name the issue of the same number', () => {
    const source = ['"Rename and delete a workspace" (pull request 77) merged.', '', 'Separately, issue 77 is open.'].join('\n');
    assert.deepEqual(issueNumbersWithoutTitles(source).map(({ line, number }) => ({ line, number })), [{ line: 3, number: '77' }]);
  });

  it("reads each bullet on its own, so one item's title does not cover the next", () => {
    const source = ['- "Rename and delete a workspace" (issue 77) landed.', '- A later item cites issue 99 bare.'].join('\n');
    assert.deepEqual(issueNumbersWithoutTitles(source).map(({ line, number }) => ({ line, number })), [{ line: 2, number: '99' }]);
  });
});

describe('unresolvedSectionCitations', () => {
  it('catches a rule number with no numbered list in the file to resolve against', () => {
    const found = unresolvedSectionCitations('Prose, and then rule 2 says otherwise.');
    assert.deepEqual(found, [{ line: 1, citation: 'rule 2', text: 'Prose, and then rule 2 says otherwise.' }]);
  });

  it('catches a section sign the same way', () => {
    assert.deepEqual(unresolvedSectionCitations('The write path (§4.2) is documented.').map(({ citation }) => citation), ['§4.2']);
  });

  it('leaves a citation alone where the file offers that number', () => {
    const source = ['1. First.', '2. Second.', '', 'As rule 2 says.'].join('\n');
    assert.deepEqual(unresolvedSectionCitations(source), []);
  });

  it('counts a numbered heading as one of those numbers', () => {
    assert.deepEqual(unresolvedSectionCitations(['## 4.2 Data layer', '', 'Per §4.2.'].join('\n')), []);
  });

  it('does not let an ordinary numbered list resolve a section sign', () => {
    const source = ['1. First.', '2. Second.', '', 'As §2 says.'].join('\n');
    assert.deepEqual(unresolvedSectionCitations(source).map(({ citation }) => citation), ['§2']);
  });

  it('catches a number past the end of the list it points into', () => {
    const source = ['## 8. Enforcement', '', 'Per §9.1.'].join('\n');
    assert.deepEqual(unresolvedSectionCitations(source).map(({ citation }) => citation), ['§9.1']);
  });
});

describe('unbalancedEmphasis', () => {
  it('catches an unclosed marker', () => {
    assert.deepEqual(unbalancedEmphasis('**Say it once, in as few sentences as it takes.'), [
      { line: 1, text: '**Say it once, in as few sentences as it takes.' },
    ]);
  });

  it('catches a malformed run of them', () => {
    assert.deepEqual(unbalancedEmphasis('The ****rule**** is this.').map(({ line }) => line), [1]);
  });

  it('leaves a bold phrase wrapped across two lines alone', () => {
    assert.deepEqual(unbalancedEmphasis(['**Merging deploys to staging; production is a', 'separate, deliberate promotion.**'].join('\n')), []);
  });

  it('names the paragraph a marker went unclosed in, not the whole run of them', () => {
    const source = ['Fine **here**.', '', '**Not closed here.', '', 'Fine **again**.'].join('\n');
    assert.deepEqual(unbalancedEmphasis(source).map(({ line }) => line), [3]);
  });

  it('reads each bullet on its own, so one cannot cancel the next', () => {
    const source = ['- **First** one.', '- **Second one.', '- **Third** one.'].join('\n');
    assert.deepEqual(unbalancedEmphasis(source).map(({ line }) => line), [2]);
  });

  it('leaves a bold phrase wrapped across two quoted lines alone', () => {
    const source = ['> **Merging deploys to staging; production is a', '> separate, deliberate promotion.**'].join('\n');
    assert.deepEqual(unbalancedEmphasis(source), []);
  });

  it('still reads each table row on its own, which does not wrap', () => {
    const source = ['| **First** | one |', '| **Second | two |', '| **Third** | three |'].join('\n');
    assert.deepEqual(unbalancedEmphasis(source).map(({ line }) => line), [2]);
  });

  it('leaves a bold-italic run alone', () => {
    assert.deepEqual(unbalancedEmphasis('It is ***emphatically*** so.'), []);
  });
});

describe('duplicateParagraphs', () => {
  const paragraph =
    'A finding is not handled until its own review thread says so, because GitHub never resolves one by itself and a push only adds an outdated badge.';

  it('catches the same paragraph in two files, naming both', () => {
    const found = duplicateParagraphs([
      { file: 'one.md', source: `Opening line.\n\n${paragraph}` },
      { file: 'two.md', source: paragraph },
    ]);
    assert.deepEqual(found, [{ places: [{ file: 'one.md', line: 3 }, { file: 'two.md', line: 1 }] }]);
  });

  it('catches a near-verbatim restatement, not only a copy', () => {
    const reworded = paragraph.replace('a push only adds', 'a push merely adds');
    const found = duplicateParagraphs([
      { file: 'one.md', source: paragraph },
      { file: 'two.md', source: reworded },
    ]);
    assert.equal(found.length, 1);
  });

  it('leaves a paragraph quoted with attribution alone', () => {
    const found = duplicateParagraphs([
      { file: 'one.md', source: paragraph },
      { file: 'two.md', source: `CLAUDE.md puts it this way:\n\n> ${paragraph}` },
    ]);
    assert.deepEqual(found, []);
  });

  it('leaves a restatement alone where the file names the other as its version of record', () => {
    const found = duplicateParagraphs([
      { file: 'skill.md', source: `This file is complete on its own; strategy.md is the version of record.\n\n${paragraph}` },
      { file: 'strategy.md', source: paragraph },
    ]);
    assert.deepEqual(found, []);
  });

  it("leaves a wrapped list item alone, tail included", () => {
    const item = [
      '- **Browser is its own column, not part of Frontend.** A component test and a browser',
      '  test answer different questions, and the browser one is the only test the strategy',
      '  makes mandatory per capability, so a zero there is the strongest signal on the page.',
    ].join('\n');
    const found = duplicateParagraphs([
      { file: 'one.md', source: item },
      { file: 'two.md', source: item },
    ]);
    assert.deepEqual(found, []);
  });

  it('does not let a declaration by a shared filename exempt a file in another directory', () => {
    const found = duplicateParagraphs([
      { file: 'one/SKILL.md', source: `This file restates it; SKILL.md is the version of record.\n\n${paragraph}` },
      { file: 'two/SKILL.md', source: paragraph },
      { file: 'three/SKILL.md', source: 'Unrelated.' },
    ]);
    assert.equal(found.length, 1);
  });

  it('honours a declaration that names the path, where the filename is shared', () => {
    const found = duplicateParagraphs([
      { file: 'one/SKILL.md', source: `two/SKILL.md is the version of record.\n\n${paragraph}` },
      { file: 'two/SKILL.md', source: paragraph },
      { file: 'three/SKILL.md', source: 'Unrelated.' },
    ]);
    assert.deepEqual(found, []);
  });

  it('leaves two short lines saying the same thing alone', () => {
    const found = duplicateParagraphs([
      { file: 'one.md', source: 'Say it once.' },
      { file: 'two.md', source: 'Say it once.' },
    ]);
    assert.deepEqual(found, []);
  });
});

describe('numberWords', () => {
  it('finds the counting words a stale claim hides behind', () => {
    assert.deepEqual(numberWords('Nine areas, three of them new, and both are covered.').map(({ word }) => word), [
      'Nine',
      'three',
      'both',
    ]);
  });

  it('leaves a word that merely contains one alone', () => {
    assert.deepEqual(numberWords('Someone atoned for the bothersome nineties.'), []);
  });
});

describe("the repository's prose", () => {
  it('names an issue before giving its number', () => {
    const offences = documents.flatMap(({ file, source }) =>
      issueNumbersWithoutTitles(source).map((found) => `${at(file, found)}  ${found.text}`),
    );
    assert.deepEqual(offences, [], `name the issue or pull request before its number:\n  ${offences.join('\n  ')}`);
  });

  it('cites a section by its name, never by a number with nothing to resolve against', () => {
    const offences = documents.flatMap(({ file, source }) =>
      unresolvedSectionCitations(source).map((found) => `${at(file, found)}  ${found.citation}`),
    );
    assert.deepEqual(
      offences,
      [],
      `nothing in this file carries that number - cite the section by its name instead:\n  ${offences.join('\n  ')}`,
    );
  });

  it('closes every emphasis marker it opens', () => {
    const offences = documents.flatMap(({ file, source }) =>
      unbalancedEmphasis(source).map((found) => `${at(file, found)}  ${found.text}`),
    );
    assert.deepEqual(offences, [], `unbalanced or malformed \`**\`:\n  ${offences.join('\n  ')}`);
  });

  it('says it in one place', () => {
    const offences = duplicateParagraphs(documents).map(({ places }) => places.map((place) => at(place.file, place)).join('  ==  '));
    assert.deepEqual(
      offences,
      [],
      'the same paragraph twice - say it once, or name the other file as this one\'s version of record:\n  ' + offences.join('\n  '),
    );
  });

  // Reported, never failed: whether "nine areas" is still nine is a fact about
  // the product, and a check that cries wolf is a check that gets skipped. On
  // the changed lines only, because the whole tree carries fourteen hundred of
  // these and a list that long is not read. Where git cannot answer - the
  // Scripts job checks out one commit deep - there is nothing to report.
  it('reports the counting words on the lines this change touches', () => {
    const changed = changedMarkdownLines();
    if (!changed) {
      console.log('  counting words: no merge base to compare against, so nothing to report.');
      return;
    }
    const stale = documents.flatMap(({ file, source }) => {
      const lines = new Map();
      for (const found of numberWords(source)) {
        if (!changed.get(file)?.has(found.line)) continue;
        const seen = lines.get(found.line) ?? { words: new Set(), text: found.text.replace(/\s+/g, ' ') };
        seen.words.add(found.word.toLowerCase());
        lines.set(found.line, seen);
      }
      // One line per line, not one per word: `readme.md:188` carries "one"
      // four times, and four identical entries is how a report stops being read.
      return [...lines].map(([line, { words, text }]) => `${at(file, { line })}  ${[...words].join(', ')}  ${text.slice(0, 110)}`);
    });
    console.log(
      stale.length
        ? `  counting words on changed lines - check each is still true:\n    ${stale.join('\n    ')}`
        : '  counting words: none on the changed lines.',
    );
  });
});

/**
 * The Markdown lines this branch has touched, as `file -> line numbers`.
 *
 * Against the merge base and including the working tree, so the report is about
 * the change being written rather than the change already committed - which is
 * the moment a stale count is still cheap to fix.
 */
function changedMarkdownLines() {
  for (const against of ['origin/main', 'main']) {
    const diff = spawnSync('git', ['diff', '--unified=0', '--merge-base', against, '--', '*.md'], { cwd: root, encoding: 'utf8' });
    if (diff.status === 0) return linesAdded(diff.stdout);
  }
  return null;
}
