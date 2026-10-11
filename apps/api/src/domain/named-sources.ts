/**
 * The sources the core still names, here and nowhere else in the API ("Take
 * source names out of the shared contract", issue 927): every other source is
 * known only by the registry's list (`connectors/registry.ts`) and named by
 * its own manifest. Claude Code is named here until "Decide how Claude Code and
 * other outbound integrations sit behind a boundary" (issue 879).
 */

/**
 * A workspace's routine trigger - one Claude Code session started and
 * reported back, rather than an account signed in to (issue 569). It still
 * fills the same row a source account does: the store keys on `connectorId`
 * alone, not on what kind of thing is connected.
 */
export const CLAUDE_CODE = 'claude-code';

/** What Claude Code is called on screen. */
export const CLAUDE_CODE_NAME = 'Claude Code';

/** Each by what it is called on screen, as a registered connector's manifest says it of itself. */
export const NAMED_SOURCES: Readonly<Record<string, string>> = {
  [CLAUDE_CODE]: CLAUDE_CODE_NAME,
};
