import { describe, expect, it } from 'vitest';
import { isRedirect, redirect } from '@tanstack/react-router';
import type { Panel } from '@cockpit/shared';
import { opensFromItsAddress } from '../../src/captureOpening';

/**
 * F1: the router's step that turns a Capture address naming a Workspace and a
 * Panel into the navigation state a Panel's own + opens Capture with ("Read a
 * Panel from an app allowed only to read, and open Capture from its address",
 * issue 1445). What the address means is tests/unit/captureAddress.test.ts;
 * that a browser opened at it lands the note on the Panel is the walk in
 * tests/e2e/workspace-capture.test.ts.
 */

const WORKSPACES = [{ id: 'ws-work' }];
const FALCON = { id: 'p-falcon', name: 'Falcon', kind: 'items', dashboardId: 'd-today' } as Panel;
const WITH_FALCON = async () => ({ panels: [FALCON] });

/** What the step throws to send the browser on, or null where it throws nothing. */
async function redirectedBy(
  search: Record<string, unknown>,
  read: Parameters<typeof opensFromItsAddress>[0] = WITH_FALCON,
  workspaces = WORKSPACES,
) {
  try {
    await opensFromItsAddress(read, workspaces, { pathname: '/capture', search });
  } catch (thrown) {
    if (isRedirect(thrown)) return thrown.options as { to: string; search: unknown; state: unknown; replace?: boolean };
    throw thrown;
  }
  return null;
}

describe('Capture', () => {
  describe('an address that names a Workspace and a Panel is turned into the state a Panel’s own + opens it with', () => {
    it('opens on the Workspace and Panel, drops both words from the address and keeps the rest of it', async () => {
      const sent = await redirectedBy({ workspace: 'ws-work', panel: 'p-falcon', share: 'failed' });

      expect(sent).toMatchObject({
        to: '/capture',
        search: { share: 'failed' },
        replace: true,
        state: {
          captureFrom: 'ws-work',
          captureOn: { panelId: 'p-falcon', name: 'Falcon', workspaceId: 'ws-work', dashboardId: 'd-today' },
        },
      });
    });

    it('does nothing for an address that names neither', async () => {
      expect(await redirectedBy({ share: 'failed' })).toBeNull();
    });

    it('opens on the Workspace alone where the Panel cannot be read, rather than refusing the address', async () => {
      const sent = await redirectedBy({ workspace: 'ws-work', panel: 'p-falcon' }, async () => {
        throw new Error('offline');
      });

      expect(sent).toMatchObject({ search: {}, state: { captureFrom: 'ws-work' } });
      expect((sent?.state as { captureOn?: unknown }).captureOn).toBeUndefined();
    });

    it('sends on to wherever the read found it must, such as the logon page, instead of swallowing it', async () => {
      await expect(
        opensFromItsAddress(
          async () => {
            throw redirect({ to: '/signin' });
          },
          WORKSPACES,
          { pathname: '/capture', search: { workspace: 'ws-work', panel: 'p-falcon' } },
        ),
      ).rejects.toSatisfy(isRedirect);
    });

    it('opens as a typed /capture does, with no state, for a Workspace the account does not have', async () => {
      const sent = await redirectedBy({ workspace: 'ws-gone', panel: 'p-falcon' });

      expect(sent).toMatchObject({ search: {}, state: {} });
    });
  });
});
