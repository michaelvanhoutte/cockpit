import { describe, expect, it } from 'vitest';
import { foldName } from '../../../src/domain/names.js';
import { namesNewSince, namesToRecord, whatNamesDid, type NamedTarget } from '../../../src/domain/filing-by-name.js';

/**
 * L1: which Panels a label or category names is a pure match over the names
 * and the Workspace's Panels ("File Outlook mail on the Panel named after its
 * category", issue 1146). That the Item then lands there, in the check's own
 * transaction, is pulled-names.test.ts's against the real store.
 */

const ATLAS: NamedTarget = { id: 'atlas', name: 'Customer Atlas', kind: 'items', dashboardId: 'work', dashboardName: 'Work' };
const ADMIN: NamedTarget = { id: 'admin', name: 'Admin & money', kind: 'items', dashboardId: 'work', dashboardName: 'Work' };
const ADMIN_SPELT_OUT: NamedTarget = { id: 'admin-and', name: 'Admin and money', kind: 'items', dashboardId: 'home', dashboardName: 'Home' };
const ATLAS_ELSEWHERE: NamedTarget = { id: 'atlas-home', name: 'Customer Atlas', kind: 'items', dashboardId: 'home', dashboardName: 'Home' };
const ATLAS_FILTER: NamedTarget = { id: 'atlas-filter', name: 'Customer Atlas', kind: 'filter', dashboardId: 'work', dashboardName: 'Work' };
const ATLAS_TEXT: NamedTarget = { id: 'atlas-text', name: 'Customer Atlas', kind: 'text', dashboardId: 'work', dashboardName: 'Work' };

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
      expect(whatNamesDid(names, panels, { skipAll: null, alreadyOn: new Set() }).panelIds).toEqual(files);
    });
  });

  describe('each name says whether it filed the Item on a Panel or why it did not (issue 1197)', () => {
    const none = new Set<string>();
    /** `panel@dashboard` where filed, `skipped:why` (with the Dashboards it matched) otherwise. */
    const said = (names: string[], panels: NamedTarget[], skipAll: 'off' | 'baseline' | null = null, alreadyOn = none) =>
      whatNamesDid(names, panels, { skipAll, alreadyOn }).outcomes.map((one) =>
        one.why === null ? `${one.panel}@${one.dashboard}` : `skipped:${one.why}${one.dashboards === null ? '' : `:${one.dashboards}`}`,
      );

    it.each([
      { situation: 'one Panel', names: ['Customer Atlas'], panels: [ATLAS], says: ['Customer Atlas@Work'] },
      { situation: 'no Panel', names: ['Red category'], panels: [ATLAS], says: ['skipped:no-panel'] },
      { situation: 'Panels on two Dashboards', names: ['Customer Atlas'], panels: [ATLAS, ATLAS_ELSEWHERE], says: ['skipped:several:2'] },
      {
        situation: 'only a Filter',
        names: ['Customer Atlas'],
        panels: [ATLAS_FILTER],
        says: ['skipped:no-panel'],
      },
      {
        situation: 'a name of each kind, in order',
        names: ['Customer Atlas', 'Red', 'Admin & money'],
        panels: [ATLAS, ADMIN],
        says: ['Customer Atlas@Work', 'skipped:no-panel', 'Admin & money@Work'],
      },
    ])('$situation', ({ names, panels, says }) => {
      expect(said(names, panels)).toEqual(says);
    });

    it.each([
      { situation: 'filing is off', skipAll: 'off' as const, says: ['skipped:off', 'skipped:off'] },
      { situation: 'nothing was recorded before', skipAll: 'baseline' as const, says: ['skipped:baseline', 'skipped:baseline'] },
    ])('whatever the name matches, when $situation', ({ skipAll, says }) => {
      expect(said(['Customer Atlas', 'Red'], [ATLAS], skipAll)).toEqual(says);
    });

    it('a Panel the Item is on already is not filed on again', () => {
      const decided = whatNamesDid(['Customer Atlas', 'Admin & money'], [ATLAS, ADMIN], {
        skipAll: null,
        alreadyOn: new Set(['atlas']),
      });
      expect(decided.panelIds).toEqual(['admin']);
      expect(decided.outcomes.map((one) => one.why)).toEqual(['already-there', null]);
    });
  });

  describe('a name may qualify a Panel by the Dashboard it lives on, where the connector declares it (issue 1198)', () => {
    const pair = (id: string, dashboardName: string, name: string, kind: NamedTarget['kind'] = 'items'): NamedTarget => ({
      id,
      name,
      kind,
      dashboardId: `d-${dashboardName}`,
      dashboardName,
    });
    const TASKS = { cubico: pair('t-cubico', 'Cubico', 'Tasks'), prive: pair('t-prive', 'Privé', 'Tasks'), conseilt: pair('t-conseilt', 'conseilt.be', 'Tasks') };
    const byDashboard = { byDashboard: true };
    const said = (names: string[], panels: NamedTarget[], forms = byDashboard) =>
      whatNamesDid(names, panels, { skipAll: null, alreadyOn: new Set(), forms }).outcomes.map((one) =>
        one.why === null ? `${one.panel}@${one.dashboard}` : `skipped:${one.why}${one.panels === null ? '' : `:${one.panels}`}${one.dashboards === null ? '' : `:${one.dashboards}`}`,
      );

    it.each([
      { situation: 'a Dashboard and its Panel', names: ['Cubico-Tasks'], panels: Object.values(TASKS), says: ['Tasks@Cubico'] },
      { situation: 'a Dashboard named with a dot', names: ['conseilt.be-Tasks'], panels: Object.values(TASKS), says: ['Tasks@conseilt.be'] },
      { situation: 'spaces around the hyphen and in the names', names: ['day to  day - TASKS'], panels: [pair('d', 'Day to day', 'Tasks')], says: ['Tasks@Day to day'] },
      { situation: '"&" against a Panel written with "and"', names: ['Cubico-Admin & money'], panels: [pair('a', 'Cubico', 'Admin and money')], says: ['Admin and money@Cubico'] },
      { situation: 'no Panel of that name on that Dashboard', names: ['Cubico-Tasks'], panels: [TASKS.prive], says: ['skipped:no-panel'] },
      {
        situation: 'a Dashboard that only shows the Panel, which lives on another',
        names: ['Day to day-Tasks'],
        panels: [TASKS.prive],
        says: ['skipped:no-panel'],
      },
      { situation: 'a Filter of that name on that Dashboard', names: ['Cubico-Tasks'], panels: [pair('f', 'Cubico', 'Tasks', 'filter')], says: ['skipped:no-panel'] },
    ])('$situation', ({ names, panels, says }) => {
      expect(said(names, panels)).toEqual(says);
    });

    it.each([
      {
        situation: 'a Dashboard-Panel split two ways',
        names: ['A-B-C'],
        panels: [pair('x', 'A-B', 'C'), pair('y', 'A', 'B-C')],
        says: ['skipped:pairs:2'],
      },
      {
        situation: 'a plain name and a Dashboard-qualified reading of it hitting different Panels',
        names: ['Cubico-Tasks'],
        panels: [pair('x', 'Home', 'Cubico-Tasks'), pair('y', 'Cubico', 'Tasks')],
        says: ['skipped:pairs:2'],
      },
      { situation: 'a plain name on three Dashboards, as before', names: ['Tasks'], panels: Object.values(TASKS), says: ['skipped:several:3'] },
    ])('files nothing, and says why, for $situation', ({ names, panels, says }) => {
      expect(said(names, panels)).toEqual(says);
    });

    it('files on the Panel called by the whole name when no Dashboard-qualified reading hits another', () => {
      expect(said(['Cubico-Tasks'], [pair('x', 'Home', 'Cubico-Tasks')])).toEqual(['Cubico-Tasks@Home']);
    });

    it('reads no Dashboard-qualified name where the connector declares none', () => {
      expect(said(['Cubico-Tasks'], Object.values(TASKS), { byDashboard: false })).toEqual(['skipped:no-panel']);
      expect(whatNamesDid(['Cubico-Tasks'], Object.values(TASKS), { skipAll: null, alreadyOn: new Set() }).panelIds).toEqual([]);
    });
  });

  describe('matching ignores accents, for every name (issue 1198)', () => {
    it.each([
      { situation: 'a name without the accent against a Panel with it', name: 'Prive', panel: 'Privé' },
      { situation: 'a name with the accent against a Panel without it', name: 'Privé', panel: 'Prive' },
      { situation: 'a decomposed accent', name: 'Privé', panel: 'Privé' },
    ])('$situation', ({ name, panel }) => {
      const target: NamedTarget = { id: 'p', name: panel, kind: 'items', dashboardId: 'd', dashboardName: 'Home' };
      expect(whatNamesDid([name], [target], { skipAll: null, alreadyOn: new Set() }).panelIds).toEqual(['p']);
    });

    it('matches a Dashboard-qualified name written without the accents', () => {
      const target: NamedTarget = { id: 'p', name: 'Tasks', kind: 'items', dashboardId: 'd', dashboardName: 'Privé' };
      const forms = { byDashboard: true };
      expect(whatNamesDid(['prive-tasks'], [target], { skipAll: null, alreadyOn: new Set(), forms }).panelIds).toEqual(['p']);
    });

    it('drops Latin accents only: kana that differ by a voicing mark stay two names', () => {
      const target: NamedTarget = { id: 'p', name: 'か', kind: 'items', dashboardId: 'd', dashboardName: 'Home' };
      expect(whatNamesDid(['が'], [target], { skipAll: null, alreadyOn: new Set() }).panelIds).toEqual([]);
    });

    it('leaves the names Cockpit keeps unique alone: foldName still tells Privé from Prive', () => {
      expect(foldName('Privé')).not.toBe(foldName('Prive'));
    });

    it('still counts a name differing from a recorded one by an accent as new, and records both', () => {
      expect(namesNewSince(['Prive'], ['Privé'])).toEqual(['Privé']);
      expect(namesToRecord(['Prive', 'Privé'])).toEqual(['Prive', 'Privé']);
      expect(namesNewSince(['Prive'], ['PRIVE'])).toEqual([]);
    });
  });
});
