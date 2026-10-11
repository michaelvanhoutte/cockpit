import { beforeEach, describe, expect, it } from 'vitest';
import { emptyTheDatabase, send, storedRequestIds, totals, usage } from './support';

beforeEach(emptyTheDatabase);

describe('Harness Monitor', () => {
  describe('a batch with an invalid row is refused whole', () => {
    it('one bad row among good ones stores nothing from the batch', async () => {
      const response = await send([usage('good_1'), usage('bad', { inputTokens: -5 }), usage('good_2')]);

      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain('Row 1 (bad)');
      expect(await storedRequestIds()).toEqual([]);
      expect(await totals()).toEqual([]);
    });
  });
});
