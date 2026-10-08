import type { GmailMark } from '@cockpit/shared';

/**
 * The sources the core still names, here and nowhere else in the API ("Take
 * source names out of the shared contract", issue 927): every other source is
 * known only by the registry's list (`connectors/registry.ts`) and named by
 * its own manifest.
 *
 * | Source | Named here until |
 * |---|---|
 * | Gmail | it moves onto the connector SDK ("Move Gmail out of the core, onto the connector SDK", issue 875) |
 * | Claude Code | "Decide how Claude Code and other outbound integrations sit behind a boundary" (issue 879) |
 */

/** A Gmail mailbox, whose conversations labelled `Cockpit` - or starred - become tasks (issue 724). Its Items are stored and served under this id. */
export const GMAIL = 'gmail';

/** What a Gmail connection's row says it follows, by mark (issue 822) - the words its row has always read. */
export const GMAIL_FOLLOWS_LABEL: Readonly<Record<GmailMark, string>> = {
  label: 'label Cockpit',
  star: 'starred',
};

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
  [GMAIL]: 'Gmail',
  [CLAUDE_CODE]: CLAUDE_CODE_NAME,
};
