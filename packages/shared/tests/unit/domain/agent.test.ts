import { describe, expect, it } from 'vitest';
import { agentMessageFor, agentsShownOnDashboard } from '../../../src/domain/agent.js';
import type { Agent } from '../../../src/domain/agent.js';

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 'agent-1',
  tenantId: 'tenant-1',
  name: 'Scope it',
  color: '#6f62b5',
  engine: 'claude-code',
  message: '/scoping {title}\n\n{description}',
  asksForPrompt: false,
  startsInProgress: true,
  position: 0,
  createdAt: '2026-09-28T10:00:00.000Z',
  ...overrides,
});

describe('Agents', () => {
  describe('the message sent is the agent’s template with the item’s words in it', () => {
    it.each([
      {
        situation: 'title and description in place',
        template: '/scoping {title}\n\n{description}',
        item: { title: 'Chase the invoice', description: 'It is two weeks late', link: 'https://cockpit.test/i/1' },
        prompt: undefined,
        expected: '/scoping Chase the invoice\n\nIt is two weeks late',
      },
      {
        situation: 'a prompt given fills {prompt}',
        template: 'Look into {title}: {prompt}',
        item: { title: 'Renew the domain', description: null, link: 'https://cockpit.test/i/2' },
        prompt: 'is this still needed?',
        expected: 'Look into Renew the domain: is this still needed?',
      },
      {
        situation: 'an item with no description leaves the placeholder empty and trims the result',
        template: '{title}\n\n{description}',
        item: { title: 'Chase the invoice', description: null, link: 'https://cockpit.test/i/3' },
        prompt: undefined,
        expected: 'Chase the invoice',
      },
      {
        situation: 'the link in place',
        template: '{title} - {link}',
        item: { title: 'Renew the domain', description: null, link: 'https://cockpit.test/i/4' },
        prompt: undefined,
        expected: 'Renew the domain - https://cockpit.test/i/4',
      },
      {
        situation: 'an item’s own words that look like a placeholder are not filled a second time',
        template: '{title} - {description}',
        item: { title: 'Fix {description} bug', description: 'urgent', link: 'https://cockpit.test/i/5' },
        prompt: undefined,
        expected: 'Fix {description} bug - urgent',
      },
      {
        situation: 'an item’s own words that look like a $-pattern are inserted literally',
        template: '{title}',
        item: { title: 'Ship $& now', description: null, link: 'https://cockpit.test/i/6' },
        prompt: undefined,
        expected: 'Ship $& now',
      },
    ])('$situation', ({ template, item, prompt, expected }) => {
      expect(agentMessageFor(agent({ message: template }), item, prompt)).toBe(expected);
    });
  });

  describe('a dashboard shows every agent except those hidden on it', () => {
    const scopeIt = agent({ id: 'agent-scope', name: 'Scope it' });
    const shipIt = agent({ id: 'agent-ship', name: 'Ship it' });

    it.each([
      {
        situation: 'nothing hidden',
        hiddenAgentIds: [],
        askClaudeEnabled: false,
        hasClaudeCodeConnection: false,
        expected: ['agent-scope', 'agent-ship'],
      },
      {
        situation: 'one hidden on this dashboard',
        hiddenAgentIds: ['agent-ship'],
        askClaudeEnabled: false,
        hasClaudeCodeConnection: false,
        expected: ['agent-scope'],
      },
      {
        situation: 'Ask Claude drawn where the workspace is connected and enabled',
        hiddenAgentIds: [],
        askClaudeEnabled: true,
        hasClaudeCodeConnection: true,
        expected: ['ask-claude', 'agent-scope', 'agent-ship'],
      },
      {
        situation: 'Ask Claude absent where the workspace holds no connection',
        hiddenAgentIds: [],
        askClaudeEnabled: true,
        hasClaudeCodeConnection: false,
        expected: ['agent-scope', 'agent-ship'],
      },
      {
        situation: 'Ask Claude absent where it was turned off everywhere, connection or not',
        hiddenAgentIds: [],
        askClaudeEnabled: false,
        hasClaudeCodeConnection: true,
        expected: ['agent-scope', 'agent-ship'],
      },
    ])('$situation', ({ hiddenAgentIds, askClaudeEnabled, hasClaudeCodeConnection, expected }) => {
      const tiles = agentsShownOnDashboard({
        agents: [scopeIt, shipIt],
        hiddenAgentIds,
        askClaudeEnabled,
        hasClaudeCodeConnection,
      });

      expect(tiles.map((tile) => (tile.kind === 'ask-claude' ? 'ask-claude' : tile.agent.id))).toEqual(
        expected,
      );
    });
  });
});
