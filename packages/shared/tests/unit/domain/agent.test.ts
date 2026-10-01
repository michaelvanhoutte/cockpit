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

  describe('the message lists every attachment of the item, each a link the session can open', () => {
    const IMAGE_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const image = (id: string, filename: string) => ({
      id,
      filename,
      contentType: 'image/png',
      link: `https://cockpit.test/v1/attachment-links/token-${filename}`,
    });
    const HEADER =
      'Attachments - download each link and read the file. A link works for an hour, without signing in.';

    it.each([
      {
        situation: 'two images and a PDF are three links, each named',
        description: null,
        attachments: [
          image('a1', 'before.png'),
          image('a2', 'after.png'),
          {
            id: 'a3',
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            link: 'https://cockpit.test/v1/attachment-links/token-invoice.pdf',
          },
        ],
        expected: [
          'Chase the invoice',
          '',
          HEADER,
          '- before.png: https://cockpit.test/v1/attachment-links/token-before.png',
          '- after.png: https://cockpit.test/v1/attachment-links/token-after.png',
          '- invoice.pdf: https://cockpit.test/v1/attachment-links/token-invoice.pdf',
        ].join('\n'),
      },
      {
        situation: 'an image inline in the description is its link in place of the signed-in address',
        description: `Broken here:\n\n![shot.png](/v1/attachments/${IMAGE_ID})`,
        attachments: [image(IMAGE_ID, 'shot.png')],
        expected: [
          'Chase the invoice',
          '',
          'Broken here:',
          '',
          '![shot.png](https://cockpit.test/v1/attachment-links/token-shot.png)',
          '',
          HEADER,
          '- shot.png: https://cockpit.test/v1/attachment-links/token-shot.png',
        ].join('\n'),
      },
      {
        situation: 'an address inside another URL in the description is left as it is',
        description: `See https://elsewhere.test/v1/attachments/${IMAGE_ID}`,
        attachments: [image(IMAGE_ID, 'shot.png')],
        expected: [
          'Chase the invoice',
          '',
          `See https://elsewhere.test/v1/attachments/${IMAGE_ID}`,
          '',
          HEADER,
          '- shot.png: https://cockpit.test/v1/attachment-links/token-shot.png',
        ].join('\n'),
      },
      {
        situation: 'a video clip is named, as not readable by Claude',
        description: null,
        attachments: [
          {
            id: 'a4',
            filename: 'repro.mp4',
            contentType: 'video/mp4',
            link: 'https://cockpit.test/v1/attachment-links/token-repro.mp4',
          },
        ],
        expected: ['Chase the invoice', '', HEADER, '- repro.mp4 - not readable by Claude'].join('\n'),
      },
      {
        situation: 'an item with no attachments has no attachments section',
        description: null,
        attachments: [],
        expected: 'Chase the invoice',
      },
    ])('$situation', ({ description, attachments, expected }) => {
      expect(
        agentMessageFor(agent({ message: '{title}\n\n{description}' }), {
          title: 'Chase the invoice',
          description,
          link: 'https://cockpit.test/i/7',
          attachments,
        }),
      ).toBe(expected);
    });
  });

  describe('a dashboard shows every agent except those hidden on it', () => {
    const scopeIt = agent({ id: 'agent-scope', name: 'Scope it' });
    const shipIt = agent({ id: 'agent-ship', name: 'Ship it' });

    it.each([
      {
        situation: 'nothing hidden',
        hiddenAgentIds: [],
        expected: ['agent-scope', 'agent-ship'],
      },
      {
        situation: 'one hidden on this dashboard',
        hiddenAgentIds: ['agent-ship'],
        expected: ['agent-scope'],
      },
      {
        situation: 'no agent made',
        agents: [],
        hiddenAgentIds: [],
        expected: [],
      },
    ])('$situation', ({ agents = [scopeIt, shipIt], hiddenAgentIds, expected }) => {
      expect(agentsShownOnDashboard({ agents, hiddenAgentIds }).map((shown) => shown.id)).toEqual(expected);
    });
  });
});
