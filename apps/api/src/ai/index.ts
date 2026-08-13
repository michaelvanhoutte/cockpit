import type { Item } from '@cockpit/shared';

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

/** Placeholder until the Claude-backed implementation lands with enrichment jobs. */
export class NoopAiService implements AiService {
  async summarizeItem(item: Item): Promise<string> {
    return item.preview ?? item.title;
  }

  async extractNextAction(item: Item): Promise<string> {
    return item.title;
  }
}
