import type { Explanation } from './explain';

/** What each tile, panel and table of CI stability shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
export const WHAT = {
  passed: {
    shows: 'Of the workflow runs on <code>main</code> that finished in the period, the share that passed.',
    read: 'One failed job makes a failed run. The note gives the counts and how many runs were cancelled and left out. The figure is green at 99% or more and red below 90%.',
    look: 'Every failed run on <code>main</code> is a change that landed broken or a check that failed on its own, and everyone who branches from <code>main</code> then inherits it. Below 99%, the Least reliable job tile and the table under it say which job.',
  },
  red: {
    shows: 'How long, in the period, at least one workflow on <code>main</code> was red: its latest finished run had failed.',
    read: 'Spells of several workflows at once count once, so it never exceeds the period, and a spell still open runs to now. The note gives its share of the period and how many spells reached into it.',
    look: 'Zero is the aim. Hours of red mean <code>main</code> stayed broken while people kept merging onto it; the Red spells tab says which workflow and for how long.',
  },
  leastReliable: {
    shows: 'The job with the lowest pass rate among those that finished at least three times in the period.',
    read: 'The note gives its rate, its failures out of its finished runs and its workflow. Its name opens its steps.',
    look: 'A job that fails far more often than the rest is more often fragile than catching that many real breaks; the Failures tab says which step it keeps dying at.',
  },
  slowest: {
    shows: 'The job with the longest median duration in the period.',
    read: '<b>p90</b> is the slow end: one run in ten took longer. Only runs that passed or failed are timed, since a cancelled one was cut short, and a job run as shards is timed from the first shard&rsquo;s start to the last one&rsquo;s end. Its name opens where its time goes.',
    look: 'The slowest job sets how long every merge waits for its verdict, and the slower it is, the more often a newer push cancels it before it finishes.',
  },
  ended: {
    shows: 'Every job run on <code>main</code> in the period, all workflows together, by how it ended.',
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
  job: { shows: 'Each row is a job, in the order the sentence names: its last finished run, its pass rate with the counts behind it, how its runs ended, its failures and cancellations, and its median and p90 time. A name opens its steps.' },
  workflow: { shows: 'Each row is a workflow: its last finished run, its own pass rate (a run with one failed job is a failed run, not an average of its jobs), how its runs ended, its failures, and how many red spells it had and how long they lasted. A name opens its jobs.' },
  spells: { shows: 'Each row is a red spell: its workflow, with the job and step that failed in the run that opened it, when it went red and green again, how long it lasted and how many commits failed during it. A spell runs from a failing run to the next passing one of the same workflow; consecutive failures are one spell, and a cancelled run between them neither opens nor closes one.' },
  whereTheyDied: { shows: 'Each row is a job and the step it failed at, the most failures first, with the workflows it failed in and its latest failure. One near the top failing at the same step again and again is the fragile check to fix first.' },
  recent: { shows: 'Each row is a failed run, newest first: when, its workflow, the jobs that failed in it, the step each died at, and the commit it ran on, each opening on GitHub.' },
  perDay: {
    shows: 'For each day of the period, how long each workflow was red, and how long any of them was.',
    read: 'One line per workflow red in the period, with a dashed line and shaded area for any workflow, which counts time several were red at once only once. Workflows past the eighth ever red are drawn together as Other. Point at a dot for its time, or at a name in the key to pick its line out.',
    look: 'Spikes are days <code>main</code> was broken for hours. Several lines rising on the same day usually share one cause, such as an outage or a broken dependency, rather than separate breaks.',
  },
  day: { shows: 'Each row is a day, newest first: its red time split by workflow, how many spells began, how many runs failed, and the red time of any workflow. Workflows red at the same time count once under Any workflow, so it can be less than the row&rsquo;s sum.' },
} satisfies Record<string, Explanation>;

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'Every figure is GitHub Actions on the <code>main</code> branch: each workflow run, such as CI after a merge or a nightly job, and the jobs inside it. A <b>pass rate</b> is the runs that passed out of those that finished with a verdict, passed or failed. A <b>cancelled</b> run was stopped before it finished, mostly by a newer push overtaking it, so it counts as neither. A <b>red spell</b> is a stretch when a workflow&rsquo;s latest run had failed, from that run to the next one that passed. A <b>fluke</b> is a check that fails and then passes on a re-run with nothing changed; the page sees only how each run ended, so it cannot tell a fluke from a real break.';
