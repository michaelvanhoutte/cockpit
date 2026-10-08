import { z } from 'zod';

/**
 * A source account a Workspace has connected - a Microsoft Teams sign-in
 * ("Connect a Microsoft Teams source account", issue 485), a Claude Code
 * routine trigger (issue 569), and whatever else is connected later.
 *
 * **The credential is never part of this shape.** It is sealed in the
 * Workspace's own store and read by nothing that answers a browser, so the
 * wire carries only what a row has to say: which source it is, whose account
 * at that source, when it was connected, and when it last worked.
 */
export const TEAMS = 'teams';

/**
 * A Gmail mailbox, whose conversations labelled `Cockpit` - or starred -
 * become tasks ("Connect a Gmail account to a workspace, and disconnect it",
 * issue 724). Its Items carry the source `mail`, which reads "Gmail" too.
 */
export const GMAIL = 'gmail';

/**
 * The one mark a Gmail connection follows ("Connect Gmail by star, and bring
 * in conversations starred from then on", issue 822): the `Cockpit` label, or
 * the star - which is what Outlook's flag for follow-up sets on Gmail mail.
 * The label is the one chosen to start, and every connection made before the
 * star existed follows it.
 */
export const GMAIL_MARKS = ['label', 'star'] as const;
export type GmailMark = (typeof GMAIL_MARKS)[number];
export const gmailMarkSchema = z.enum(GMAIL_MARKS);

/**
 * A workspace's routine trigger - one Claude Code session started and
 * reported back, rather than an account signed in to (issue 569). It still
 * fills the same row a source account does: the store keys on `connectorId`
 * alone, not on what kind of thing is connected.
 */
export const CLAUDE_CODE = 'claude-code';

/** What a connector is called on screen; its id is what the store keys on. */
export function connectorNamed(connectorId: string): string {
  if (connectorId === TEAMS) return 'Microsoft Teams';
  // An Item's source is `mail`, the connection's connector `gmail`: both are
  // Gmail to whoever reads them (issue 724).
  if (connectorId === GMAIL || connectorId === 'mail') return 'Gmail';
  if (connectorId === CLAUDE_CODE) return 'Claude Code';
  return connectorId;
}

export const sourceAccountSchema = z.object({
  id: z.string(),
  connectorId: z.string(),
  /**
   * Who the source says this account is - a name where it gave one, the
   * address it signs in with otherwise. Read off the identity the source
   * returned rather than typed here, so two accounts of one source can be
   * told apart in the list.
   */
  displayName: z.string(),
  connectedAt: z.iso.datetime(),
  /**
   * The last time this connection was proven to still work - connecting or
   * reconnecting it counts, and so does pressing Test again (issue 569).
   * `null` for a connector nothing ever tests after connecting: what "last
   * worked" means is specific to a connector that can be tested at all.
   */
  lastTestedAt: z.iso.datetime().nullable(),
  /**
   * Why Claude last refused to start a session through this connection, in
   * words, until one starts again ("Drop an agent on an item to start a
   * Claude Code session on it", issue 571) - null while nothing says it is
   * failing. Defaulted so an answer from before this field reads as not
   * failing rather than as broken.
   */
  failingBecause: z.string().nullable().default(null),
  /** What a Gmail connection follows (issue 822); absent for every other connector. */
  follows: gmailMarkSchema.optional(),
});
export type SourceAccount = z.infer<typeof sourceAccountSchema>;

export const sourceAccountListSchema = z.object({
  sourceAccounts: sourceAccountSchema.array(),
});
export type SourceAccountList = z.infer<typeof sourceAccountListSchema>;

/**
 * A connector the registry holds and a person can sign in to, as the
 * Connections window draws its card ("List the registry's connectors in the
 * Connections window", issue 894): the manifest's own name and text, nothing
 * the connector keeps to itself.
 */
export const registeredConnectorSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  cardText: z.string(),
  /** Whether connecting asks the person something before it leaves for the source. */
  asksFirst: z.boolean(),
});
export type RegisteredConnector = z.infer<typeof registeredConnectorSchema>;

export const registeredConnectorListSchema = z.object({
  connectors: registeredConnectorSchema.array(),
});
export type RegisteredConnectorList = z.infer<typeof registeredConnectorListSchema>;

/**
 * What the form posts to connect - or, pressed again with a new token, to
 * edit - a workspace's Claude Code routine (issue 569): the routine's own
 * trigger address and the token it was given to fire with. Never a command:
 * a client-postable command payload is public API by convention
 * (`commandSchemas`), and this one carries a bare token on its way to being
 * sealed.
 */
export const connectClaudeCodeSchema = z.object({
  routineUrl: z.string().min(1).max(2048),
  token: z.string().min(1).max(4096),
});
export type ConnectClaudeCode = z.infer<typeof connectClaudeCodeSchema>;

/**
 * What connecting, editing or testing a Claude Code connection answers: Claude
 * accepted the test session, or it did not and here is why, in words a person
 * typed the wrong thing or hit a limit can read (issue 569, rule 1). Nothing
 * more than that on success - the row itself is read back from the source
 * accounts list, the one place any of it is drawn.
 */
export const claudeCodeOutcomeSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true) }),
  z.object({ accepted: z.literal(false), message: z.string() }),
]);
export type ClaudeCodeOutcome = z.infer<typeof claudeCodeOutcomeSchema>;

/**
 * What the repository needs for its Claude Code sessions to say when they are
 * waiting on you ("See on the item when Claude is waiting on you", issue
 * 572): where the hooks post, the connection's secret they post with, the
 * domain the routine's network settings must allow, and when a hook last
 * reached Cockpit - null where none ever has.
 */
export const claudeCodeHooksSchema = z.object({
  url: z.url(),
  secret: z.string(),
  domain: z.string(),
  lastArrivedAt: z.iso.datetime().nullable(),
});
export type ClaudeCodeHooks = z.infer<typeof claudeCodeHooksSchema>;

/**
 * A second name for the session, beside the `session_id` a hook's body
 * carries: the cloud session's id, from an environment variable Anthropic does
 * not document - so it is empty wherever Claude Code does not set it, and the
 * body's own id is always matched as well.
 */
export const REMOTE_SESSION_HEADER = 'x-claude-code-remote-session';
const REMOTE_SESSION_VARIABLE = 'CLAUDE_CODE_REMOTE_SESSION_ID';

/**
 * The `.claude/settings.json` fragment that reports a session's state: `Stop`
 * says it is waiting on you, `UserPromptSubmit` that it is working again.
 * Pure, so the form draws exactly what a test reads.
 */
export function claudeCodeHooksSnippet(hooks: Pick<ClaudeCodeHooks, 'url' | 'secret'>): string {
  const hook = {
    type: 'http',
    url: hooks.url,
    headers: {
      Authorization: `Bearer ${hooks.secret}`,
      [REMOTE_SESSION_HEADER]: `$${REMOTE_SESSION_VARIABLE}`,
    },
    allowedEnvVars: [REMOTE_SESSION_VARIABLE],
    timeout: 10,
  };
  return JSON.stringify(
    { hooks: { Stop: [{ hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook] }] } },
    null,
    2,
  );
}
