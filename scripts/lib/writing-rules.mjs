//
// The writing rules of CLAUDE.md that a script can decide, as something that
// fails.
//
// Of 106 review threads sampled across 25 recent pull requests, roughly 40%
// were about prose rather than logic - a bare issue number, a `rule 2`
// resolving to no list, a paragraph restating one in the document of record, an
// unbalanced `**`. "Say where the backup token comes from, and why it is set
// twice" (pull request 226) changed thirty lines and drew fifteen threads,
// thirteen of that kind, and the same stale finding landed on two pull
// requests in a row. Every one of them breaks a rule CLAUDE.md already
// states, at eleven to sixteen minutes a review round, which is the repository's
// own argument for a script: `constraints.test.ts` for the schema conventions,
// `check-concepts` for the feature areas, `e2e-conventions.mjs` for the walks.
//
// Here rather than in a package's suite for the reason `e2e-conventions.mjs`
// gives: it is a read of source text, so it needs no browser, no stack and no
// install, and the checkout-only Scripts job already runs
// `node --test scripts/lib/*.test.mjs`.
//
// **Markdown only, and not `poc/`.** The sample these rules come from is review
// threads about documents, issues and pull request bodies; `**` and paragraph
// duplication mean nothing in a TypeScript comment, and the eighty-two section
// citations in source comments name their document (`architecture §6.2`)
// rather than citing a number into thin air. `poc/` is outside the workspace and its
// reports are throwaway. A rule that fires where nobody is writing prose is a
// rule that gets the whole check disabled.
//

import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

/**
 * Directories the walk below never enters.
 *
 * `.claude/worktrees` is the one that is not obvious: a linked worktree is a
 * whole second checkout living inside the primary one, so a walk that descends
 * into it reads every branch anybody has open and reports their prose as this
 * one's.
 */
const NOT_PROSE = new Set([
  '.claude/worktrees',
  '.git',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'poc',
  'test-results',
]);

/** How many words a paragraph needs before duplication is worth reporting. */
const PARAGRAPH_MIN_WORDS = 15;

/** Shared-word fraction above which two paragraphs are near-verbatim. */
const NEAR_VERBATIM = 0.9;

/** The counting words a stale claim hides behind. Reported, never failed. */
const NUMBER_WORDS =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|both|twice|neither|either)\b/gi;

/** A title in the shape the documents use it: quoted, or a link's text. */
const TITLE = /["“][^"”]{4,}["”]|\[[^\]]{4,}\]\(/;

/**
 * `issue 77`, `(pull request 97)`.
 *
 * Named forms only. A bare `#14` is an open decision in the functional
 * definition, a driver in the architecture and a pull request in the test
 * explorer spec, so matching it reports six citations that resolve perfectly
 * well for every one it catches - and a check that cries wolf gets skipped.
 */
const ISSUE_REFERENCE = /\b(?:issues?|pull requests?)\s+#?(\d{1,5})\b/gi;

/** `§9.1`, `rule 2`, `rules 3`. */
const SECTION_CITATION = /§\s*\d+(?:\.\d+)*|\brules?\s+\d+\b/gi;

/** A heading that opens with its own number, or an ordered list item. */
const NUMBERED_HEADING = /^\s{0,3}#{1,6}\s*(\d+(?:\.\d+)*)[ .]/;
const NUMBERED_ITEM = /^\s{0,3}(\d+)[.)]\s/;

/**
 * Every Markdown file under `root` that carries prose, as paths relative to it
 * and separated with `/` whatever the platform.
 *
 * A walk rather than `git ls-files`: the Scripts job is checkout-only and this
 * needs no process, and a file being untracked does not make its prose exempt.
 */
