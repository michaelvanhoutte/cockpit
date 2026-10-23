import { describe, expect, it } from 'vitest';
import type { ConnectedApp, ConnectedAppList } from '@cockpit/shared';
import { connectedAppsDrawnOver } from '../../src/connectedAppsDrawnAhead';

/**
 * F1: what disconnecting an app draws over the list the server sent. That the
 * control sends it, and that the window draws the result, is
 * tests/unit/components/ConnectedAppsAtOnce.test.tsx; when it stops being drawn is
 * tests/unit/changeQueue.test.ts.
 */

const CLAUDE: ConnectedApp = { id: 'grant-claude', name: 'Claude', kind: 'captures', connectedAt: '2026-09-30T09:00:00.000Z', lastCapturedAt: null, lastReadAt: null };
const QUIET: ConnectedApp = { id: 'grant-quiet', name: 'Quiet app', kind: 'captures', connectedAt: '2026-09-30T10:00:00.000Z', lastCapturedAt: null, lastReadAt: null };
const held: ConnectedAppList = { apps: [CLAUDE, QUIET] };

const disconnected = (appId: string) => ({ name: 'disconnect_app', payload: { appId } }) as const;

describe('MCP connections', () => {
  describe('a disconnected app is drawn as gone', () => {
    it('takes the app out of the list and leaves the others', () => {
      expect(connectedAppsDrawnOver(held, [disconnected('grant-claude')]).apps).toEqual([QUIET]);
    });

    it('draws every app disconnected as gone', () => {
      expect(connectedAppsDrawnOver(held, [disconnected('grant-claude'), disconnected('grant-quiet')]).apps).toEqual([]);
    });

    it('leaves the list alone for an app it does not hold', () => {
      expect(connectedAppsDrawnOver(held, [disconnected('grant-unknown')])).toEqual(held);
    });

    it('does not write into the list it was given', () => {
      connectedAppsDrawnOver(held, [disconnected('grant-claude')]);

      expect(held.apps).toEqual([CLAUDE, QUIET]);
    });
  });
});
