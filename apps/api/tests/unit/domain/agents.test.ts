import { describe, expect, it } from 'vitest';
import type { Agent } from '@cockpit/shared';
import { AGENT_COLORS } from '@cockpit/shared';
import { agentFromCommand, agentNamed } from '../../../src/domain/agents.js';

const AT = '2026-09-28T10:00:00.000Z';

const request = {
  commandId: '018f0000-0000-7000-8000-000000000001',
  workspaceId: 'account',
  issuedAt: AT,
  agentId: '018f0000-0000-7000-8000-000000000009',
  name: 'Scope it',
  color: AGENT_COLORS[0]!,
  engine: 'claude-code' as const,
  message: '/scoping {title}',
  asksForPrompt: false,
  startsInProgress: true,
};

function anAgent(name: string, at = 0): Agent {
  return {
    id: `11111111-1111-7111-8111-${String(at).padStart(12, '0')}`,
    tenantId: 'tenant-default',
    name,
    color: AGENT_COLORS[0]!,
    engine: 'claude-code',
    message: '/scoping {title}',
    asksForPrompt: false,
    startsInProgress: true,
    position: at,
    createdAt: AT,
  };
}

describe('Agents', () => {
  describe('a name already on the dock collides; a new one does not', () => {
    const taken = [anAgent('Scope it', 0), anAgent('Ship it', 1)];

    it.each([
      { situation: 'the exact name', name: 'Ship it', collides: true },
      { situation: 'a different capitalisation', name: 'SHIP IT', collides: true },
      { situation: 'the name with blanks round it', name: '  ship it  ', collides: true },
      { situation: 'a name never used', name: 'Review it', collides: false },
    ])('$situation', ({ name, collides }) => {
      expect(agentNamed(taken, name) !== undefined).toBe(collides);
    });
  });

  describe('a new agent joins the end of the dock, after every agent there has ever been', () => {
    it.each([
      { situation: 'the account has none at all', last: null, position: 0 },
      { situation: 'two live agents', last: 1, position: 2 },
      { situation: 'one survivor whose place is higher than the count', last: 3, position: 4 },
    ])('$situation', ({ last, position }) => {
      expect(agentFromCommand(request, 'tenant-default', last).position).toBe(position);
    });
  });

  describe('an agent carries exactly what its own form sent', () => {
    it('takes every field from the command, not a default', () => {
      const agent = agentFromCommand(
        { ...request, color: AGENT_COLORS[3]!, message: '{title} - {link}', asksForPrompt: true, startsInProgress: false },
        'tenant-default',
        null,
      );

      expect(agent).toMatchObject({
        color: AGENT_COLORS[3],
        engine: 'claude-code',
        message: '{title} - {link}',
        asksForPrompt: true,
        startsInProgress: false,
      });
    });
  });
});
