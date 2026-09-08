import { itemLabel, type Item } from '@cockpit/shared';

/**
 * The AI layer behind a project-owned interface (architecture §6.4): takes
 * domain objects, returns domain objects, so everything around it stays
 * testable at L1 with the AI faked. Enrichment runs on ingest, in jobs;
 * reads never wait on a model call.
 */
export interface AiService {
  summarizeItem(item: Item): Promise<string>;
  extractNextAction(item: Item): Promise<string>;
}

/**
 * Placeholder until the Claude-backed implementation lands with enrichment jobs.
 *
 * **Neither reaches for the captured message**, which is a record and not a
 * name: what an Item is called is `itemLabel` and nowhere else, or a next
 * action proposed here would put the raw captured text back on the row as a
 * label by another route.
 */
export class NoopAiService implements AiService {
  async summarizeItem(item: Item): Promise<string> {
    return item.description ?? itemLabel(item);
  }

  async extractNextAction(item: Item): Promise<string> {
    return item.title;
  }
}
