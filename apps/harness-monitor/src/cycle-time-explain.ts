import type { Explanation } from './explain';

/** What each panel of the cycle time page shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
export const WHAT = {
  startToMerge: {
    shows: 'How long a typical change takes, from the first prompt that starts it to the moment it lands on <code>main</code>.',
    read: 'The big figure is the median: half the pull requests were quicker, half slower. <b>p95</b> is the slow tail: one in twenty took longer than it. The arrow compares with the same number of days just before this period.',
    look: 'A median creeping up means changes are getting slower to land. A p95 many times the median means most changes flow but a few get stuck; open the Pull request tab to find them.',
  },
  inHarness: {
    shows: 'Of the time spent writing a change plus checking it, the share that went on checking: reviews and test runs on the developer&rsquo;s machine, and CI on every push.',
    read: '70% would mean seven minutes of checking for every three of writing. <b>×&nbsp;the writing</b> is the typical pull request&rsquo;s checking time divided by its writing time.',
    look: 'Above 50%, checking a change costs more time than producing it. That is the first place to look for speed: the timeline below says which check.',
  },
  rounds: {
    shows: 'How many times a change was pushed and checked by CI before it merged.',
    read: 'A <b>round</b> is one push and the checks it set off. A <b>red</b> round failed and needed a fix. A <b>fluke</b> failed, then passed when re-run with nothing changed: a flaky check, not a broken change.',
    look: 'One round a pull request is the ideal: the change was right when it left the machine. Every extra round is another full CI wait; flukes are waits nobody&rsquo;s code caused.',
  },
  cost: {
    shows: 'What the Claude Code sessions that built these pull requests cost, at Anthropic&rsquo;s list price.',
    read: 'The second line is the average a pull request. <b>Priced</b> counts the pull requests whose sessions the Monitor could match to them; the rest are left out, not counted as free.',
    look: 'Set it beside the time figures: slow pull requests are usually the expensive ones too, because a session waiting on checks and fixing what they find keeps spending.',
  },
  where: {
    shows:
      'All the time between starting a change and merging it, every pull request in the period added together, cut into phases: <b>Writing</b> (the agent producing the change), <b>Local checks</b> (reviews, tests and a browser check on the developer&rsquo;s machine before pushing), <b>CI rounds</b> (GitHub checking each push), <b>Waiting to merge</b> (all green, not merged yet) and <b>Away</b> (gaps of over three hours, such as nights).',
    read: 'Every phase bar sits on one timeline, start on the left and merge on the right, and is as long as the time you waited, so the phases add up to start to merge. The indented rows are the parts of the phase above them, as time spent: each starts where its phase starts and is drawn at its own length. The dashed line is where the phase&rsquo;s wait ended; a part that crosses it ran longer in total than the wait, such as E2E&rsquo;s four shards side by side. A phase&rsquo;s percentage is its share of start to merge; a part&rsquo;s is its share of the phase&rsquo;s time spent. A CI check&rsquo;s time is all its jobs added up, shards and re-runs included, queueing left out; a check marked <i>not recorded</i> has no running time stored.',
    look: 'The longest bar is where the time goes. When Local checks and CI rounds together outweigh Writing, a change spends longer being checked than being built, and the indented rows name the check to speed up first.',
  },
  scatter: {
    shows: 'Each dot is one pull request: across, how long the agent spent writing it; up, how long it then spent in checks, local and CI.',
    read: 'The dashed diagonal is &ldquo;as long checking as writing&rdquo;: dots above it were checked for longer than they were written. The solid line is the typical pull request. A bigger dot changed more lines; a red dot needed three or more CI rounds. Point at a dot for its figures, click it for its sessions.',
    look: 'Most dots above the dashed line means checking dominates whatever the change. Small dots as high as big ones means checking is a fixed cost every change pays regardless of size. Red dots near the top are changes slowed by repeated CI failures rather than by their size.',
  },
  overTime: {
    shows: 'One bar per pull request, placed at the moment it merged, as tall as the time from start to merge and coloured by phase.',
    read: 'The colours are the phases of the timeline above. A bar taller than four hours is cut, with a small triangle on top. A gap is a stretch when nothing merged. Click a bar for that pull request&rsquo;s sessions.',
    look: 'Whether one colour grows or shrinks over the weeks, which shows a change to the process working or not. Tall bars bunched on the same days usually mean CI was broken or slow for everyone then.',
  },
  day: { shows: 'Each row is a day: the average pull request merged that day, cut into the same phases. Click a row to see its phases.' },
  pr: {
    shows:
      'Each row is one pull request, newest first, with its own phases, CI rounds and Claude Code cost. Click a row to see its phases and, under them, its timeline: one line of time from the first commit or session start to the merge. A pull request marked <i>no session record</i> has no writing or local check time, which is unknown, not zero, and its timeline starts at the first commit.',
    read: 'The timeline is drawn to a scale of up to four hours, and every part sits at its own time and length on it; one too short to see is drawn a little wider, over what follows it. A <b>CI Round</b> is a push until the last check on it finishes, drawn as a lane for each job from its own start to its own stop, so jobs that ran together sit in rows above one another; a dotted lead is a job waiting for a runner, a hatched lane a re-run, a ringed one a failed job. A red round (&#10005;) failed and was pushed again; a fluke (&#8635;) failed and passed on re-run. A local review, test run or browser pass is cut out of the coding or fixing it sat in, at the time it ran, and several at once take as few rows as ever ran together. A gap of over three hours is time away, a fixed break off the scale. Click the timeline to open it on its own scale, uncut, with a clock-time axis in Belgian time; there, click a phase, a CI job or a local run to read it under the axis, and click the axis, or an empty row, to close it.',
    look: 'Where the CI blue is longer than the coding and fixing together, the harness holds the change longer than it takes to write. A round with a ringed lane is the check that sent the change back.',
  },
  issue: { shows: 'Each row is one piece of work: the pull requests that delivered the same issue, added up, so work split into several pull requests compares fairly with work done in one.' },
  size: { shows: 'The average pull request in each size band. Read down the rows: if checking time barely grows with size, small changes pay the same fixed cost as big ones.' },
  check: { shows: 'Each row is one CI check: how many rounds it ran in, how often it was the last to finish (the one everyone waited on), its total and typical time, how often it failed and how often it was flaky. The top row is the check to speed up first.' },
} satisfies Record<string, Explanation>;

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'Every figure here is a merged pull request, timed from the first prompt that started it to its merge. <b>The harness</b> is everything that checks the agent&rsquo;s work before it lands: reviews, tests and a browser check on the developer&rsquo;s machine, then CI on every push.';
