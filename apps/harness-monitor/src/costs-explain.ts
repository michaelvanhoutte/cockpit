import type { Explanation } from './explain';
import type { Group } from './costs';

/** What each panel of Claude Code costs and of a pull request's page shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
export const WHAT = {
  where: {
    shows: 'The period&rsquo;s Claude Code spend as one bar, cut by what the sentence colours it by: phase, engineer, model, where the work ran, or what became of its pull request.',
    read: 'Each segment is as wide as its share, and the list under the bar gives each one&rsquo;s dollars. The phases run in the order of the process: <b>Outside the process</b> (work no process step claims, such as a question or a one-off fix), <b>Scoping &amp; planning</b>, <b>Building</b>, <b>Local code review</b> and <b>Local security review</b> (the reviews a session runs itself), <b>After push</b> (everything after the first push: answering CI and review, rechecking), <b>CI reviews</b> and <b>Process review</b> (the agent reviewing its own sessions and the process). CI reviews counts only the <code>@claude</code> runs in GitHub Actions; Claude Code Review runs on Anthropic&rsquo;s side, is billed through claude.ai and is <b>not measured</b>. By outcome, <b>On main</b> is work on <code>main</code> that no pull request is credited with. The note beside the heading counts the table&rsquo;s rows and their median.',
    look: 'Building is the change itself; every other phase is what the process spends around it. A large After push share means changes keep coming back from CI or review to be fixed, which the Cycle time tab counts in rounds. Unphased spend after 21 Sep 2026 is a recording gap: an older hook that could not place the request, not a phase of its own.',
  },
  perDay: {
    shows: 'What Claude Code cost each day of the period, one line per colour of the sentence and a dashed line for the total.',
    read: 'Each point is a Belgian day; a day with no request sits at zero rather than being skipped. Point at a dot for its dollars, or at a name in the key to pick its line out.',
    look: 'Spikes are the days to explain: the By day rows below give each day&rsquo;s tokens, and choosing each pull request as the rows says what work spent them. A line that climbs while the others hold is a phase, model or engineer whose spend is growing.',
  },
  tokensPerDay: {
    shows: 'How many tokens Claude Code used each day, with the same lines as Cost per day.',
    read: 'Every request counts, priced or not: its input, output, cache write and cache read tokens added together. Cache reads, context the model has already been sent and reads again at a tenth of the input price, are usually most of the count.',
    look: 'Tokens rising while cost holds usually means more of the work is read from the cache, which is cheap. A model with a line here and none in Cost per day has no price yet; the warning at the top of the page names it.',
  },
  trends: {
    shows: 'Three measures of whether the same work is getting dearer: how much a session carries before it starts, how big a pull request is, and what a line of change costs.',
    read: 'Each point is a day, or a week from Monday over 90 days or all time. A break in a line is a day or week with nothing to measure, not a zero.',
    look: 'Read them together. Cost per line rising while pull requests shrink can be the same fixed cost spread over less change; rising while size holds, beside a growing starting context, means the harness itself is getting heavier.',
  },
  startingContext: {
    shows: 'How many tokens a session holds at its first request: the instructions, tools and memory every session loads before it does any work.',
    read: 'The median, over the sessions started that day or week, of the first main-agent request&rsquo;s input, cache write and cache read tokens; output and subagents are left out. It follows the period, the engineer and the model only.',
    look: 'A step up marks the day something was added to what every session loads, such as a longer instructions file, a skill or a tool. That context is read again on every request, so a rise here raises the cost of every request after it.',
  },
  prSize: {
    shows: 'How much a typical merged pull request changes.',
    read: 'The median of lines added plus removed over the pull requests merged that day or week, leaving out lockfiles, snapshots and generated files. A pull request not yet sized is left out.',
    look: 'It is the context for the chart below: a smaller pull request still pays the fixed cost of scoping, reviews and CI, so it costs more a line even when nothing got dearer.',
  },
  costPerLine: {
    shows: 'What a thousand lines of merged change cost in Claude Code, in total and in each phase.',
    read: 'The pull requests merged that day or week: their whole cost, first request to last, divided by thousands of lines added plus removed. One with no counted lines is left out of both. The dashed line is every phase together. Phases were first recorded on 21 Sep 2026, so before it only the total and Unphased are drawn.',
    look: 'The total rising means the same amount of change costs more to land; the phase lines say where. After push rising means more fixing after CI and review, and a review phase rising means reviews got dearer or more frequent.',
  },
  byCategory: {
    shows: 'This pull request&rsquo;s Claude Code cost in each phase of the process.',
    read: 'Each bar is scaled to the dearest phase. Beside the dollars, how many requests it took; Local code review counts its requests at each review level, strongest first. Only requests inside the period chosen above count, so an older pull request may show part of its cost: choose All time for the whole.',
    look: 'After push outweighing Building means answering CI and review cost more than writing the change; its row on the Cycle time tab says how many rounds it took.',
  },
  sessions: {
    shows: 'Each row is one Claude Code session that worked on this pull request&rsquo;s branch, dearest first, with where it ran, its models, requests, tokens and cost. Under it, its main agent and each subagent it started, with their share of the session&rsquo;s cost.',
  },
} satisfies Record<string, Explanation>;

/** What each grouping's table shows. */
export const TABLES: Record<Group, Explanation> = {
  day: { shows: 'Each row is a day, newest first unless Total sorts them: its cost, a bar coloured as the sentence says (point at it for each colour&rsquo;s dollars), and its tokens of each kind, priced or not. A day with requests no price covers says how many beside its total.' },
  pr: {
    shows:
      'Each row is one pull request, open ones first, then merged ones newest first unless Total sorts them, with its issue, author, merge date and lines changed; its title opens it on GitHub and Sessions opens its own page here. A branch no pull request names keeps its own row, reading <i>linking&hellip;</i> until the nightly rebuild has seen linking catch up, then the issue its work was credited to (<i>No issue</i> for a pull request that closes none, <i>several issues</i> for more than one), or <i>unattributed</i> where nothing was.',
  },
  issue: { shows: 'Each row is one issue, its pull requests&rsquo; costs added up, a child issue&rsquo;s under its parent, so work split into several pull requests compares fairly with work done in one. Scoping, building, local review, After push and Process review work on a branch no pull request names counts under the pull request of the nearest request in its session that has one. <b>No issue</b> gathers pull requests that close none; <b>Unattributed</b> is spend no pull request claims, including work newer than the nightly rebuild that credits it.' },
  engineer: { shows: 'Each row is an engineer, the author of the pull requests the spend went into or was credited to, dearest first. <b>Unattributed</b> is spend no pull request claims, including work newer than the nightly rebuild that credits it.' },
  category: { shows: 'Each row is a phase, in the order of the process unless Total sorts them, its bar cut by what the sentence colours it by, so a row reads who spent the phase, on which model, where, or into which outcome.' },
};

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'Every figure is Claude Code&rsquo;s requests on this repository, priced at Anthropic&rsquo;s per-token API rates (<b>list price</b>) whatever plan paid for them, so a dollar here measures the work, not an invoice. A <b>phase</b> is the step of the process a request was made in, from scoping to review, read from where its session stood; <b>Unphased</b> is spend no phase claims, nearly all from before phases were recorded on 21 Sep 2026. The <b>main session</b> is the agent a person or a CI job talks to; a <b>subagent</b> is a helper it starts for one task, such as a search or a review.';
