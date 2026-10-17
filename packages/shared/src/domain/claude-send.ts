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

/**
 * Where a sent Run stands ("Follow on the row what Claude reports back", issue
 * 1160): `sent` until Claude reports in, then the stage it reports. Stored as
 * text with no CHECK, so a stage can be added without rebuilding the table;
 * the report is held to this list on write instead.
 */
export const CLAUDE_REPORTED_STAGES = ['on_it', 'ready', 'needs_you'] as const;
export type ClaudeReportedStage = (typeof CLAUDE_REPORTED_STAGES)[number];

/** The longest a link or a note a report carries may be. */
export const REPORT_LINK_LIMIT = 2048;
export const REPORT_NOTE_LIMIT = 1000;

/**
 * A link Claude reports for its session: `https` on claude.ai or one of its
 * subdomains, with no credentials in it - the only place the row's arrow may
 * open. Null for anything else.
 */
export function claudeSessionLink(value: unknown): string | null {
  const url = httpsLink(value);
  if (!url) return null;
  const host = url.hostname;
  return host === 'claude.ai' || host.endsWith('.claude.ai') ? url.href : null;
}

/** A link Claude reports for what it made: any `https` address with no credentials in it; null otherwise. */
export function claudeResultLink(value: unknown): string | null {
  return httpsLink(value)?.href ?? null;
}

function httpsLink(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > REPORT_LINK_LIMIT) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' ? url : null;
}

/** The longest prompt the window sends, which its text box also holds to. */
export const CLAUDE_PROMPT_LIMIT = 100_000;

/** A folder path, as typed: any length a path takes. Empty means none chosen. */
export const claudeFolderSchema = z.string().trim().max(1000);
