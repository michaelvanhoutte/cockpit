import { describe, expect, it } from 'vitest';
import { runBlocksAStart, type AgentRunStatus } from '../../../src/index.js';

/**
 * L1: which run stands in the way of sending an Item to Claude again ("Drop
 * an agent on an item to start a Claude Code session on it", issue 571). That
 * the server acts on it is apps/api/tests/integration/http/claude-sends.test.ts's.
 */

describe('Agents', () => {
  describe('an item carries at most one run that is going', () => {
    it.each<{ situation: string; status: AgentRunStatus | null; blocks: boolean }>([
      { situation: 'no run', status: null, blocks: false },
      { situation: 'a run starting', status: 'starting', blocks: true },
      { situation: 'a run working', status: 'working', blocks: true },
      { situation: 'a run whose link was lost', status: 'link_lost', blocks: true },
      { situation: 'a run nobody knows the fate of', status: 'unknown', blocks: true },
      { situation: 'a run Claude refused', status: 'failed', blocks: false },
    ])('$situation', ({ status, blocks }) => {
      expect(runBlocksAStart(status === null ? undefined : { status })).toBe(blocks);
    });
  });
});