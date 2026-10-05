import { describe, expect, it } from 'vitest';
import { STARTING_GIVES_UP_AFTER_MS, type AgentRun } from '@cockpit/shared';
import { runChipFor } from '../../src/agentRunChip';

/**
 * F1: what a row's chip says about each run, with the clock handed in ("Drop
 * an agent on an item to start a Claude Code session on it", issue 571; "See
 * on the item when Claude is waiting on you", issue 572). That
 * the row draws it is ItemRow.test.tsx's.
 */

const NOW = Date.parse('2026-09-28T10:00:00.000Z');

const aRun = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-1',
  itemId: 'item-1',
  agentId: 'agent-1',
  agentName: 'Scope it',
  status: 'working',
  sessionUrl: 'https://claude.ai/code/session_01',
  reason: null,
  startedAt: new Date(NOW - 1000).toISOString(),
  waiting: false,
  ...overrides,
});

describe('Agents', () => {
  describe('the chip says how the run stands, in words', () => {
    it.each([
      { situation: 'starting', run: aRun({ status: 'starting', sessionUrl: null }), text: 'Starting Claude…', link: false, trouble: false },
      { situation: 'working', run: aRun(), text: 'Claude is working ↗', link: true, trouble: false },
      { situation: 'waiting on you', run: aRun({ waiting: true }), text: 'Claude is waiting on you ↗', link: true, trouble: false },
      { situation: 'started, with its link lost', run: aRun({ status: 'link_lost', sessionUrl: null }), text: 'Claude started - its link was lost', link: false, trouble: true },
      { situation: 'never answered', run: aRun({ status: 'unknown', sessionUrl: null }), text: 'Unknown - check Claude', link: false, trouble: true },
      { situation: 'refused', run: aRun({ status: 'failed', sessionUrl: null, reason: 'That routine no longer exists.' }), text: "Claude didn't start", link: false, trouble: true },
      {
        situation: 'still starting long after it should have answered',
        run: aRun({ status: 'starting', sessionUrl: null, startedAt: new Date(NOW - STARTING_GIVES_UP_AFTER_MS - 1).toISOString() }),
        text: 'Unknown - check Claude',
        link: false,
        trouble: true,
      },
    ])('$situation', ({ run, text, link, trouble }) => {
      const chip = runChipFor(run, NOW);
      expect({ text: chip.text, link: chip.href !== null, trouble: chip.trouble }).toEqual({ text, link, trouble });
    });

    it.each([
      { situation: 'a simulated run in the guest demo', sessionUrl: 'https://demo.cockpit.invalid/session/018f0000', opens: '/demo/session' },
      { situation: 'a real Claude session', sessionUrl: 'https://claude.ai/code/session_01', opens: 'https://claude.ai/code/session_01' },
    ])('opens $situation at the page it belongs at, working or waiting on you', ({ sessionUrl, opens }) => {
      expect(runChipFor(aRun({ sessionUrl }), NOW).href).toBe(opens);
      expect(runChipFor(aRun({ sessionUrl, waiting: true }), NOW).href).toBe(opens);
    });

    it('gives the reason Claude refused on hover', () => {
      expect(runChipFor(aRun({ status: 'failed', reason: 'The token is wrong or was revoked.' }), NOW).hint).toBe(
        'The token is wrong or was revoked.',
      );
    });

    it.each([
      { situation: 'an agent still there', agentName: 'Scope it', names: 'Scope it' },
      { situation: 'a deleted agent', agentName: null, names: 'a deleted agent' },
    ])('names $situation', ({ agentName, names }) => {
      expect(runChipFor(aRun({ agentName }), NOW).agent).toBe(names);
    });
  });
});
