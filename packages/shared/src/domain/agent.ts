import { z } from 'zod';
import { workspaceNameSchema } from './item.js';
import { hexColorSchema, WORKSPACE_THEMES } from './workspace-themes.js';

/**
 * A named instruction for Claude, kept in the dock so it is reachable from
 * every Dashboard ("Keep your agents in a dock, and choose which each
 * dashboard shows", issue 570). Belongs to the Account, the same scope a Type
 * has and for the same reason: which agents you have says nothing about which
 * Workspace you are in.
 */

/** An Agent's name obeys exactly the rules a Workspace's does, by being the same schema. */
export const agentNameSchema = workspaceNameSchema;

/** The colours an Agent can wear — the palette's tints, the same set a Type wears. */
export const AGENT_COLORS: readonly string[] = WORKSPACE_THEMES.map((theme) => theme.tint);

/** The colour an Agent gets when every one in the palette is already taken. */
export const DEFAULT_AGENT_COLOR: string = AGENT_COLORS[0]!;

/** Only the palette's colours, refused on the way in the way a Type's are. */
export const agentColorSchema = hexColorSchema.refine((color) => AGENT_COLORS.includes(color), {
  message: 'an agent wears one of the palette colours',
});

/** The colour to give a new Agent: the first no live Agent is wearing. */
export function colorNoAgentIsUsing(taken: readonly string[]): string {
  return AGENT_COLORS.find((color) => !taken.includes(color)) ?? DEFAULT_AGENT_COLOR;
}

/** What an Agent runs on. One value today; a closed set because the dock has to draw something for it. */
export const AGENT_ENGINES = ['claude-code'] as const;
export const agentEngineSchema = z.enum(AGENT_ENGINES);
export type AgentEngine = z.infer<typeof agentEngineSchema>;

/**
 * The message a dropped Agent sends, as a template: `{title}`, `{description}`,
 * `{link}` and, where `asksForPrompt` is set, `{prompt}`. A cap well past
 * anything a prompt needs, so refusing a paste is not the first thing this does.
 */
export const agentMessageSchema = z.string().trim().max(4000);

export const agentSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  name: z.string(),
  color: z.string(),
  engine: agentEngineSchema,
  message: z.string(),
  /** Whether starting this Agent asks for a prompt before sending, to fill `{prompt}` with. */
  asksForPrompt: z.boolean(),
  /** Whether starting this Agent sets the Item In progress. */
  startsInProgress: z.boolean(),
  /** Where this Agent sits in the dock; ties break on `createdAt`. */
  position: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof agentSchema>;

/**
 * Which of an Account's Agents are hidden on one Dashboard ("Hiding and
 * showing are per dashboard", issue 570) - the row a hide writes and a show
 * removes.
 */
export const hiddenAgentSchema = z.object({
  dashboardId: z.string(),
  agentId: z.string(),
});
export type HiddenAgent = z.infer<typeof hiddenAgentSchema>;

/**
 * Ask Claude: the one Agent built into the dock rather than made by anybody
 * ("Keep your agents in a dock, and choose which each dashboard shows", issue
 * 570). It has no row of its own - nothing here can be edited, deleted, or
 * hidden on one Dashboard - so its name, colour and engine are fixed here
 * rather than stored, and what decides whether it is drawn at all is
 * `agentsShownOnDashboard` below.
 */
export const ASK_CLAUDE_ID = 'ask-claude';
export const ASK_CLAUDE_NAME = 'Ask Claude';
export const ASK_CLAUDE_COLOR: string = AGENT_COLORS[0]!;

/** One tile the dock draws: a made Agent, or the built-in Ask Claude. */
export type DockTile = { kind: 'agent'; agent: Agent } | { kind: 'ask-claude' };

/**
 * Every Agent a Dashboard shows, in the dock's order ("A dashboard shows
 * every agent except those hidden on it", issue 570). Pure: what is hidden
 * where, and whether Ask Claude is reachable at all, both arrive as plain
 * values rather than being read here.
 *
 * Ask Claude is appended rather than filtered in with the rest: it carries no
 * row of its own to be hidden per dashboard, only the two account-wide gates
 * (`askClaudeEnabled`) and per-workspace (`hasClaudeCodeConnection`) that
 * decide whether it exists on this Dashboard at all.
 */
export function agentsShownOnDashboard(params: {
  agents: readonly Agent[];
  hiddenAgentIds: readonly string[];
  askClaudeEnabled: boolean;
  hasClaudeCodeConnection: boolean;
}): DockTile[] {
  const tiles: DockTile[] = [];
  if (params.askClaudeEnabled && params.hasClaudeCodeConnection) {
    tiles.push({ kind: 'ask-claude' });
  }
  for (const agent of params.agents) {
    if (!params.hiddenAgentIds.includes(agent.id)) tiles.push({ kind: 'agent', agent });
  }
  return tiles;
}

/**
 * The message a dropped Agent sends, with an Item's own words in place of its
 * template's placeholders ("The message sent is the agent's template with the
 * Item's words in it", issue 570). Pure, and unaware of where `link` or
 * `prompt` came from.
 *
 * **Trimmed once, on the whole result**, not on each placeholder: a template
 * that puts a blank description on its own line - `{title}\n\n{description}` -
 * would otherwise leave that line and its break behind for an Item that has
 * none.
 *
 * **One pass over the template, matching every placeholder at once**, rather
 * than one `replaceAll` per placeholder run in sequence. Four sequential
 * passes would let an Item's own words re-trigger a later pass - a title of
 * `Fix {description} bug` would leave a literal `{description}` in the
 * string for the next pass to find and fill a second time - and a raw string
 * handed to `replaceAll` as its *replacement* is itself read for `$&`/`$$`/
 * `` $` ``/`$'` patterns, so a title of `Ship $&` would come out as `{title}`
 * rather than the words actually typed. A replacer function sidesteps both:
 * it runs once per placeholder actually in the template, and whatever it
 * returns is inserted verbatim.
 */
const PLACEHOLDER = /\{title\}|\{description\}|\{link\}|\{prompt\}/g;

export function agentMessageFor(
  agent: Pick<Agent, 'message'>,
  item: { title: string; description: string | null; link: string },
  prompt?: string,
): string {
  return agent.message
    .replace(PLACEHOLDER, (placeholder) => {
      switch (placeholder) {
        case '{title}':
          return item.title;
        case '{description}':
          return item.description ?? '';
        case '{link}':
          return item.link;
        default:
          return prompt ?? '';
      }
    })
    .trim();
}
