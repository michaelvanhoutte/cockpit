import { z } from 'zod';
import { attachmentsForClaude, type AttachmentForAgent } from './agent.js';

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

/** Where a Run stands. Only `sent` exists until Claude reports back, which adds the rest. */
export const claudeStageSchema = z.string().min(1).max(40);

/** A folder path, as typed: any length a path takes. Empty means none chosen. */
export const claudeFolderSchema = z.string().trim().max(1000);

/** The prompt, as long as the window lets it be. */
export const claudePromptSchema = z.string().trim().min(1).max(100_000);

/**
 * The address that opens Claude on this destination with exactly this prompt
 * and folder. Both are percent-encoded, so quotes, line breaks, `&`, `#` and
 * non-Latin text come back identical when decoded; an empty folder leaves
 * `folder` out, so Claude asks for one.
 */
export function claudeLinkFor(destination: ClaudeDestination, prompt: string, folder: string): string {
  const base = `claude://${destination}/new?q=${encodeURIComponent(prompt)}`;
  const chosen = folder.trim();
  return chosen === '' ? base : `${base}&folder=${encodeURIComponent(chosen)}`;
}

/**
 * The longest address the window opens. Measured on Windows by launching
 * `claude://` addresses of growing length: one of 31,041 characters opened
 * and one of 33,041 failed to start, consistent with the 32,767-character command
 * line limit of the process the operating system starts for the link. The
 * margin keeps clear of it, and a prompt this long is far past what is
 * reviewed in a window. Other systems were not measured.
 */
export const MAX_CLAUDE_LINK_LENGTH = 30_000;

/**
 * Ends every prompt, whatever it says before: stop before anything that sends,
 * posts, buys or confirms, and report back to Cockpit naming this run.
 */
export function claudeClosingFor(runId: string): string {
  return [
    'Stop before anything that sends, posts, buys or confirms, and ask me first.',
    `When you are done, or need me, report back to Cockpit through its connection, naming this run: ${runId}`,
  ].join(' ');
}

/**
 * The prompt a send starts as: the Item's words, a link to each of its files,
 * and the closing. No empty line is left where there is no description.
 */
export function plainPromptFor(item: {
  title: string;
  description: string | null;
  attachments: readonly AttachmentForAgent[];
  runId: string;
}): string {
  const { description, section } = attachmentsForClaude(item.description, item.attachments);
  return [item.title, description.trim(), section, claudeClosingFor(item.runId)].filter(Boolean).join('\n\n');
}
