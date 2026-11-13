import { describe, expect, it } from 'vitest';
import type { Item, Source } from '@cockpit/shared';
import { openableAtSource, whereALinkOpens } from '../../src/itemSource';

/**
 * F1, and pure: where *Open ↗* goes for an Item ("Seed Gmail and Teams in the
 * guest demo, with fewer items, opening their links inside Cockpit", issue
 * 773). The row, its menu and the form all ask this one function, so what it
 * answers is what each of them opens. The pages it points at are
 * tests/unit/pages/DemoPage.test.tsx's.
 */
const itemFrom = (source: Source, sourceLink: string | null): Item => ({ source, sourceLink, sender: 'Els Maes' }) as Item;

/** An Item with texts, for the Teams message links found in them (issue 1738). */
const withTexts = (
  source: Source,
  sourceLink: string | null,
  texts: { description?: string | null; capturedMessage?: string | null },
): Item => ({ source, sourceLink, sender: 'Els Maes', description: null, capturedMessage: null, ...texts }) as Item;

const LIVE =
  'https://teams.live.com/l/message/48:notes/1789899944174?context=%7B%22contextType%22%3A%22chat%22%2C%22oid%22%3A%228%3Amichaelvanhoutte%22%7D';
const WORK = 'https://teams.microsoft.com/l/message/19:abc@thread.v2/1700000000000';
const CLOUD = 'https://teams.cloud.microsoft/l/message/19:abc@thread.v2/1700000000001';
const CHANNEL =
  "https://teams.microsoft.com/l/message/19:abc@thread.tacv2/1700000000002?tenantId=t&groupId=g&parentMessageId=1700000000002&teamName=Michael's%20team&channelName=Sales%20(EU)&createdTime=1700000000002";
const TEAMS = { name: 'Microsoft Teams' };

/** What the Workspace's snapshot calls each source (issue 927). */
const NAMES = { gmail: 'Gmail', teams: 'Microsoft Teams', inmail: 'LinkedIn message' };

/** What the connectors declare as their message links (issue 1738); the app names none of them. */
const LINKS = {
  teams: ['teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'].map((host) => ({ host, pathStart: '/l/message/' })),
};

/** A second connector's declaration, for a source this app was never built with. */
const INMAIL = 'https://www.linkedin.example/messaging/thread/2-abc/';
const TWO_CONNECTORS = { ...LINKS, inmail: [{ host: 'www.linkedin.example', pathStart: '/messaging/thread/' }] };

