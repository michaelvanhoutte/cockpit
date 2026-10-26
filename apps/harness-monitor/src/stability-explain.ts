import type { Explanation } from './explain';

/** What each tile, panel and table of CI stability shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
export const WHAT = {
  passed: {
    shows: 'Of the workflow runs on <code>main</code> that finished in the period, the share that passed.',
    read: 'One failed job makes a failed run. The note gives the counts and how many runs were cancelled and left out. The figure is green at 99% or more and red below 90%.',
    look: 'Every failed run on <code>main</code> is a change that landed broken or a check that failed on its own, and everyone who branches from <code>main</code> then inherits it. Below 99%, the Least reliable job tile and the table under it say which job.',
  },
  leastReliable: {
    shows: 'The job with the lowest pass rate among those that finished at least three times in the period.',
    read: 'The note gives its rate, its failures out of its finished runs and its workflow. Its name opens its steps.',
    look: 'A job that fails far more often than the rest is more often fragile than catching that many real breaks; the Workflow tab says what makes its workflow fail.',
  },
  slowest: {
    shows: 'The job with the longest median duration in the period.',
    read: '<b>p90</b> is the slow end: one run in ten took longer. Only runs that passed or failed are timed, since a cancelled one was cut short, and a job run as shards is timed from the first shard&rsquo;s start to the last one&rsquo;s end. Its name opens where its time goes.',
    look: 'The slowest job sets how long every merge waits for its verdict, and the slower it is, the more often a newer push cancels it before it finishes.',
  },
  ended: {
    shows: 'Every job run on <code>main</code> in the period, by how it ended: every workflow&rsquo;s together, or only the one the Workflow filter picks.',
    read: 'Each segment is as wide as its share, and the list gives the counts. Violet passed, red failed, orange is still running, blue ended some other way, and grey was cancelled or skipped. A pass rate counts only the runs that finished: a cancelled run is not a failed one. <code>cancel-in-progress</code> cancels a run a newer push overtakes, and the slowest job most, so folding cancels into failures would read the browser tier far worse than it is. A skipped job never ran.',
    look: 'Red is the share to watch. A wide grey share is pushes overtaking each other, which costs runner time but is not instability.',
  },
  lastRuns: {
    shows: 'Whether each workflow passed or failed the last time it finished on <code>main</code>, failures first, with when.',
    read: 'The last run that passed or failed over every run stored, not only the period, so a newer cancelled, skipped or still running one never hides a red. Each verdict opens that run on GitHub.',
    look: 'A failed one here means that workflow is still red, and the notice at the top of the page says since when. A workflow that runs rarely, such as a nightly one, can stay red for a day before anything runs it again.',
  },
  steps: {
    shows: 'Each step of this job, in the order it runs, with its typical and slow-end time over the period.',
    read: 'The solid bar is the median, the pale one behind it the p90, both against the longest p90; Runs counts the jobs measured. From the jobs that passed or failed; skipped and cancelled steps are left out. A sharded job&rsquo;s steps are every shard&rsquo;s together, and a step named twice in a job carries its occurrence.',
    look: 'The longest bar is the step to speed up first. A p90 far beyond its median is a step that is usually quick but sometimes stalls, such as an install or a download.',
  },
  job: {
    shows:
      'Each row is a job, in the order the sentence names, with its figures on <code>main</code>: its last finished run, its pass rate with the counts behind it, how its runs ended, its failures and cancellations, and its median and p90 time. Beneath its failures, <i>+N on branches</i> counts the times it failed on a feature branch and a later attempt on the same commit passed. A row opens, from its chevron or a click outside its links, to <i>On main</i> beside <i>On feature branches</i>, each with a summary and its top three causes; a name opens its steps, which are <code>main</code>&rsquo;s.',
  },
  workflow: {
    shows:
      'Each row is a workflow that ran on <code>main</code> or flaked on a feature branch, in the order the sentence names: its pass rate on <code>main</code>, which counts every run on <code>main</code>, scheduled and manual runs included, and every attempt of a re-run as a run of its own; a square for each day, its failures on <code>main</code> with those on feature branches beneath, and its top cause. A square is <code>main</code>&rsquo;s pass rate that day, with a dot under it on a day a feature branch flaked. A feature branch counts only a failure that a later attempt on the same commit passed, since its other failures are usually the change being wrong. A row opens, from its chevron or a click outside its links, to <i>On main</i> beside <i>On feature branches</i>, each with a summary and its top three causes; the name opens the workflow&rsquo;s own view. <b>Copy prompt</b> copies what an agent needs to fix its causes, not retry them.',
  },
  fragile: {
    shows:
      'Each row is a test that failed and then passed on the same commit, on <code>main</code> or on a feature branch, in the order the sentence names: its name, the describe blocks it sits in and its latest error; one bar of its failures, every failure on <code>main</code> in red and its flaky failures on feature branches in orange, with the counts beneath; and its last flaky failure, which opens that job on GitHub. <code>main</code> counts every failure, since nobody re-runs it, and a feature branch only a failure a later attempt on the same commit passed, since its other failures are usually the change being wrong. An <i>also a miss</i> tag says Test selection counts the test&rsquo;s file a miss in the period: the file failed on <code>main</code> after a pull request skipped it. A row opens, from its chevron or a click outside its links, to its newest runs on <code>main</code> beside its newest on feature branches, each saying whether a re-run passed. <b>Copy prompt</b> copies what an agent needs to find what makes the test nondeterministic, not to retry it.',
  },
  workflowRate: {
    shows: 'Of the attempts on <code>main</code> that finished in the period, the share that passed, scheduled and manual runs included.',
    read: 'Every attempt of a re-run is a run of its own. The note gives the counts. The figure is green at 99% or more and red below 90%.',
    look: 'Every failure on <code>main</code> is a change that landed broken or a check that failed on its own, and everyone who branches from <code>main</code> then inherits it.',
  },
  workflowFailed: {
    shows: 'The attempts on <code>main</code> that failed in the period.',
    read: 'The note gives how many of them a later attempt on the same commit passed. <code>main</code> is re-run rarely, so every failure counts, flaky or not.',
    look: 'A failure no re-run turned green is a break: find what broke it. A flaky one is nondeterminism, and the causes below say which test.',
  },
  workflowFlaky: {
    shows: 'The attempts on feature branches that failed and then passed on the same commit.',
    read: 'A branch&rsquo;s other failures are left out, being usually the change being wrong. The note gives how many commits they were on.',
    look: 'Each one cost a pull request a re-run. Many with one cause is a test or check to fix before it costs more.',
  },
  workflowTop: {
    shows: 'The cause behind the most failures of this workflow, main&rsquo;s counted before the branches&rsquo;.',
    read: 'A cause is the failing test where the attempt names one, otherwise the job and step. The note gives its failures on <code>main</code> and its flaky ones on feature branches.',
    look: 'Fixing the top cause is the one change that removes most of the failures below it.',
  },
  workflowPerDay: {
    shows: 'For each day of the period, the workflow&rsquo;s attempts on <code>main</code> that passed, failed and then passed on the same commit, and failed, with the flaky failures on feature branches in a bar beside.',
    read: 'Violet passed, orange failed and then passed on the same commit, red failed. The percentage above a bar is <code>main</code>&rsquo;s pass rate that day; the pale orange bar beside it counts the day&rsquo;s flaky failures on feature branches.',
    look: 'Red days are breaks on <code>main</code>. A run of orange days is nondeterminism worth finding. Pale bars with nothing beside them are flakes only pull requests felt.',
  },
  workflowCauses: { shows: 'Each row is a cause of this workflow&rsquo;s failures, most on <code>main</code> first. A cause is the failing test where the attempt names one, otherwise the job and step, with its error where there is one, its failures on <code>main</code> and how many were flaky, its flaky failures on feature branches, and its latest, which opens that job on GitHub.' },
  workflowEvery: { shows: 'Each row is a failure counted for this workflow, <code>main</code> first and then newest first: when and where it ran, the jobs and steps that failed, the tests named, and whether a later attempt on the same commit passed.' },
} satisfies Record<string, Explanation>;

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'Job counts the jobs of GitHub Actions on the <code>main</code> branch, and shows the ones that flaked on a feature branch beside them; Workflow counts the workflows&rsquo; runs on both; Fragile tests lists the tests behind the flaky failures. A <b>pass rate</b> is the runs that passed out of those that finished with a verdict, passed or failed, each attempt of a re-run counting as a run of its own. A <b>cancelled</b> run was stopped before it finished, mostly by a newer push overtaking it, so it counts as neither. A failure is <b>flaky</b> when a later attempt on the same commit passed: on <code>main</code> every failure counts, since it is rarely re-run, and on a feature branch only a flaky one, since its other failures are usually the change being wrong. A <b>cause</b> is the failing test where the attempt names one, otherwise the job and step.';
