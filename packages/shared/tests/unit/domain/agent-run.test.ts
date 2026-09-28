import { describe, expect, it } from 'vitest';
import {
  ASK_CLAUDE_ID,
  runBlocksAStart,
  startableAgents,
  type Agent,
  type AgentRunStatus,
} from '../../../src/index.js';

/**
 * L1: which run stands in the way of a start, and which Agents a Dashboard
 * offers to start - the one answer the row's menu, the drop and the server's
 * refusal all read ("Drop an agent on an item to start a Claude Code session
 * on it", issue 571). That the server actually refuses by them is
 * apps/api/tests/integration/http/agent-runs.test.ts's.
 */

const anAgent = (id: string, asksForPrompt = false): Agent => ({
  id,
  tenantId: 'tenant',
  name: `Agent ${id}`,
  color: '#6f62b5',
  engine: 'claude-code',
  message: '{title}',
  asksForPrompt,
  startsInProgress: true,
  position: 0,
  createdAt: '2026-09-28T10:00:00.000Z',
});

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

  describe('a dashboard offers the agents its dock draws, Ask Claude asking what to ask', () => {
    it('offers each tile as the agent it starts, in the dock’s order', () => {
      const offered = startableAgents([
        { kind: 'ask-claude' },
        { kind: 'agent', agent: anAgent('scope') },
      ]);

      expect(offered.map((agent) => ({ id: agent.id, asks: agent.asksForPrompt, starts: agent.startsInProgress }))).toEqual([
        { id: ASK_CLAUDE_ID, asks: true, starts: false },
        { id: 'scope', asks: false, starts: true },
      ]);
    });
  });
});
