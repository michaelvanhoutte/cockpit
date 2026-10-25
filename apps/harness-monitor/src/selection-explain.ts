import type { Explanation } from './explain';
import type { Group } from './selection-report';

/** What each tile, panel and view of Test selection shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
export const WHAT = {
  ranEverything: {
    shows: 'Of the pull requests that ran this job, the share on which it ran every test rather than a subset: the cost selection exists to avoid.',
    read: 'The note gives the count, the bar it is judged against and the rule that forced most of those full runs; the rule&rsquo;s name opens it on the What forced a full run tab. The label reads <i>over the bar</i> in red once the share reaches the bar, <i>within</i> in green below it, and nothing while the period holds too few pull requests to judge. While it is over, the note links the alarm issue the nightly job filed for the bar, if one is open.',
    look: 'A share creeping up means more changes touch something that forces a full run, such as the lockfile, a shared config or a file no package owns. Each one is a full CI wait the change did not need; the rule named is the one to narrow first.',
  },
  misses: {
    shows: 'How many times a test failed on <code>main</code>&rsquo;s run of a merge after the pull request&rsquo;s own last run had skipped it.',
    read: 'Each is one test file or spec, counted per pull request and job. A documentation-only pull request ran no test at all, so every failure on <code>main</code> after it counts as its miss. The note says how many cross the bar, and See which opens them on the Misses tab.',
    look: 'Zero is the only healthy number: a miss is a broken test that reached <code>main</code> because selection judged the change could not affect it. A miss on a test that then passes on <code>main</code>&rsquo;s next run may be a flaky test rather than a selection that skipped too much.',
  },
  mostSelected: {
    shows: 'The test file or spec selected on the largest share of the pull requests that could have skipped it.',
    read: '<b>Could have skipped it</b> counts the pull requests on which its package ran only what the change reaches, rather than running whole. A test is ranked only once enough pull requests could have skipped it; the note gives that minimum and the bar. Its name opens it on the Most selected tests tab.',
    look: 'A test selected on nearly every pull request is usually reached through a file nearly every change touches, such as a shared helper, so selection saves nothing on it. The chain beside it on the Most selected tests tab is the import to cut.',
  },
  whatEachJobDid: {
    shows: 'What each job did with every pull request merged in the period: selected a subset, ran everything, or never started because the change was documentation only.',
    read: 'One bar per job, each segment as wide as its share of the pull requests, with the count and share listed under it. Violet is a selected subset; orange ran everything, red where the job is over its bar for the period; grey is documentation only, and <i>No record</i> a pull request whose run left no record of what it ran, counted in neither direction. The note beside the heading gives the bar.',
    look: 'Selecting a subset is selection working; running everything is the cost a rule forced. A wide orange or red segment says the rules force too much, and the What forced a full run tab names them. Many <i>No record</i> pull requests mean the figures rest on fewer merges than were made.',
  },
  typical: {
    shows: 'What a typical pull request ran: for each job, how many test files or specs a run that selected ran, how long the Test job took beside <code>main</code>&rsquo;s own run of the same merge, and how many pull requests were documentation only.',
    read: 'Each job&rsquo;s figure and the times are medians; <i>Documentation only</i> counts pull requests. A job&rsquo;s count is over the pull requests that selected; <i>of</i> is how many it holds in all, so the two together say how much a selection skips. <code>main</code> runs every test on the merge, so its time is what the Test job costs without selection.',
    look: 'A typical run close to the whole count, or a Test job time close to <code>main</code>&rsquo;s, means selection saves little even when it works.',
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
  test: { shows: 'Every pull request in the period that selected this test, newest first, with how it ended and why it was picked. The note beside the heading counts those that selected it, those whose package could have but skipped it, and those that ran it in a full run.' },
} satisfies Record<string, Explanation>;

/** What each tab's table shows. */
export const TABLES: Record<Group, Explanation> = {
  day: { shows: 'Each row is a day, newest first: how many pull requests merged, each job&rsquo;s outcomes as a split bar with how many ran everything, the misses, and the median test files or specs a run that selected ran. The number merged opens the Pull request tab.' },
  pr: { shows: 'Each row is one merged pull request, newest first: what each job did, with the rule that forced a full run beneath it, its misses and the Test job&rsquo;s time. Its title opens what each job ran and why.' },
  rule: {
    shows:
      'Each row is a rule that made a job run a package whole, worst first, with what to do about it: how many of the pull requests that ran the job it fired on (a pull request counts once per rule), on how many it left the whole job running everything, and how many paths set it off. The verdict judges the share it left running everything against the job&rsquo;s bar. A rule&rsquo;s name opens its paths.',
  },
  package: {
    shows:
      'Each row is a package, the browser walks as one, most often touched first: how many test files it holds, on how many of the pull requests that selected in it something of it ran, the median it then ran, how often it ran in full and the rule behind most of those. A package selecting runs only the files the change reaches, so one touched on most pull requests holds a file nearly everything imports.',
  },
  test: {
    shows:
      'Each row is a test file or spec, most selected first, with the import chain that most often picked it and its level: on how many of the pull requests that could have skipped it it was selected, in how many full runs it ran, and whether it crosses the bar. Its name opens the pull requests that selected it. If the chain is wider than what really depends on the file, narrowing it is what would shrink the count.',
  },
  miss: {
    shows:
      'Each row is a test or spec that failed on <code>main</code> after its pull request skipped it, newest first, with its level, its job and why it did not run: <i>docs only</i> where the pull request never started the job. To fix one, widen the import chain the test should have been reached through, or add the edge Vitest&rsquo;s own graph does not see.',
  },
};

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'Every figure is a merged pull request and what CI&rsquo;s two test jobs did on its last run: the <b>Test job</b>, which runs every package&rsquo;s Vitest suites, and the <b>E2E job</b>, which runs the browser walks. A job <b>selected a subset</b> when it ran only the tests its change can reach, through imports or, for E2E, the product area a changed file belongs to; it <b>ran everything</b> when a rule forced every package to run whole. A <b>miss</b> is a test that failed on <code>main</code> after the merge while the pull request&rsquo;s own run had skipped it. A <b>bar</b> is the line a headline figure is judged against; a period with too few pull requests to judge is read by none.';
