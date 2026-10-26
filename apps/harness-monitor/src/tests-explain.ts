import type { Explanation } from './explain';

/** What each tile, panel and view of Test coverage shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
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
  covered: {
    shows: 'The share of the statements in the source files of the areas in view that CI&rsquo;s coverage run on <code>main</code> executes, how many statements that is, and how many files it runs nothing of.',
    read: 'A statement counts as run when any test below the browser executes it, in the instrumented run CI makes on every merge to <code>main</code>. The browser walks are not instrumented, so a screen proven only end to end reads low, and a pull request&rsquo;s run is not either, so its tests read <i>unknown</i>, which is not 0%. A file owned by two areas is counted once, and one holding only types has nothing to run. The share is floored, and red in the table under 80%.',
    look: 'A low share proves testing falls short there; a high one proves nothing on its own, since a line can run without any test checking what it does. Start with the red rows: the Gaps tab lists the files under 80%, the most statements no test runs first.',
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
    shows: 'Every area of the product as a tree, each with its rules split by testing level or by package, the share of its code the tests run, and the branches no test takes.',
    read: 'An indented row sits inside the row above it. A row holding others gives its own figure first, then everything inside it in brackets. <i>n/a</i> is a level that cannot apply, never a zero: L3 needs a second backend service, and Contract applies only to an area a contract suite, a live check of a third party, names. Covered is the share of the area&rsquo;s statements CI&rsquo;s coverage run executes, red under 80%, a dash where its files hold nothing to run, and <i>unknown</i> where the snapshot had no coverage run. A count opens the tests behind it, an area&rsquo;s name opens the area, and its share or its branches open its files on the Gaps tab.',
    look: 'The red shares and branch counts are the places to look first. An area with only L1 rules has its logic checked but never its wiring, and one the person using the app touches needs at least one frontend rule: F3, or F2 where F3 cannot reach it.',
  },
  ownRules: { shows: 'Each row is a rule naming this area itself, grouped by level, with its cases and where it is written; a rule naming an area inside it is listed there instead. A rule&rsquo;s statement opens its cases.' },
  tests: { shows: 'Every rule behind the count you followed, grouped by area, with its level, its cases and where it is written. A rule opens its cases, and Close puts the page back.' },
  rule: {
    shows: 'One rule: the behaviour it states, its testing level, the area and package it belongs to, and where in its test file it is written, with the code around it.',
    read: 'No pass or fail mark: the explorer reads the test files and never runs them, so whether the rule holds today is for CI to say. Its place opens the file on GitHub at the rule&rsquo;s line.',
  },
  ruleCases: { shows: 'Each case is one situation the rule is checked in, with the code around it: the written ones in the order written, then those marked <i>not written yet</i>, declared as a to-do, which check nothing.' },
  gapFiles: { shows: 'Each row is a source file of the areas in view with under 80% of its statements run by a test, the most statements no test runs first, with its share, the branches no test takes in it and the areas that own it; a file at or above 80% is not listed. Only <code>main</code>&rsquo;s instrumented run measures them, so a pull request&rsquo;s tests read unknown. The prompt to copy names the files listed, for an agent to write what is missing.' },
  gapBranches: { shows: 'Each row is a source file with branches no test takes, the most first, with the lines they are on, each opening the code on GitHub, and the areas that own it. Only <code>main</code>&rsquo;s instrumented run measures them, so a pull request&rsquo;s tests read unknown.' },
} satisfies Record<string, Explanation>;

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'Every figure is read from the test files of one commit, <code>main</code>&rsquo;s or an open pull request&rsquo;s, never from running them; only the share covered and the branches no test takes come from a run, CI&rsquo;s instrumented one on <code>main</code>. A <b>rule</b> is one behaviour a test states, an inner <code>describe</code>, and its <b>cases</b> are the <code>it</code>s inside it, one situation each. A <b>testing level</b> is how much is real when the test runs, from L1, logic alone, to F3, the whole app in a browser. An <b>area</b> is a part of the product, from the repository&rsquo;s registry, that a rule names in its outer <code>describe</code>.';