export function markdownFiles(root, within = '') {
  return readdirSync(join(root, within), { withFileTypes: true }).flatMap((entry) => {
    const path = within ? posix.join(within, entry.name) : entry.name;
    if (entry.isDirectory()) return NOT_PROSE.has(path) || NOT_PROSE.has(entry.name) ? [] : markdownFiles(root, path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

/** `markdownFiles` speaks posix; the filesystem may not. */
export function nativePath(root, file) {
  return join(root, ...file.split('/'));
}

/**
 * The lines of a Markdown source with everything that is not prose blanked:
 * fenced code blocks and inline code spans.
 *
 * Blanked rather than dropped, so every index is still its own line number and
 * a violation can name one. `gh issue view <number>` in a fenced block is an
 * instruction, not a citation, and a glob written in backticks is a path, not a
 * bold marker.
 */
export function prose(source) {
  let fence = null;
  return source.split('\n').map((line) => {
    const opener = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence !== null) {
      if (opener && opener[1].startsWith(fence)) fence = null;
      return '';
    }
    if (opener) {
      fence = opener[1];
      return '';
    }
    return line.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length));
  });
}

/** A heading, a list item, a table row or a quotation: not running prose. */
const STRUCTURE = /^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/;

/**
 * Runs of lines that belong together, as `{ line, lines }`: broken by a blank
 * line, and each heading, list item, table row or quotation opening one of its
 * own so a wrapped bullet stays with its bullet and not with its neighbour.
 */
function blocks(lines, skip = () => false) {
  const found = [];
  let block = null;
  lines.forEach((text, index) => {
    if (!text.trim() || skip(text)) {
      block = null;
      return;
    }
    if (!block || STRUCTURE.test(text)) {
      block = { line: index + 1, lines: [] };
      found.push(block);
    }
    block.lines.push(text);
  });
  return found;
}

/**
 * Every issue or pull request number cited with no title named for it, as
 * `{ line, number, text }`.
 *
 * CLAUDE.md: "name an issue before giving its number". A number is a locator,
 * and on its own it says nothing to a reader who has not got the tab open.
 *
 * **Named once per file is enough.** `statement-lists.md` names issue 36 with
 * its title in the opening paragraph and then refers back to it four times;
 * repeating the title each time is the noise this rule is meant to prevent, not
 * the rule.
 *
 * **The title is looked for across the block, not the line.** Half the
 * documents wrap their prose, so the opening quote of `"Add a user on the admin
 * page, so a second person no longer needs SQL" (issue 231)` is one line above
 * the number - which a line-at-a-time read calls a violation eleven times in
 * `deployment.md` alone. The block is also the unit that reads right: one names
 * one piece of work, and CLAUDE.md's own account of issue 77 goes on to give
 * the number of the pull request that merged it, which needs no second title.
 * A bullet is its own block, so one item's title does not cover the next -
 * which is how `(issue 8, §2)` survived a rename of every other citation like
 * it in the functional definition.
 */
export function issueNumbersWithoutTitles(source) {
  const lines = prose(source);
  const named = new Set();
  return blocks(lines).flatMap(({ line, lines: block }) => {
    let before = '';
    return block.flatMap((text, offset) => {
      const found = [...text.matchAll(ISSUE_REFERENCE)].flatMap((match) => {
        const number = match[1];
        if (TITLE.test(before + text.slice(0, match.index))) {
          named.add(number);
          return [];
        }
        return named.has(number) ? [] : [{ line: line + offset, number, text: text.trim() }];
      });
      before += `${text} `;
      return found;
    });
  });
}

/**
 * Every `§N` or `rule N` citation with nothing in its own file to resolve
 * against, as `{ line, citation, text }`.
 *
 * A document that numbers its own sections cites them and is left alone. What
 * fails is the citation with nothing behind it: a number into another
 * document's numbering, which a reader cannot follow and CLAUDE.md bans
 * outright ("cite a section by its name, never by its number alone"), and a
 * number into this one's that has since moved or gone.
 *
 * Resolved against the numbers the file actually offers rather than against the
 * mere presence of a list, because "this file has a numbered list somewhere"
 * exempts twenty-two of the twenty-eight documents here and would let `§9.1`
 * stand in one whose sections stop at 8.
 */
export function unresolvedSectionCitations(source) {
  const lines = prose(source);
  const offered = new Set();
  for (const text of lines) {
    const numbered = text.match(NUMBERED_HEADING) ?? text.match(NUMBERED_ITEM);
    if (numbered) offered.add(numbered[1]);
  }
  return lines.flatMap((text, index) =>
    [...text.matchAll(SECTION_CITATION)]
      .filter((match) => !offered.has(match[0].replace(/[^\d.]/g, '')))
      .map((match) => ({ line: index + 1, citation: match[0], text: text.trim() })),
  );
}

/**
 * Every paragraph whose `**` markers do not balance, or that carries a
 * malformed run of them, as `{ line, text }` naming the paragraph's first line.
 *
 * Per paragraph rather than per line, because half these documents wrap their
 * prose and a bold phrase then opens on one line and closes on the next -
 * sixty-four of which a line-at-a-time count calls unbalanced, every one of
 * them correct markdown.
 */
export function unbalancedEmphasis(source) {
  return blocks(prose(source)).flatMap(({ line, lines }) => {
    const block = lines.join('\n');
    const markers = block.match(/\*\*/g)?.length ?? 0;
    return markers % 2 === 0 && !/\*{4,}/.test(block) ? [] : [{ line, text: lines[0].trim() }];
  });
}

/** A paragraph reduced to its words, so two phrasings of one sentence collide. */
function normalise(paragraph) {
  return paragraph
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The fraction of words two paragraphs share, counting repeats. */
function overlap(a, b) {
  const remaining = new Map();
  for (const word of a) remaining.set(word, (remaining.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of b) {
    const left = remaining.get(word) ?? 0;
    if (left > 0) {
      remaining.set(word, left - 1);
      shared += 1;
    }
  }
  return shared / Math.max(a.length, b.length);
}

/**
 * The prose paragraphs of one document, as `{ line, words }`.
 *
 * Headings, tables and list items carry the same words by design - a table of
 * parallel cases is what CLAUDE.md asks for - and a blockquote is a quotation,
 * which is the one place a paragraph is *supposed* to appear twice.
 */
function paragraphs(source) {
  return blocks(prose(source), (text) => STRUCTURE.test(text))
    .map(({ line, lines }) => ({ line, words: normalise(lines.join(' ')) }))
    .filter(({ words }) => words.length >= PARAGRAPH_MIN_WORDS);
}

/**
 * Every paragraph that appears near-verbatim in two places, as
 * `{ places: [{ file, line }, ...] }`.
 *
 * `documents` is `[{ file, source }, ...]`, because this is the one rule that
 * cannot be decided from a single file: the same stale paragraph on two pull
 * requests in a row is what put it here, and CLAUDE.md's "say it once, in one
 * place" is a claim about the repository rather than about a document.
 *
 * The exception it grants is honoured through the mechanism it names - "a
 * restatement claiming that exception says so where it stands". A document that
 * names another as its version of record may repeat it, which is how the
 * testing skill is allowed to be complete on its own.
 */
export function duplicateParagraphs(documents) {
  const declared = restatementsDeclared(documents);
  const allowed = (one, other) => declared.get(one)?.has(other) || declared.get(other)?.has(one);
  const all = documents.flatMap(({ file, source }) =>
    paragraphs(source).map(({ line, words }) => ({ file, line, words })),
  );
  const groups = [];
  const grouped = new Set();
  all.forEach((paragraph, index) => {
    if (grouped.has(index)) return;
    const places = [{ file: paragraph.file, line: paragraph.line }];
    for (let other = index + 1; other < all.length; other += 1) {
      if (grouped.has(other)) continue;
      // Length first: two paragraphs cannot share nine words in ten when one is
      // half the length of the other, and the cheap comparison spares the whole
      // corpus the expensive one.
      const lengths = [paragraph.words.length, all[other].words.length];
      if (Math.min(...lengths) / Math.max(...lengths) < NEAR_VERBATIM) continue;
      if (overlap(paragraph.words, all[other].words) < NEAR_VERBATIM) continue;
      if (allowed(paragraph.file, all[other].file)) continue;
      grouped.add(other);
      places.push({ file: all[other].file, line: all[other].line });
    }
    if (places.length > 1) groups.push({ places });
  });
  return groups;
}

/**
 * For each document, the documents it names as its version of record and may
 * therefore repeat, as `file -> Set<file>`.
 *
 * The declaration has to stand on one line, not merely somewhere in the file:
 * CLAUDE.md carries the phrase in one section and every document's filename in
 * another, and read loosely that exempts it from repeating anything at all.
 */
function restatementsDeclared(documents) {
  return new Map(
    documents.map(({ file, source }) => {
      const declaring = source.split('\n').filter((line) => /\b(?:version|document) of record\b/i.test(line));
      const declared = documents
        .map(({ file: other }) => other)
        .filter((other) => other !== file && declaring.some((line) => line.includes(other.split('/').pop())));
      return [file, new Set(declared)];
    }),
  );
}

/**
 * The lines a unified diff adds, as `file -> Set<line number>`.
 *
 * Here rather than beside the `git` call that feeds it, so the parsing can be
 * asserted: an empty result is what a clean change looks like too, so a
 * regression in it would read as "nothing to report" rather than as a break.
 * `@@ -3 +7 @@` with no count means one line, and `+7,0` means a deletion,
 * which adds none.
 */
export function linesAdded(diff) {
  const changed = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) file = header[1];
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || !file) continue;
    const from = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const touched = changed.get(file) ?? new Set();
    for (let offset = 0; offset < count; offset += 1) touched.add(from + offset);
    changed.set(file, touched);
  }
  return changed;
}

/**
 * Every counting word in the prose, as `{ line, word, text }`.
 *
 * Reported, never failed: whether "nine areas" is still nine is a fact about
 * the product, and a check that cries wolf is a check that gets skipped. What
 * it buys is the reader's attention on the lines a change touched, which is
 * where a count goes stale.
 */
export function numberWords(source) {
  return prose(source).flatMap((text, index) =>
    [...text.matchAll(NUMBER_WORDS)].map((match) => ({
      line: index + 1,
      word: match[0],
      text: text.trim(),
    })),
  );
}