describe('Connector management', () => {
  describe('Open on a demo item opens Cockpit’s own page for its source, and on any other item opens the source as before', () => {
    it.each([
      {
        situation: 'a demo Gmail address',
        item: itemFrom('gmail', 'https://demo.cockpit.invalid/gmail'),
        opens: { name: 'Gmail', link: '/demo/gmail' },
      },
      {
        situation: 'a demo Teams address',
        item: itemFrom('teams', 'https://demo.cockpit.invalid/teams'),
        opens: { name: 'Microsoft Teams', link: '/demo/teams' },
      },
      {
        situation: 'an unknown path on the demo host',
        item: itemFrom('gmail', 'https://demo.cockpit.invalid/anything-else'),
        opens: null,
      },
      {
        situation: 'a real Gmail link on a named person’s item',
        item: itemFrom('gmail', 'https://mail.google.com/mail/u/0/#inbox/18c0ffee'),
        opens: { name: 'Gmail', link: 'https://mail.google.com/mail/u/0/#inbox/18c0ffee' },
      },
      {
        situation: 'a real Teams link on a named person’s item',
        item: itemFrom('teams', 'https://teams.microsoft.com/l/message/19:abc/1'),
        opens: { name: 'Microsoft Teams', link: 'https://teams.microsoft.com/l/message/19:abc/1' },
      },
      { situation: 'an item with no link', item: itemFrom('gmail', null), opens: null },
      {
        situation: 'a link from a connector nothing names',
        item: itemFrom('outlook', 'https://outlook.example/m/1'),
        opens: { name: 'outlook', link: 'https://outlook.example/m/1' },
      },
    ])('$situation', ({ item, opens }) => {
      expect(openableAtSource(item, NAMES, LINKS)).toEqual(opens);
    });
  });

  /** A run's ↗ asks the same place: a simulated session opens Cockpit's own page, and a real one is untouched (issue 774). */
  describe('a run’s link on a demo session opens Cockpit’s session page, and a real Claude session opens as before', () => {
    it.each([
      { situation: 'a demo session address', link: 'https://demo.cockpit.invalid/session/018f0000-0000', opens: '/demo/session' },
      { situation: 'a real claude.ai session link', link: 'https://claude.ai/code/session_01EXAMPLE', opens: 'https://claude.ai/code/session_01EXAMPLE' },
      { situation: 'an unknown path on the demo host', link: 'https://demo.cockpit.invalid/anything-else', opens: null },
    ])('$situation', ({ link, opens }) => {
      expect(whereALinkOpens(link)).toBe(opens);
    });
  });

  /** "Open Items captured with a pasted Teams message link in Teams", issue 1738. */
  describe('An Item with no link of its own opens at the first Teams message link in its description, then in its captured message', () => {
    it.each([
      { situation: 'the request’s teams.live.com link in the captured message', item: withTexts('internal', null, { capturedMessage: `call Mieke back ${LIVE}` }), link: LIVE },
      { situation: 'a teams.microsoft.com message link in the description', item: withTexts('internal', null, { description: `see ${WORK}` }), link: WORK },
      { situation: 'a teams.cloud.microsoft message link', item: withTexts('internal', null, { description: CLOUD }), link: CLOUD },
      {
        situation: 'a link pasted as Markdown, without the closing bracket',
        item: withTexts('internal', null, { capturedMessage: `[Michael Vanhoutte: call mieke](${LIVE})` }),
        link: LIVE,
      },
      {
        situation: 'different links in the description and the captured message, the description’s',
        item: withTexts('internal', null, { description: WORK, capturedMessage: LIVE }),
        link: WORK,
      },
      { situation: 'two links in the description, the first', item: withTexts('internal', null, { description: `${WORK} then ${LIVE}` }), link: WORK },
      { situation: 'an app’s capture with no link', item: withTexts('mcp', null, { description: LIVE }), link: LIVE },
      { situation: 'a link ending a sentence, without the full stop', item: withTexts('internal', null, { description: `call Mieke about ${WORK}.` }), link: WORK },
      { situation: 'a link followed by a comma, without it', item: withTexts('internal', null, { description: `see ${WORK}, then book` }), link: WORK },
      { situation: 'a link inside parentheses, without the closing one', item: withTexts('internal', null, { description: `(${WORK})` }), link: WORK },
      {
        situation: 'a channel link whose team and channel names keep their parentheses and apostrophe',
        item: withTexts('internal', null, { description: `${CHANNEL} please` }),
        link: CHANNEL,
      },
      {
        situation: 'a 60,000-character description with the link at its end',
        item: withTexts('internal', null, { description: `${'word '.repeat(12_000)}${LIVE}` }),
        link: LIVE,
      },
    ])('$situation', ({ item, link }) => {
      expect(openableAtSource(item, NAMES, LINKS)).toEqual({ ...TEAMS, link });
    });
  });

  describe('Only a Teams message link counts', () => {
    it.each([
      { situation: 'no link in either text', item: withTexts('internal', null, { description: 'call Mieke', capturedMessage: 'call Mieke' }), link: null },
      { situation: 'a Teams chat link', item: withTexts('internal', null, { description: 'https://teams.microsoft.com/l/chat/19:abc@thread.v2/0' }), link: null },
      { situation: 'a Teams meeting link', item: withTexts('internal', null, { description: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting' }), link: null },
      {
        situation: 'a look-alike host',
        item: withTexts('internal', null, { description: 'https://teams.microsoft.com.example.org/l/message/19:abc/1' }),
        link: null,
      },
      { situation: 'an http message link', item: withTexts('internal', null, { description: 'http://teams.microsoft.com/l/message/19:abc/1' }), link: null },
      {
        situation: 'a malformed Teams address, then a valid message link',
        item: withTexts('internal', null, { description: `https://teams.microsoft.com:99999/l/message/x then ${WORK}` }),
        link: WORK,
      },
    ])('$situation', ({ item, link }) => {
      expect(openableAtSource(item, NAMES, LINKS)).toEqual(link ? { ...TEAMS, link } : null);
    });
  });

  describe('An Item with a link of its own, or from a connector, keeps what it had', () => {
    it.each([
      {
        situation: 'a Gmail Item with its link and a Teams message link in its description',
        item: withTexts('gmail', 'https://mail.google.com/mail/u/0/#inbox/1', { description: LIVE }),
        opens: { name: 'Gmail', link: 'https://mail.google.com/mail/u/0/#inbox/1' },
      },
      { situation: 'a Gmail Item with no stored link', item: withTexts('gmail', null, { description: LIVE }), opens: null },
      {
        situation: 'an app’s capture with its own link',
        item: withTexts('mcp', 'https://notion.example/p/1', { description: LIVE }),
        opens: { name: 'Els Maes', link: 'https://notion.example/p/1' },
      },
    ])('$situation', ({ item, opens }) => {
      expect(openableAtSource(item, NAMES, LINKS)).toEqual(opens);
    });
  });

  describe('Only what connectors declare is a message link', () => {
    it('an older copy that carries no declarations offers nothing for an Own Item with a Teams link', () => {
      expect(openableAtSource(withTexts('internal', null, { description: WORK }), NAMES, undefined)).toBeNull();
    });

    it('a link declared by another connector opens under that connector’s name', () => {
      expect(openableAtSource(withTexts('internal', null, { description: `see ${INMAIL}` }), NAMES, TWO_CONNECTORS)).toEqual({
        name: 'LinkedIn message',
        link: INMAIL,
      });
    });

    it('with two connectors’ links in one text, the first in the text wins', () => {
      expect(openableAtSource(withTexts('internal', null, { description: `${INMAIL} and ${WORK}` }), NAMES, TWO_CONNECTORS)).toEqual({
        name: 'LinkedIn message',
        link: INMAIL,
      });
      expect(openableAtSource(withTexts('internal', null, { description: `${WORK} and ${INMAIL}` }), NAMES, TWO_CONNECTORS)).toEqual({
        ...TEAMS,
        link: WORK,
      });
    });

    it('a declared host matches whatever its case', () => {
      const shouted = 'https://TEAMS.Microsoft.com/l/message/19:abc/1';
      expect(openableAtSource(withTexts('internal', null, { description: shouted }), NAMES, LINKS)?.name).toBe('Microsoft Teams');
    });
  });
});
