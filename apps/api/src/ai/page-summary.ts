import { TITLE_LENGTH } from '@cockpit/shared';
import { z } from 'zod';

/**
 * What a pasted link's page says of itself, and the reading of an answer that
 * decides whether it may be used at all ("Capture link summaries", issue 1853).
 *
 * Pure and here, as `note-texts.ts` is: every way an answer can be unusable
 * ends in a note with no summary and no source, a branch worth proving without
 * a model in the room.
 */

/** A page's title, one-sentence gist and 3 to 5 bullets, as the page said them. */
export interface PageSummary {
  title: string;
  gist: string;
  bullets: string[];
  language: string;
}

/** Either what the page says, or why nothing usable came back. */
export type PageRead = { page: PageSummary } | { notReadable: string };

/** One line each: a page cannot start a list or a heading in the description by what it writes. */
const oneLine = (max: number) =>
  z
    .string()
    .transform((text) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim())
    .pipe(z.string().min(1).max(max));

/**
 * **Strict, so a field the schema never asked for is refused whole**, whatever
 * the page told the model to add: a page can change its own summary and
 * nothing else (priority, due date and Panels are the clean-up's alone).
 */
const readableSchema = z.strictObject({
  readable: z.literal(true),
  title: oneLine(TITLE_LENGTH),
  gist: oneLine(500),
  bullets: z.array(oneLine(400)).min(3).max(5),
  language: oneLine(60),
});

/** The blocks of an answer, as far as this reads them: the SDK types predate the web fetch tool. */
export interface AnswerBlock {
  type: string;
  text?: string;
  content?: unknown;
}

/**
 * The page an answer holds, or why it holds none.
 *
 * **A page counts only if the web fetch ran and fetched**: an answer with no
 * successful fetch result, or whose fetch result is an error block, is not
 * readable however well it fits, since a model that answered without fetching
 * has made the page up.
 */
export function readPage(blocks: readonly AnswerBlock[], stopReason: string | null): PageRead {
  if (stopReason === 'refusal') return { notReadable: 'the model declined the page' };
  if (stopReason === 'pause_turn') return { notReadable: 'the answer was paused before it finished' };

  const fetched = blocks.filter((block) => block.type === 'web_fetch_tool_result');
  if (fetched.length === 0) return { notReadable: 'the page was not fetched' };
  if (fetched.some((block) => fetchFailed(block.content))) return { notReadable: 'the page could not be fetched' };

  const text = [...blocks].reverse().find((block) => block.type === 'text')?.text;
  if (typeof text !== 'string') return { notReadable: 'the answer carried no text' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { notReadable: 'the answer was not JSON' };
  }
  const read = readableSchema.safeParse(parsed);
  if (!read.success) return { notReadable: 'the answer was not a page summary' };
  const { title, gist, bullets, language } = read.data;
  return { page: { title, gist, bullets, language } };
}

/** A fetch result that is an error block, rather than a fetched document. */
function fetchFailed(content: unknown): boolean {
  if (typeof content !== 'object' || content === null) return true;
  const block = content as { type?: unknown; error_code?: unknown };
  return block.type === 'web_fetch_tool_error' || block.error_code !== undefined || block.type !== 'web_fetch_result';
}
