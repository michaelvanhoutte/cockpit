import type { Explanation } from './explain';

/** What each tile, panel and view of Tests shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
export const WHAT = {
  rules: {
    shows: 'How many rules the tests state about the areas in view: the chosen area and everything inside it, or every area.',
    read: 'A rule is one behaviour a test checks, written in the product&rsquo;s own words. The Level and Package filters narrow what is counted, and the note says which areas and filters it covers.',
    look: 'Set it beside its neighbours rather than reading it alone: an area with few rules next to areas like it is the place to look, but more rules is not better tested on its own.',
  },
  cases: {
    shows: 'How many cases those rules hold, and in how many test files they are written.',
    read: 'A case is one situation a rule is checked in, such as one row of a table of inputs. <i>Not written yet</i> counts the cases declared as a to-do, which check nothing.',
    look: 'On <code>main</code> there should be no to-do: one may not outlive the pull request that declared it. A rule with a single case checks one situation only.',
  },
  files: {
    shows: 'The source files of the areas in view that no test file imports, at any level.',
    read: 'Read from each test file&rsquo;s own imports, never from running them: a file reached only through another source file, or only by a test that drives the app over HTTP, counts here too. So a file here is a place to check, not proof that nothing tests it.',
    look: 'A file here that holds logic, a calculation or a branch, is untested until a test imports it. The Gaps tab lists them, with a prompt to copy for an agent to write the missing tests.',
  },
  branches: {
    shows: 'How many branches, each side of an <code>if</code>, a condition or a <code>switch</code>, no test takes in the source files of the areas in view.',
    read: 'Measured by the instrumented run CI makes on every merge to <code>main</code>. A pull request&rsquo;s run is not instrumented, so its tests read <i>unknown</i> here, which is not zero. A file owned by two areas is counted once.',
    look: 'A file with many branches nothing takes has paths no test has ever been down, often its error handling. The Gaps tab names the lines.',
  },
  empty: {
    shows: 'How many of the areas in view have no rule, neither their own nor inside them, and the first few by name.',
    read: 'Areas come from the repository&rsquo;s registry, which can name one ahead of the code that will back it, so a row of zeros is not a fault on its own. With a Level filter, it counts the areas with no rule at that level.',
    look: 'An area that already has code and still no rule is a part of the product no test speaks for.',
  },
  areas: {
    shows: 'Every area of the product as a tree, each with its rules split by testing level or by package, and the source files and branches no test reaches.',
    read: 'An indented row sits inside the row above it. A row holding others gives its own count first, then everything inside it in brackets. The bar is the row&rsquo;s rules, scaled to the largest row, cut by level colour, or in one colour when counted by package. <i>n/a</i> is a level that cannot apply, never a zero: L3 needs a second backend service, and Contract applies only to an area a contract suite, a live check of a third party, names. A count opens the tests behind it, and an area&rsquo;s name opens the area.',
    look: 'The red counts are the files and branches to look at first. An area with only L1 rules has its logic checked but never its wiring, and one the person using the app touches needs at least one frontend rule: F3, or F2 where F3 cannot reach it.',
  },
  ownRules: { shows: 'Each row is a rule naming this area itself, grouped by level, with its cases and where it is written; a rule naming an area inside it is listed there instead. A rule&rsquo;s statement opens its cases.' },
  where: {
    shows: 'How the rules of the areas in view spread across the testing levels, or across the packages they are written in.',
    read: 'Counted by level, the bar is cut in each level&rsquo;s colour and the list gives each count; counted by package, the list alone. A rule is one inner <code>describe</code>; its cases are the <code>it</code>s inside it. The level is read from the folder the test file sits in. Counts, never percentages: a count only says where to look next to another row&rsquo;s, and more rules is not better tested.',
    look: 'A healthy spread is many rules low and few high: logic at L1, the database at L2, each capability once in the browser at F3. Most rules at F3 means slow tests proving what a lower level could; none at F3 means nothing checks that the app works for the person using it.',
  },
  worst: {
    shows: 'The five areas holding the most source files no test imports, each with where it sits in the tree.',
    read: 'Each counts only the area&rsquo;s own files, not those of the areas inside it. A name opens its files on the Gaps tab.',
    look: 'The top row is the part of the product with the most code no test touches directly. Check those files first, remembering that one driven only over HTTP may be tested after all.',
  },
  tests: { shows: 'Every rule behind the count you followed, grouped by area, with its level, its cases and where it is written. A rule opens its cases, and Close puts the page back.' },
  rule: {
    shows: 'One rule: the behaviour it states, its testing level, the area and package it belongs to, and where in its test file it is written, with the code around it.',
    read: 'No pass or fail mark: the explorer reads the test files and never runs them, so whether the rule holds today is for CI to say. Its place opens the file on GitHub at the rule&rsquo;s line.',
  },
  ruleCases: { shows: 'Each case is one situation the rule is checked in, with the code around it: the written ones in the order written, then those marked <i>not written yet</i>, declared as a to-do, which check nothing.' },
  level: { shows: 'Each row is a testing level, lowest first as the testing strategy orders them, with its rules split by the package they are written in, its cases, test files and the areas it covers. <i>n/a</i> marks a level the repository does not have yet. A level&rsquo;s name opens the areas at that level.' },
  package: { shows: 'Each row is a package, where a test file or an untested source file lives, with its rules split by level and the source files no test imports in it. A name opens the areas it tests.' },
  gapFiles: { shows: 'Each row is a source file no test file imports, with the areas that own it and its package. A file reached only by a test that drives the app over HTTP still shows here, so check the tests before treating it as a gap; the prompt to copy lists them for an agent to write what is missing.' },
  gapBranches: { shows: 'Each row is a source file with branches no test takes, the most first, with the lines they are on, each opening the code on GitHub, and the areas that own it. Only <code>main</code>&rsquo;s instrumented run measures them, so a pull request&rsquo;s tests read unknown.' },
} satisfies Record<string, Explanation>;

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'Every figure is read from the test files of one commit, <code>main</code>&rsquo;s or an open pull request&rsquo;s, never from running them; only the branches no test takes come from a run, CI&rsquo;s instrumented one on <code>main</code>. A <b>rule</b> is one behaviour a test states, an inner <code>describe</code>, and its <b>cases</b> are the <code>it</code>s inside it, one situation each. A <b>testing level</b> is how much is real when the test runs, from L1, logic alone, to F3, the whole app in a browser. An <b>area</b> is a part of the product, from the repository&rsquo;s registry, that a rule names in its outer <code>describe</code>.';
