import { describe, expect, it } from 'vitest';
import { STARTING_GIVES_UP_AFTER_MS, type AgentRun } from '@cockpit/shared';
import { runChipFor, sessionHrefFor } from '../../src/agentRunChip';

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
      { situation: 'Cowork', destination: 'cowork' as const, text: 'Sent to Cowork' },
      { situation: 'Code', destination: 'code' as const, text: 'Sent to Code' },
    ])('says an item sent to $situation went, naming no agent', ({ destination, text }) => {
      const chip = runChipFor(
        aRun({ agentId: '', agentName: null, sessionUrl: null, destination, stage: 'sent' }),
        NOW,
      );

      expect({ agent: chip.agent, text: chip.text, link: chip.href, trouble: chip.trouble }).toEqual({
        agent: '',
        text,
        link: null,
        trouble: false,
      });
    });

    describe('an item sent to Claude follows what Claude reports', () => {
      const sent = (overrides: Partial<AgentRun>) =>
        runChipFor(
          aRun({ agentId: '', agentName: null, sessionUrl: null, destination: 'cowork', stage: 'sent', ...overrides }),
          NOW,
        );

      it.each([
        {
          situation: 'on it, with its session',
          run: { stage: 'on_it', sessionUrl: 'https://claude.ai/code/session_01' },
          text: 'Cowork is on it ↗',
          href: 'https://claude.ai/code/session_01',
          hint: 'Open the session',
          waiting: false,
        },
        {
          situation: 'on it, before it gave a session',
          run: { stage: 'on_it' },
          text: 'Cowork is on it',
          href: null,
          hint: null,
          waiting: false,
        },
        {
          situation: 'ready, with what it made and a note',
          run: { stage: 'ready', sessionUrl: 'https://claude.ai/code/session_01', resultUrl: 'https://example.com/draft', note: 'Two drafts, A and B' },
          text: 'Ready ↗',
          href: 'https://example.com/draft',
          hint: 'Opens example.com - Two drafts, A and B',
          waiting: false,
        },
        {
          situation: 'ready, with only its session',
          run: { stage: 'ready', sessionUrl: 'https://claude.ai/code/session_01' },
          text: 'Ready ↗',
          href: 'https://claude.ai/code/session_01',
          hint: 'Opens claude.ai',
          waiting: false,
        },
        {
          situation: 'needing you in the guest demo, its session Cockpit’s own page for one',
          run: { stage: 'needs_you', sessionUrl: 'https://demo.cockpit.invalid/session/run-1', note: 'Which day?' },
          text: 'Needs you ↗',
          href: '/demo/session',
          hint: 'Which day?',
          waiting: true,
        },
        {
          situation: 'ready in the guest demo, opening Cockpit’s own page for its session',
          run: { stage: 'ready', sessionUrl: 'https://demo.cockpit.invalid/session/run-1', resultUrl: 'https://demo.cockpit.invalid/session/run-1', note: 'A one-page comparison' },
          text: 'Ready ↗',
          href: '/demo/session',
          hint: 'A one-page comparison',
          waiting: false,
        },
        {
          situation: 'needing you, with its question',
          run: { stage: 'needs_you', sessionUrl: 'https://claude.ai/code/session_01', note: 'Which account?' },
          text: 'Needs you ↗',
          href: 'https://claude.ai/code/session_01',
          hint: 'Which account?',
          waiting: true,
        },
      ])('shows $situation', ({ run, text, href, hint, waiting }) => {
        const chip = sent(run as Partial<AgentRun>);
        expect({ text: chip.text, href: chip.href, hint: chip.hint, waiting: chip.waiting, trouble: chip.trouble }).toEqual({
          text,
          href,
          hint,
          waiting,
          trouble: false,
        });
      });

      it('never draws a link that is not https, whatever was stored', () => {
        const chip = sent({ stage: 'ready', resultUrl: 'javascript:alert(1)', sessionUrl: 'http://claude.ai/x' });

        expect([chip.href, chip.text]).toEqual([null, 'Ready']);
      });

      it('names the real host a Ready link opens, whatever the note says', () => {
        const chip = sent({
          stage: 'ready',
          resultUrl: 'https://claude.ai.evil.example/login',
          note: 'Opens claude.ai',
        });

        expect(chip.hint).toBe('Opens claude.ai.evil.example - Opens claude.ai');
      });

      it('opens the session from the menu even when the chip opens what Claude made', () => {
        const run = aRun({
          agentId: '',
          agentName: null,
          destination: 'cowork',
          stage: 'ready',
          sessionUrl: 'https://claude.ai/code/session_01',
          resultUrl: 'https://example.com/draft',
        });

        expect([runChipFor(run, NOW).href, sessionHrefFor(run, runChipFor(run, NOW))]).toEqual([
          'https://example.com/draft',
          'https://claude.ai/code/session_01',
        ]);
      });

      it('goes on saying Sent to Cowork until Claude reports', () => {
        expect(sent({}).text).toBe('Sent to Cowork');
      });
    });
    it.each([
      { situation: 'an agent still there', agentName: 'Scope it', names: 'Scope it' },
      { situation: 'a deleted agent', agentName: null, names: 'a deleted agent' },
    ])('names $situation', ({ agentName, names }) => {
      expect(runChipFor(aRun({ agentName }), NOW).agent).toBe(names);
    });
  });
});

