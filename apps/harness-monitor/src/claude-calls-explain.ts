import type { CallGroup } from './claude-calls-page';
import type { Explanation } from './explain';

/** What each tile and panel of Cockpit's Claude calls shows, how to read it and what to look for, written for a reader who knows software but not this repository. */
export const WHAT = {
  spent: {
    shows: 'What Cockpit&rsquo;s own calls to Claude cost over the period.',
    read: 'Each call&rsquo;s dollars are production&rsquo;s own price for it, Anthropic&rsquo;s API rate for its tokens, which is what the key is billed at; the Monitor never reprices them. A call with no price is left out, never counted as free.',
    look: 'Spend should follow use, since every call is one person or job using a feature. When it grows faster than use, colour by feature or model to see which got dearer.',
  },
  calls: {
    shows: 'How many calls Cockpit made to Claude over the period, priced or not.',
    read: 'The second line is the average priced call: Spent divided by the calls that have a price.',
    look: 'An average that jumps while the count holds means each call got dearer: a bigger model, a longer prompt or more output. Colour by model or feature to see which.',
  },
  previous: {
    shows: 'How Spent compares with the same number of days just before the period.',
    read: 'A rise reads red, a fall green, and under it what the period before cost. A change under half a cent reads <i>No change</i>. All time has no period before it, so the tile is not drawn.',
    look: 'A rise that use does not explain: Largest changes names the environment, feature, model or starter that got dearer.',
  },
  where: {
    shows: 'The period&rsquo;s spend as one bar, cut by what the sentence colours it by: environment, feature, model or starter.',
    read: 'Each segment is as wide as its share, and the list gives each one&rsquo;s dollars and percentage. Every call made with Cockpit&rsquo;s Anthropic key is here, from production, staging, CI and local development. Workers AI and Claude Code routines are billed elsewhere and are not.',
    look: 'Production is what the product costs its users to run; the rest is the cost of building and testing it. Compare with the Anthropic Console&rsquo;s Cost page for the same days: a gap is spend no call recorded.',
  },
  changes: {
    shows: 'The four colours whose spend moved most against the same number of days before, the biggest change first.',
    read: 'Each line gives the change, then the dollars before and now: ▲ is up, ▼ down. A change under half a cent is left out. It is not drawn for all time, which has nothing before it.',
    look: 'A new feature, or a feature&rsquo;s new prompt, shows here first. One line far larger than the rest is the one to explain.',
  },
  perDay: {
    shows: 'What the calls cost each day of the period, a line per colour of the sentence and a dashed line for the total.',
    read: 'Every day of the period has a point, zero on a day with no call. Point at a dot for its dollars, or at a name in the key to pick its line out.',
    look: 'CI&rsquo;s line jumps on the days contract tests ran, which is expected. A production line climbing steadily is either more use or calls getting dearer; the Calls tile tells the two apart.',
  },
} satisfies Record<string, Explanation>;

/** What each grouping's table shows. */
export const TABLES: Record<CallGroup, Explanation> = {
  day: { shows: 'Each row is a day, newest first: its calls, a bar coloured as the sentence says, the dollars of each colour and the total.' },
  feature: { shows: 'Each row is a feature of the app that calls Claude, such as cleaning up a note or choosing a panel, dearest first, with its calls and their dollars in each colour.' },
  environment: { shows: 'Each row is where calls were made: production first, then staging, CI and local development.' },
  pr: {
    shows:
      'Each row is a pull request whose CI contract tests called Claude, newest first, with how many runs made the calls; Sessions opens its Claude Code costs. <b>Nightly and by-hand runs on main</b> gathers CI&rsquo;s other calls, and <b>No pull request</b> every call made outside CI.',
  },
  startedBy: { shows: 'Each row is what set calls off, dearest first: a person in the app, a connector such as Teams, MCP or a CI run. <b>Not recorded</b> is a call stored without one.' },
};

/** What follows the question on the page's lead: the words a newcomer will not know. */
export const LEAD_MORE =
  'These are the calls Cockpit&rsquo;s own features make to Claude with Cockpit&rsquo;s Anthropic key, not the Claude Code sessions that build it, which Claude Code costs counts. An <b>environment</b> is where a call was made: production for real users, staging, CI&rsquo;s contract tests or a developer&rsquo;s machine. A <b>starter</b> is what set it off: a person in the app, a connector such as Teams, MCP or a CI run.';
