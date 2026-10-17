import { REMEMBERED_SENTENCES_SHOWN } from '@cockpit/shared';

/**
 * Which remembered sentences shape a proposal ("Remember an edit as a sentence
 * you confirm", issue 1163). Pure, and here rather than in `accounts/`, for the
 * reason every rule in `domain/` is: what a sentence applies to is a product
 * decision, and the store is only where the rows are.
 */

/** One remembered sentence, as the store keeps it. */
export interface RememberedSentence {
  id: string;
  sentence: string;
  /** The model's few words naming the kind of action, for the person to read. */
  action: string;
  /** The Workspace it names, or null for every Workspace. */
  workspaceId: string | null;
  /** Where the Item the edit was on came from. */
  sourceKind: string;
  useCount: number;
  createdAt: string;
}

/** What decides whether a sentence applies to an Item: where it came from, and its Workspace once that is decided. */
export interface ItemASentenceMayFit {
  sourceKind: string;
  /** Null for an Item belonging to no Workspace yet: only sentences for every Workspace apply to it. */
  workspaceId: string | null;
}

/** Whether a sentence applies to an Item at all. */
export function sentenceFits(sentence: Pick<RememberedSentence, 'sourceKind' | 'workspaceId'>, item: ItemASentenceMayFit): boolean {
  return sentence.sourceKind === item.sourceKind && (sentence.workspaceId === null || sentence.workspaceId === item.workspaceId);
}

/**
 * The sentences a proposal for this Item is shown: only those that fit, the
 * most used first and a tie to the newer, at most `REMEMBERED_SENTENCES_SHOWN`.
 * **Only the sentences that fit**: a sentence about mail is no use to a LinkedIn
 * post, and one naming a Workspace is none to another's Items.
 */
export function sentencesThatFit(item: ItemASentenceMayFit, all: readonly RememberedSentence[]): RememberedSentence[] {
  return all
    .filter((one) => sentenceFits(one, item))
    .sort((one, other) => other.useCount - one.useCount || other.createdAt.localeCompare(one.createdAt) || one.id.localeCompare(other.id))
    .slice(0, REMEMBERED_SENTENCES_SHOWN);
}

/** The most open Items a newly remembered sentence has proposed again at once: the newest, so a long Inbox is not all re-read together. */
export const ITEMS_PROPOSED_AGAIN = 20;
