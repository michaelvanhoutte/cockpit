import { howAlike } from './duplicates.js';

/**
 * How close an unfiled Item's meaning has to be to a note filed since the last
 * refresh for the Item to be asked about again (cosine, `howAlike`). Set on 13
 * learned moves in 160 calls: all 13 were kept and 30% of the calls were
 * dropped ("Cut what cleaning up a captured note costs", issue 887). Looser
 * than `SAYS_THE_SAME_THING`, which asks whether two notes say one thing; this
 * asks only whether a filing could have changed where the other belongs.
 */
export const COULD_BE_CHANGED_BY_A_FILING = 0.45;

/** The most Items one refresh asks the model about, the most recently captured first. */
export const MOST_ITEMS_ONE_REFRESH_READS = 20;

/** An unfiled Item and the meaning stored for it, `null` where nothing has read it yet. */
export interface CandidateMeaning {
  itemId: string;
  reading: readonly number[] | null;
}

/**
 * Which unfiled Items a refresh reads again.
 *
 * `candidates` are the Workspace's unfiled Items, **most recently captured
 * first**: the cap keeps the head of the list. `filings` are the meanings of
 * the notes filed in this Workspace since the previous refresh ran, each
 * `null` where that note has no meaning yet - or `null` altogether where the
 * previous refresh is unknown.
 *
 * An Item is read again when it has no meaning (nothing says it is far from
 * what was filed) or its meaning is at least `COULD_BE_CHANGED_BY_A_FILING`
 * close to any filing. **It fails open to every candidate** where the previous
 * refresh is unknown, a filed note has no meaning, or no filing is found at
 * all, since none says what the filing could have reached; the cap still holds
 * then. A refresh is only ever asked for by a filing, so finding none means its
 * time predates the last refresh - a device clock running behind, or a filing
 * replayed after reconnecting. An Item left out keeps the proposal it has
 * until a later filing selects it.
 */
export function itemsToReadAgain(
  candidates: readonly CandidateMeaning[],
  filings: readonly (readonly number[] | null)[] | null,
  cap: number = MOST_ITEMS_ONE_REFRESH_READS,
): string[] {
  const ids = (items: readonly CandidateMeaning[]) => items.slice(0, cap).map((candidate) => candidate.itemId);
  const readings = (filings ?? []).filter((filed): filed is readonly number[] => filed !== null && filed.length > 0);
  if (filings === null || filings.length === 0 || readings.length < filings.length) return ids(candidates);

  return ids(
    candidates.filter(
      (candidate) =>
        candidate.reading === null ||
        candidate.reading.length === 0 ||
        readings.some((filed) => howAlike(candidate.reading!, filed) >= COULD_BE_CHANGED_BY_A_FILING),
    ),
  );
}
