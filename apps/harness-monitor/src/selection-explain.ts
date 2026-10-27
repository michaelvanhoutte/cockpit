import type { Explanation } from './explain';

/** What each tile, panel and view of Test selection shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
export const WHAT = {
  ranMore: {
    shows: 'The time CI spent on full runs of a job that selecting only what the change reaches would have saved, counting the full runs a rule to fix forced.',
    read: 'Each full run counts the time its check held the pull request up (time waited, not every shard&rsquo;s running time added up), less the median a selected run of the same job held one up in the period, never below zero; a pull request cycle time does not hold counts nothing. The notes give how many full runs the rules to fix forced and, per job, every full run against the pull requests it ran, with the time the expected ones add. Which rules opens them, ranked by the same time.',
    look: 'A figure that keeps growing means rules still force full runs on changes that did not need them; the first rule to fix is the one to narrow. A small figure beside many full runs means they were expected ones, such as a push to <code>main</code>.',
  },
  ranLess: {
    shows: 'How many tests failed on <code>main</code>&rsquo;s run of a merge after the pull request&rsquo;s own last run had skipped them.',
    read: 'Each is one test file or spec, counted per pull request and job. A documentation-only pull request ran no test at all, so every failure on <code>main</code> after it counts as its skipped test. Which ones opens them, each with a prompt.',
    look: 'Zero is the only healthy number: a test that fails after being skipped is a broken test that reached <code>main</code> because selection judged the change could not affect it. One that then passes on <code>main</code>&rsquo;s next run may be a flaky test rather than a selection that skipped too much; the prompt has Claude tell which.',
  },
  whatEachJobDid: {
    shows: 'What each job did with every pull request merged in the period: selected a subset, ran everything, or never started because the change was documentation only.',
    read: 'One bar per job, each segment as wide as its share of the pull requests, with the count and share listed under it. Violet is a selected subset; orange ran everything, red where the job is over its bar for the period; grey is documentation only, and <i>No record</i> a pull request whose run left no record of what it ran, counted in neither direction. The note beside the heading gives the bar.',
    look: 'Selecting a subset is selection working; running everything is the cost a rule forced. A wide orange or red segment says the rules force too much, and each rule that forced a full run names them. Many <i>No record</i> pull requests mean the figures rest on fewer merges than were made.',
  },
  perDay: {
    shows: 'For each day, the share of the pull requests merged that day that ran each job in full.',
    read: 'One line per job, with a dot for each day a merged pull request ran it; a day without one has no dot and the line joins across it. The dashed line is the bar, one per job where their bars differ. Point at a dot for its counts.',
    look: 'One day at 100% is often a single pull request that touched the lockfile or a shared config: read it against how many merged. A line that stays above the bar for days is a rule forcing full runs on most changes.',
  },
  pull: {
    shows: 'What each job ran on this pull request&rsquo;s last run, and why: the files it changed, then for each job every package&rsquo;s mode, what it ran, and why each selected file was picked.',
    read: 'A package marked <b>full</b> ran whole, with the rule and path that forced it; <b>changed</b> ran only what the change reaches. <b>Ran</b> counts its files run of those it holds, and <i>no report</i> means its process wrote none, so what it ran is unknown. Under <i>Selected, and why</i>, <i>via</i> gives the chain of imports from the test to a changed file, <i>itself changed</i> a test that was edited, and an E2E spec names the product area a changed file belongs to. A changed file <i>ignored by selection</i> is not product code, such as a document.',
    look: 'A package run full because of a file it cannot depend on is a rule worth narrowing. A long chain ending in a file nearly everything imports explains a test selected on every pull request. A miss here names a test that failed on <code>main</code> and did not run on this pull request.',
  },
  rule: { shows: 'Every path that set this rule off in the period, the one most pull requests hit first, with those pull requests. The advice above says whether the rule is expected or worth narrowing.' },
} satisfies Record<string, Explanation>;

/** What each row's table shows. */
export const TABLES: Record<'rule' | 'miss', Explanation> = {
  rule: {
    shows:
      'Each row is a rule that made a job run a package whole, in three groups: <b>rules to fix</b>; <b>expected</b> ones, which force a full run by design; and <b>stopped</b> ones, which forced none of the job&rsquo;s last 20 pull requests. Each group lists first the rule whose full runs <b>could have saved</b> the most: for each, the time its check held the pull request up, less the median a selected run of the same job held one up in the period, never below zero. A pull request cycle time does not hold counts nothing. <b>Pull requests</b> is how many of those the job ran the rule fired on (a pull request counts once per rule), and <b>Paths</b> how many files set it off. <b>Copy prompt</b> copies what an agent needs to narrow a rule to fix. A rule&rsquo;s name opens its paths.',
  },
  miss: {
    shows:
      'Each row is a test or spec that failed on <code>main</code> after its pull request skipped it, newest first, with its level and job, the pull request that skipped it and when that merged, and <i>it changed only documents, so it ran no tests</i> where the job never started. <b>Copy prompt</b> copies what an agent needs to find out whether the change could have broken the test, and so the selection should learn the link, or the test is flaky and needs fixing.',
  },
};

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'Every figure is a merged pull request and what CI&rsquo;s two test jobs did on its last run: the <b>Test job</b>, which runs every package&rsquo;s Vitest suites, and the <b>E2E job</b>, which runs the browser walks. A job <b>selected a subset</b> when it ran only the tests its change can reach, through imports or, for E2E, the product area a changed file belongs to; it <b>ran everything</b> when a rule forced every package to run whole. A test <b>skipped, then failed on main</b> failed on <code>main</code> after the merge while the pull request&rsquo;s own run had skipped it. A <b>bar</b> is the line a job&rsquo;s full runs are judged against, drawn on the chart and turning the job red above it; a period with too few pull requests to judge is read by none.';
