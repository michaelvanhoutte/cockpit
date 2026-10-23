import { describe, expect, it } from 'vitest';
import type { Panel } from '@cockpit/shared';
import { captureOpenedBy } from '../../src/captureAddress';

/**
 * F1: what an address that names a Workspace, and perhaps a Panel, opens Capture
 * with ("Read a Panel from an app allowed only to read, and open Capture from
 * its address", issue 1445). That Capture then behaves as the Panel's own + -
 * its form starting on that Workspace and Panel, closing to the Dashboard once a
 * note is kept - is tests/unit/components/CaptureNote.test.tsx and
 * tests/unit/pages/CapturePage.test.tsx; that a browser opened at the address
 * lands the note on the Panel is the walk in tests/e2e/capture.test.ts.
 */

const WORKSPACES = [{ id: 'ws-work' }, { id: 'ws-home' }];

function aPanel(id: string, kind: Panel['kind'] = 'items'): Panel {
  return {
    id,
    tenantId: 'tenant',
    dashboardId: 'd-today',
    name: id === 'p-falcon' ? 'Falcon' : id,
    kind,
    format: 'plain',
    body: '',
    readOnly: false,
    neverPropose: false,
    filter: null,
    sort: null,
    columns: null,
  };
}

/** The Panels `ws-work` holds: one of items, one that gathers, one of text. */
const WORK = { panels: [aPanel('p-falcon'), aPanel('p-this-week', 'filter'), aPanel('p-notes', 'text')] };

describe('Capture', () => {
  describe('opening Capture from an address naming a Workspace and a Panel of items behaves as that Panel’s own +', () => {
    it.each([
      {
        situation: 'a Workspace and a Panel of items',
        search: { workspace: 'ws-work', panel: 'p-falcon' },
        opens: {
          captureFrom: 'ws-work',
          captureOn: { panelId: 'p-falcon', name: 'Falcon', workspaceId: 'ws-work', dashboardId: 'd-today' },
        },
      },
      {
        situation: 'a Workspace only, as from a Filter panel',
        search: { workspace: 'ws-work' },
        opens: { captureFrom: 'ws-work' },
      },
      {
        situation: 'a Workspace and a Panel since deleted',
        search: { workspace: 'ws-work', panel: 'p-deleted' },
        opens: { captureFrom: 'ws-work' },
      },
      {
        situation: 'a Workspace and a Filter panel, which nothing is filed onto',
        search: { workspace: 'ws-work', panel: 'p-this-week' },
        opens: { captureFrom: 'ws-work' },
      },
      {
        situation: 'a Workspace and a Panel of text',
        search: { workspace: 'ws-work', panel: 'p-notes' },
        opens: { captureFrom: 'ws-work' },
      },
      {
        situation: 'a Workspace this account does not have, with a Panel',
        search: { workspace: 'ws-gone', panel: 'p-falcon' },
        opens: null,
      },
      { situation: 'nothing the account holds', search: { panel: 'p-falcon' }, opens: null },
      { situation: 'a Workspace that is no text', search: { workspace: 42 }, opens: null },
    ])('opens with $opens for $situation', ({ search, opens }) => {
      expect(captureOpenedBy(search, WORKSPACES, WORK)).toEqual(opens);
    });

    it('keeps the Workspace and leaves File on empty where the Workspace’s Panels cannot be read', () => {
      expect(captureOpenedBy({ workspace: 'ws-work', panel: 'p-falcon' }, WORKSPACES, undefined)).toEqual({
        captureFrom: 'ws-work',
      });
    });
  });
});
