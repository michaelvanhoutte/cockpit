import { z } from 'zod';

/**
 * Sending an Item to Cowork or Claude Code with its prompt reviewed first
 * ("Send an item to Cowork or Claude Code with its prompt reviewed first",
 * issue 1159). A send is a Run recorded as *Sent* before Claude's desktop app
 * is opened at a `claude://` address carrying the prompt and the folder.
 */

export const CLAUDE_DESTINATIONS = ['cowork', 'code'] as const;
export const claudeDestinationSchema = z.enum(CLAUDE_DESTINATIONS);
export type ClaudeDestination = z.infer<typeof claudeDestinationSchema>;

/** How a destination is named on a button and in a chip. */
export const CLAUDE_DESTINATION_NAMES: Record<ClaudeDestination, string> = {
  cowork: 'Cowork',
  code: 'Code',
};

/** A folder path, as typed: any length a path takes. Empty means none chosen. */
export const claudeFolderSchema = z.string().trim().max(1000);
