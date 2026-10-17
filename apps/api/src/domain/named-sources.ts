/**
 * The sources the core still names, here and nowhere else in the API ("Take
 * source names out of the shared contract", issue 927): every other source is
 * known only by the registry's list (`connectors/registry.ts`) and named by
 * its own manifest. Claude Code is named here until "Decide how Claude Code and
 * other outbound integrations sit behind a boundary" (issue 879).
 */

/**
 * A workspace's Claude Code routine trigger (issue 569), retired with the
 * agents' dock ("Retire the agents' dock and routines, keeping what each agent
 * knew", issue 1165). Named still because rows of it are what the retirement
 * disconnects (`retireAgents`), and one not yet disconnected is listed by its
 * name. It fills the same row a source account does: the store keys on
 * `connectorId` alone, not on what kind of thing is connected.
 */
export const CLAUDE_CODE = 'claude-code';

/** What Claude Code is called on screen. */
export const CLAUDE_CODE_NAME = 'Claude Code';

/** Each by what it is called on screen, as a registered connector's manifest says it of itself. */
export const NAMED_SOURCES: Readonly<Record<string, string>> = {
  [CLAUDE_CODE]: CLAUDE_CODE_NAME,
};
