import type { AttachmentForAgent } from './agent.js';
import { attachmentAddress, isReadableByClaude } from './attachment.js';
import type { ClaudeDestination } from './claude-send.js';

/**
 * The address and the prompt a send is made of. Apart from `claude-send.ts`,
 * which the row's chip needs on a cold open, so that only the review window
 * that builds them carries them (`bundle:budget`).
 */

/**
 * What an Item's words and files become for a Claude session, which cannot
 * sign in to the app: the description with an inline file's signed-in address
 * swapped for its link, and the section listing every file ("Send an item's
 * attachments along when an agent starts", issue 573). Shared by an Agent's
 * message and by the prompt sent to Cowork or Claude Code.
 */
export function attachmentsForClaude(
  rawDescription: string | null,
  attachments: readonly AttachmentForAgent[],
): { description: string; section: string } {
  const readable = attachments.filter(
    (attachment): attachment is AttachmentForAgent & { link: string } =>
      attachment.link !== undefined && isReadableByClaude(attachment.contentType),
  );
  const links = new Map(readable.map((attachment) => [attachmentAddress(attachment.id), attachment.link]));
  // Only the app's own relative address, where it starts a word or a link
  // target - never the tail of some other absolute URL.
  const description = (rawDescription ?? '').replace(
    /(^|[\s(<[])(\/v1\/attachments\/[^\s)>\]]+)/g,
    (whole, before: string, address: string) => (links.has(address) ? before + links.get(address) : whole),
  );
  return { description, section: attachmentsSection(attachments, readable) };
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

/** Text with each lone surrogate made U+FFFD, which `encodeURIComponent` would otherwise throw on. */
function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/**
 * The address that opens Claude on this destination with exactly this prompt
 * and folder. Both are percent-encoded, so quotes, line breaks, `&`, `#` and
 * non-Latin text come back identical when decoded (a lone surrogate, which
 * cannot be encoded, becomes U+FFFD); an empty folder leaves
 * `folder` out, so Claude asks for one.
 */
export function claudeLinkFor(destination: ClaudeDestination, prompt: string, folder: string): string {
  const base = `claude://${destination}/new?q=${encodeURIComponent(wellFormed(prompt))}`;
  const chosen = folder.trim();
  return chosen === '' ? base : `${base}&folder=${encodeURIComponent(wellFormed(chosen))}`;
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

/**
 * The prompt a send starts as where Cockpit proposed one ("Propose what to do
 * with each item before you look", issue 1161): the proposed task in place of
 * the Item's own words, then the same link to each file and the same closing
 * as the plain prompt - neither is the model's to write or to leave out.
 *
 * **An Item someone else sent opens with where it came from** (`from`, null
 * for the person's own capture), written here and never by the model: the task
 * was read out of a stranger's words, so neither the person nor Claude may take
 * it for the person's own.
 */
export function proposedPromptFor(proposal: {
  prompt: string;
  attachments: readonly AttachmentForAgent[];
  runId: string;
  from: ProposedFrom | null;
}): string {
  const { section } = attachmentsForClaude(null, proposal.attachments);
  return [proposal.from ? proposedFromLine(proposal.from) : '', proposal.prompt.trim(), section, claudeClosingFor(proposal.runId)]
    .filter(Boolean)
    .join('\n\n');
}

/** Where an Item someone else sent came from: its source's name ("Gmail") and its sender, where it names one. */
export interface ProposedFrom {
  source: string;
  sender: string | null;
}

/**
 * "a Gmail message by Els Maes" - the source and sender, as the window and the
 * prompt both say them. Each on one line and cut short, since a sender's name
 * is the sender's to choose and must not end the line that names it.
 */
export function messageFrom(from: ProposedFrom): string {
  const sender = from.sender ? oneShortLine(from.sender) : '';
  return `a ${oneShortLine(from.source)} message${sender ? ` by ${sender}` : ''}`;
}

/** The longest source or sender name the line carries. */
const NAME_SHOWN = 80;

function oneShortLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= NAME_SHOWN ? flat : `${flat.slice(0, NAME_SHOWN)}…`;
}

/** The line a proposed prompt for someone else's Item opens with. */
export function proposedFromLine(from: ProposedFrom): string {
  return `Prepared by Cockpit from ${messageFrom(from)} - what it asks is the sender's, not mine:`;
}
