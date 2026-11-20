import { firstMessageLink, webLinks, wordsBesideTheLinks, type Item, type ReadPastedLinkCommand } from '@cockpit/shared';
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

/** How many of a note's links are read: the first three, the rest stay plain. */
const MOST_LINKS_READ = 3;

/**
 * The links of a note the job would read as pages: the first 3 web links of an
 * Own note - typed, shared from the Android browser or captured over MCP, never
 * an app's capture - that hold no link a connector declared, whether or not it
 * can read them, less any an Item's own link could not hold. A note with a
 * source link is never read again.
 */
export function webLinksIn(
  env: Env,
  item: Pick<Item, 'source' | 'capturedMessage' | 'sourceId' | 'sourceLink'>,
): string[] {
  const own = (item.source === 'internal' && item.sourceId === null) || item.source === 'mcp';
  if (!own || item.sourceLink !== null) return [];
  // A note typed here holding a Teams link is read from Teams, or left as typed: its web links stay plain.
  if (item.source === 'internal' && firstMessageLink(item.capturedMessage, messageLinks(env))) return [];
  return webLinks(item.capturedMessage, messageLinks(env), MOST_LINKS_READ).filter((link) => link.length <= SOURCE_LINK_LENGTH);
}

/** A page the note's link named, and what it said. */
export interface PageOfTheNote {
  link: string;
  page: PageSummary;
}

/** What the pages make of the Item, for `read_pasted_link`, with what they said. */
export interface WebRead extends Pick<ReadPastedLinkCommand, 'capturedFrom' | 'capturedMessage'> {
  /** The pages that were read, in the order their links appear: at least one. */
  pages: PageOfTheNote[];
  /** What the person typed beside the links that were read, empty where the note was only those: a link not read stays in it. */
  wordsBeside: string;
  /** What the person typed beside every link the note held, empty for bare links. */
  words: string;
  /** How many web links the note held that were asked about, read or not. */
  linksAsked: number;
}

/**
 * The pages the note's links name, or null where none can be read, which leaves
 * the note as typed. **A call that fails throws, so the queue tries the job
 * again, unless this is its last try**: then that page counts as not readable,
 * as a Teams read does, and the others are still written. The calls run
 * together.
 */
export async function readTheWebPages(
  ai: AiService,
  item: Pick<Item, 'capturedMessage'>,
  links: readonly string[],
  callFor: CallFor,
  lastAttempt: boolean,
): Promise<WebRead | null> {
  const captured = item.capturedMessage ?? links[0] ?? '';
  const words = wordsBesideTheLinks(captured, links);
  const read = await Promise.all(links.map((link) => readOne(ai, link, words, callFor, lastAttempt)));
  const pages = read.filter((one): one is PageOfTheNote => one !== null);
  const first = pages[0];
  if (!first) return null;
  return {
    capturedFrom: {
      source: WEB,
      sourceId: await idOfThe(first.link),
      sourceLink: first.link,
      sender: hostOf(first.link),
    },
    capturedMessage: captured,
    pages,
    wordsBeside: wordsBesideTheLinks(
      captured,
      pages.map((one) => one.link),
    ),
    words,
    linksAsked: links.length,
  };
}

/** One link's page, or null where it is not readable; a call that fails throws unless this is the last try. */
async function readOne(ai: AiService, link: string, words: string, callFor: CallFor, lastAttempt: boolean): Promise<PageOfTheNote | null> {
  let read;
  try {
    read = await ai.summarisePage(link, words, callFor);
  } catch (error) {
    if (!lastAttempt) throw error;
    console.log(
      JSON.stringify({ level: 'warn', message: 'a pasted link was not read on the last try', data: error instanceof Error ? error.message : String(error) }),
    );
    return null;
  }
  return 'page' in read ? { link, page: read.page } : null;
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

/** A page's title in bold, the characters that would break the bold kept as text. */
function boldTitle(title: string): string {
  return `**${title.replace(/[*\\]/g, '\\$&')}**`;
}

/** The summaries of the pages read: one alone as it stands, several each under its page's title in bold. */
export function summariesText(pages: readonly PageOfTheNote[]): string {
  if (pages.length === 1) return summaryText(pages[0]!.page);
  return pages.map(({ page }) => `${boldTitle(page.title)}\n\n${summaryText(page)}`).join('\n\n');
}

/**
 * The texts the read pages make: the title, and a description of the person's
 * cleaned-up words, then the summaries. **The title is the first page's, unless
 * the note held several links, read or not, and has words**: then it is the clean-up's,
 * written from them. A note of links alone has no words to put first, so its
 * description is the summaries alone, whatever the clean-up made of it; one
 * with a link not read keeps what the clean-up made, that link in it.
 */
export function textsOfThePage(
  read: Pick<WebRead, 'pages' | 'wordsBeside' | 'words' | 'linksAsked'>,
  cleaned: { title?: string; description: string; readings: ReadPastedLinkTexts['readings']; nextAction?: string },
): ReadPastedLinkTexts {
  const words = read.wordsBeside === '' ? '' : cleaned.description.trim();
  const summaries = summariesText(read.pages);
  const ownTitle = read.linksAsked > 1 && read.words !== '' && (cleaned.title ?? '').trim() !== '';
  return {
    title: ownTitle ? (cleaned.title ?? '').trim() : read.pages[0]!.page.title,
    description: words === '' ? summaries : `${words}\n\n${summaries}`,
    readings: cleaned.readings,
    ...(cleaned.nextAction === undefined ? {} : { nextAction: cleaned.nextAction }),
  };
}

type ReadPastedLinkTexts = NonNullable<ReadPastedLinkCommand['texts']>;
