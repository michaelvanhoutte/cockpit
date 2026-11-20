import { firstWebLink, wordsBesideTheLink, type Item, type ReadPastedLinkCommand } from '@cockpit/shared';
import type { AiService, CallFor, PageSummary } from '../ai/index.js';
import type { Env } from '../env.js';
import { messageLinks } from '../connectors/registry.js';
import { WEB } from '../domain/named-sources.js';

/**
 * Reading the web page or PDF a pasted link names, as a step of the clean-up
 * job ("Capture link summaries", issue 1853), after the step that reads a Teams
 * link. The model fetches nothing here and sees the note only as a hint for the
 * summary's language: the summary call carries the link, and the job puts the description
 * together from its answer and the clean-up's, so a page can change its own
 * summary and nothing else.
 */

/** How long an Item's own link may be (`capturedFromSchema.sourceLink`). */
const SOURCE_LINK_LENGTH = 2_000;

/**
 * The link of a note the job would read as a page: the first web link of an
 * Own note - typed, shared from the Android browser or captured over MCP, never
 * an app's capture - that
 * no connector declared and an Item's own link can hold. A note with a source
 * link is never read again.
 */
export function webLinkIn(
  env: Env,
  item: Pick<Item, 'source' | 'capturedMessage' | 'sourceId' | 'sourceLink'>,
): string | null {
  const own = (item.source === 'internal' && item.sourceId === null) || item.source === 'mcp';
  if (!own || item.sourceLink !== null) return null;
  const link = firstWebLink(item.capturedMessage, messageLinks(env));
  return link !== null && link.length <= SOURCE_LINK_LENGTH ? link : null;
}

/** What the page makes of the Item, for `read_pasted_link`, with what it said. */
export interface WebRead extends Pick<ReadPastedLinkCommand, 'capturedFrom' | 'capturedMessage'> {
  page: PageSummary;
  /** What the person typed beside the link, empty for a bare link. */
  wordsBeside: string;
}

/**
 * The page the note's link names, or null where it cannot be read, which
 * leaves the note as typed. **A call that fails throws, so the queue tries the
 * job again, unless this is its last try**: then the page counts as not
 * readable, as a Teams read does.
 */
export async function readTheWebPage(
  ai: AiService,
  item: Pick<Item, 'capturedMessage'>,
  link: string,
  callFor: CallFor,
  lastAttempt: boolean,
): Promise<WebRead | null> {
  const captured = item.capturedMessage ?? link;
  const wordsBeside = wordsBesideTheLink(captured, link);
  let read;
  try {
    read = await ai.summarisePage(link, wordsBeside, callFor);
  } catch (error) {
    if (!lastAttempt) throw error;
    console.log(
      JSON.stringify({ level: 'warn', message: 'a pasted link was not read on the last try', data: error instanceof Error ? error.message : String(error) }),
    );
    return null;
  }
  if (!('page' in read)) return null;
  return {
    capturedFrom: {
      source: WEB,
      sourceId: await idOfThe(link),
      sourceLink: link,
      sender: hostOf(link),
    },
    capturedMessage: captured,
    page: read.page,
    wordsBeside,
  };
}

/** The site, without a leading `www.`. */
export function hostOf(link: string): string {
  return new URL(link).hostname.replace(/^www\./i, '');
}

/** The link's own id: an Item's source id is at most 500 characters and a link may be 2,000. */
async function idOfThe(link: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(link));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The summary as Markdown: the gist, then the bullets as a list. */
export function summaryText(page: PageSummary): string {
  return `${page.gist}\n\n${page.bullets.map((bullet) => `- ${bullet}`).join('\n')}`;
}

/**
 * The texts a read page makes: its title, and a description of the person's
 * cleaned-up words, then the summary. **A bare link has no words to put first**,
 * so its description is the summary alone, whatever the clean-up made of it.
 */
export function textsOfThePage(
  read: Pick<WebRead, 'page' | 'wordsBeside'>,
  cleaned: { description: string; readings: ReadPastedLinkTexts['readings']; nextAction?: string },
): ReadPastedLinkTexts {
  const words = read.wordsBeside === '' ? '' : cleaned.description.trim();
  return {
    title: read.page.title,
    description: words === '' ? summaryText(read.page) : `${words}\n\n${summaryText(read.page)}`,
    readings: cleaned.readings,
    ...(cleaned.nextAction === undefined ? {} : { nextAction: cleaned.nextAction }),
  };
}

type ReadPastedLinkTexts = NonNullable<ReadPastedLinkCommand['texts']>;
