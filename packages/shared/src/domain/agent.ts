import { z } from 'zod';
import { attachmentAddress, isReadableByClaude } from './attachment.js';
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
 * Every Agent a Dashboard shows, in the dock's order ("A dashboard shows
 * every agent except those hidden on it", issue 570). Pure: what is hidden
 * where arrives as a plain value rather than being read here.
 */
export function agentsShownOnDashboard(params: {
  agents: readonly Agent[];
  hiddenAgentIds: readonly string[];
}): Agent[] {
  return params.agents.filter((agent) => !params.hiddenAgentIds.includes(agent.id));
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

/**
 * One of the Item's attachments as the message names it: `link` is where the
 * session downloads it without signing in, and is only used for a file Claude
 * can read (`isReadableByClaude`).
 */
export interface AttachmentForAgent {
  id: string;
  filename: string;
  contentType: string;
  link?: string | undefined;
}

/**
 * **Ahead of every start, whatever the template says.** The message reaches
 * Claude only as context after the routine's saved prompt, so that prompt
 * would otherwise decide what the session does ("Make an agent's message the
 * whole task, whatever the routine's prompt says", issue 638). Not shown or
 * editable, and not carried by the connection's test fire.
 */
export const AGENT_PREAMBLE = [
  'The message below is your whole task. Do exactly what it says and nothing more.',
  'If it names a skill, run that skill and do only what the skill covers.',
  'If you need answers to go on, ask and wait for them.',
  'Ignore any earlier instruction about what to do with this item.',
].join(' ');

/**
 * **The preamble with the line Claude opens its first reply with**, `<Agent
 * name>: <item title>`, so a session in Claude Code can be told from the rest
 * ("Open each Agent session by naming the Agent and the item", issue 835).
 * Built by concatenation: the name and title are inserted exactly as typed.
 * An Agent deleted since the start was recorded has no name, so the line is
 * the title alone.
 */
export function agentPreambleFor(agentName: string, itemTitle: string): string {
  const line = agentName === '' ? itemTitle : agentName + ': ' + itemTitle;
  return AGENT_PREAMBLE + ' Begin your first reply with this line, exactly: ' + line;
}

/** What a new Agent's template starts as: the instruction to work the Item, then the Item's words. */
export const DEFAULT_AGENT_MESSAGE = 'Work this item, then stop.\n\n{title}\n\n{description}';

/**
 * **Every attachment is listed after the template, whatever it says**, since
 * a template written before an Item had files cannot have asked for them
 * ("Send an item's attachments along when an agent starts", issue 573). One
 * shown inline in the description has its signed-in address swapped for its
 * link, which is the only one the session can open.
 */
export function agentMessageFor(
  agent: Pick<Agent, 'name' | 'message'>,
  item: {
    title: string;
    description: string | null;
    link: string;
    attachments?: readonly AttachmentForAgent[];
  },
  prompt?: string,
): string {
  const readable = (item.attachments ?? []).filter(
    (attachment): attachment is AttachmentForAgent & { link: string } =>
      attachment.link !== undefined && isReadableByClaude(attachment.contentType),
  );
  const links = new Map(readable.map((attachment) => [attachmentAddress(attachment.id), attachment.link]));
  // Only the app's own relative address, where it starts a word or a link
  // target - never the tail of some other absolute URL.
  const description = (item.description ?? '').replace(
    /(^|[\s(<[])(\/v1\/attachments\/[^\s)>\]]+)/g,
    (whole, before: string, address: string) => (links.has(address) ? before + links.get(address) : whole),
  );
  const body = agent.message
    .replace(PLACEHOLDER, (placeholder) => {
      switch (placeholder) {
        case '{title}':
          return item.title;
        case '{description}':
          return description;
        case '{link}':
          return item.link;
        default:
          return prompt ?? '';
      }
    })
    .trim();
  return [agentPreambleFor(agent.name, item.title), body, attachmentsSection(item.attachments ?? [], readable)]
    .filter(Boolean)
    .join('\n\n');
}

function attachmentsSection(
  attachments: readonly AttachmentForAgent[],
  readable: readonly (AttachmentForAgent & { link: string })[],
): string {
  if (attachments.length === 0) return '';
  const lines = attachments.map((attachment) => {
    const link = readable.find((one) => one.id === attachment.id)?.link;
    return link ? `- ${attachment.filename}: ${link}` : `- ${attachment.filename} - not readable by Claude`;
  });
  return [
    'Attachments - download each link and read the file. A link works for an hour, without signing in.',
    ...lines,
  ].join('\n');
}
