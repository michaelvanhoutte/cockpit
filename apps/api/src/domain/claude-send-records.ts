import {
  CLAUDE_PROPOSAL_PROMPT_LIMIT,
  promptWithoutFixedParts,
  type ClaudeDestination,
  type Item,
  type SendItemToClaudeCommand,
} from '@cockpit/shared';
import { howAlike } from './duplicates.js';

/**
 * What a send keeps, and which past sends shape the next proposal ("Learn from
 * what you sent to Claude", issue 1162). Pure, and here rather than in
 * `accounts/`, for the reason every rule in `domain/` is: what is worth
 * learning from is a product decision, and the store is only where the rows are.
 */

/** The most past sends a proposal is shown: a few examples shape it, a dozen only cost. */
export const PAST_SENDS_SHOWN = 3;

/**
 * How alike an Item has to read to the one a send was made for before that send
 * is shown for it. **Lower than a duplicate's** (`SAYS_THE_SAME_THING`, 0.88),
 * since an Item "like" another is of the same kind - the same project, the same
 * person - and not the same thing said again. Placed against `bge-m3`'s
 * readings as measured there: the same thing in different words 0.97, in Dutch
 * 0.93, and an unrelated note 0.36. Untuned beyond that, as the duplicate's cut-off
 * was when it started: a send shown for an Item it does not fit costs the model
 * a distraction it can set aside, and one missing costs the proposal nothing it
 * did not already lack.
 */
export const SENDS_LIKE_THIS = 0.6;

/** How many of the newest sends are compared with: bounds the readings loaded per proposal. */
export const SENDS_COMPARED = 200;

/** How much of the Item's words a send keeps: an example needs what it was about, not a mail's whole text. */
export const ITEM_WORDS_KEPT = { title: 300, description: 1000 } as const;

/** One send, as the store keeps it: the Item as it read then, what was proposed, and what was sent. */
export interface ClaudeSendRecord {
  id: string;
  workspaceId: string;
  itemId: string;
  itemTitle: string;
  itemDescription: string | null;
  proposed: SentPrompt;
  sent: SentPrompt;
  sentAt: string;
}

/** A destination, a folder and the part of a prompt that is not Cockpit's own. */
export interface SentPrompt {
  destination: ClaudeDestination;
  folder: string;
  prompt: string;
}

/**
 * The record a send leaves, or null where it leaves none: a send from a tab
 * that predates the record carries neither prompt, and one whose prompt is
 * nothing but Cockpit's own parts has nothing to learn from.
 *
 * **The parts Cockpit writes itself are taken out of both prompts** (the line
 * naming whom an Item came from, its files' links, the closing), so the
 * example is the task and nothing else - and so a proposal and a send that
 * differ in nothing the person wrote are equal.
 */
export function recordOfSend(
  cmd: Pick<SendItemToClaudeCommand, 'runId' | 'workspaceId' | 'itemId' | 'destination' | 'folder' | 'prompt' | 'proposed' | 'issuedAt'>,
  item: Pick<Item, 'title' | 'description'>,
): ClaudeSendRecord | null {
  if (cmd.prompt === undefined || cmd.proposed === undefined) return null;
  const sent = keptPrompt(cmd.prompt, cmd.runId);
  const proposed = keptPrompt(cmd.proposed.prompt, cmd.runId);
  if (sent === '') return null;
  return {
    id: cmd.runId,
    workspaceId: cmd.workspaceId,
    itemId: cmd.itemId,
    itemTitle: item.title.slice(0, ITEM_WORDS_KEPT.title),
    itemDescription: item.description === null ? null : item.description.slice(0, ITEM_WORDS_KEPT.description),
    proposed: { destination: cmd.proposed.destination, folder: cmd.proposed.folder, prompt: proposed },
    sent: { destination: cmd.destination, folder: cmd.folder, prompt: sent },
    sentAt: cmd.issuedAt,
  };
}

function keptPrompt(prompt: string, runId: string): string {
  return promptWithoutFixedParts(prompt, runId).slice(0, CLAUDE_PROPOSAL_PROMPT_LIMIT);
}

/** A past send as the proposal reads it: what it was about, what was proposed and what the person sent. */
export interface PastSend {
  title: string;
  description: string | null;
  proposed: SentPrompt;
  sent: SentPrompt;
}

/**
 * The closest of these sends to an Item that read as `reading`, closest first:
 * only those at least `SENDS_LIKE_THIS` alike, at most `limit`, and one per
 * Item (its newest), so an Item sent three times is one example and not the
 * whole of them. Given the newest first, so a tie goes to the newer send.
 */
export function closestSends<T extends { itemId: string; reading: readonly number[] }>(
  reading: readonly number[],
  sends: readonly T[],
  limit: number = PAST_SENDS_SHOWN,
): T[] {
  const seen = new Set<string>();
  const scored: { send: T; alike: number }[] = [];
  for (const send of sends) {
    if (seen.has(send.itemId)) continue;
    seen.add(send.itemId);
    const alike = howAlike(reading, send.reading);
    if (alike >= SENDS_LIKE_THIS) scored.push({ send, alike });
  }
  // A stable sort, so equally alike sends stay newest first.
  return scored
    .sort((one, other) => other.alike - one.alike)
    .slice(0, limit)
    .map((one) => one.send);
}
