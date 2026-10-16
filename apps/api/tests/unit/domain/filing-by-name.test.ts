import { describe, expect, it } from 'vitest';
import { panelsNamedBy, type NamedTarget } from '../../../src/domain/filing-by-name.js';

/**
 * L1: which Panels a label or category names is a pure match over the names
 * and the Workspace's Panels ("File Outlook mail on the Panel named after its
 * category", issue 1146). That the Item then lands there, in the check's own
 * transaction, is pulled-names.test.ts's against the real store.
 */

const ATLAS: NamedTarget = { id: 'atlas', name: 'Customer Atlas', kind: 'items', dashboardId: 'work' };
const ADMIN: NamedTarget = { id: 'admin', name: 'Admin & money', kind: 'items', dashboardId: 'work' };
const ADMIN_SPELT_OUT: NamedTarget = { id: 'admin-and', name: 'Admin and money', kind: 'items', dashboardId: 'home' };
const ATLAS_ELSEWHERE: NamedTarget = { id: 'atlas-home', name: 'Customer Atlas', kind: 'items', dashboardId: 'home' };
const ATLAS_FILTER: NamedTarget = { id: 'atlas-filter', name: 'Customer Atlas', kind: 'filter', dashboardId: 'work' };
const ATLAS_TEXT: NamedTarget = { id: 'atlas-text', name: 'Customer Atlas', kind: 'text', dashboardId: 'work' };

describe('Connector management', () => {
  describe('a name files an Item on the one Panel of Items in its Workspace that it names', () => {
    it.each([
      { situation: 'the Panel’s own name', names: ['Customer Atlas'], panels: [ATLAS], files: ['atlas'] },
      {
        situation: 'the name in another case and with a double space',
        names: ['customer  atlas'],
        panels: [ATLAS],
        files: ['atlas'],
      },
      { situation: '"and" against a Panel written with "&"', names: ['Admin and money'], panels: [ADMIN], files: ['admin'] },
      {
        situation: '"&" against a Panel written with "and"',
        names: ['Admin & money'],
        panels: [ADMIN_SPELT_OUT],
        files: ['admin-and'],
      },
      { situation: 'a name no Panel has', names: ['Supplier Borealis'], panels: [ATLAS], files: [] },
      {
        situation: 'a name Panels on two Dashboards share',
        names: ['Customer Atlas'],
        panels: [ATLAS, ATLAS_ELSEWHERE],
        files: [],
      },
      { situation: 'a name only a Filter has', names: ['Customer Atlas'], panels: [ATLAS_FILTER], files: [] },
      { situation: 'a name only a Panel of text has', names: ['Customer Atlas'], panels: [ATLAS_TEXT], files: [] },
      {
        situation: 'a name a Filter shares with one Panel of Items',
        names: ['Customer Atlas'],
        panels: [ATLAS_FILTER, ATLAS],
        files: ['atlas'],
      },
      {
        situation: 'two names, each naming one Panel',
        names: ['Customer Atlas', 'Admin & money'],
        panels: [ATLAS, ADMIN],
        files: ['atlas', 'admin'],
      },
    ])('$situation', ({ names, panels, files }) => {
      expect(panelsNamedBy(names, panels)).toEqual(files);
    });
  });
});
