import { describe, expect, it } from 'vitest';
import type { Item, Source } from '@cockpit/shared';
import { openableAtSource } from '../../src/itemSource';

/**
 * F1, and pure: where *Open ↗* goes for an Item ("Seed Gmail and Teams in the
 * guest demo, with fewer items, opening their links inside Cockpit", issue
 * 773). The row, its menu and the form all ask this one function, so what it
 * answers is what each of them opens. The pages it points at are
 * tests/unit/pages/DemoPage.test.tsx's.
 */
const itemFrom = (source: Source, sourceLink: string | null): Item => ({ source, sourceLink, sender: 'Els Maes' }) as Item;

describe('Connector management', () => {
  describe('Open on a demo item opens Cockpit’s own page for its source, and on any other item opens the source as before', () => {
    it.each([
      {
        situation: 'a demo Gmail address',
        item: itemFrom('mail', 'https://demo.cockpit.invalid/gmail'),
        opens: { name: 'Gmail', link: '/demo/gmail' },
      },
      {
        situation: 'a demo Teams address',
        item: itemFrom('teams', 'https://demo.cockpit.invalid/teams'),
        opens: { name: 'Microsoft Teams', link: '/demo/teams' },
      },
      {
        situation: 'an unknown path on the demo host',
        item: itemFrom('mail', 'https://demo.cockpit.invalid/anything-else'),
        opens: null,
      },
      {
        situation: 'a real Gmail link on a named person’s item',
        item: itemFrom('mail', 'https://mail.google.com/mail/u/0/#inbox/18c0ffee'),
        opens: { name: 'Gmail', link: 'https://mail.google.com/mail/u/0/#inbox/18c0ffee' },
      },
      {
        situation: 'a real Teams link on a named person’s item',
        item: itemFrom('teams', 'https://teams.microsoft.com/l/message/19:abc/1'),
        opens: { name: 'Microsoft Teams', link: 'https://teams.microsoft.com/l/message/19:abc/1' },
      },
      { situation: 'an item with no link', item: itemFrom('mail', null), opens: null },
    ])('$situation', ({ item, opens }) => {
      expect(openableAtSource(item)).toEqual(opens);
    });
  });
});
