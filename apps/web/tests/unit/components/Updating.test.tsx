import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { workspaceListSchema } from '@cockpit/shared';
import { Updating } from '../../../src/components/Updating';
import { realVersions, type Versions } from '../../../src/updating';

/**
 * F1: both facts about the browser this needs - whether anything newer is
 * waiting, and going and getting it - are injected, exactly as `Surroundings`
 * is for the failure screen. Nothing here needs a network or a real service
 * worker, and F3 could not help anyway: the browser tier runs Vite's dev
 * server, where vite-plugin-pwa registers no service worker at all
 * (playwright.config.ts says so), so the one condition this whole gate is about
 * cannot be produced there.
 *
 * Stated as what ends up on screen rather than as what the decision returns,
 * because wiring is exactly what was wrong: the old Reload button called
 * `window.location.reload()` correctly and still could not work, since the
 * precached shell answers the navigation before the update check it starts can
 * finish.
 */

/** A real shape mismatch, not a hand-made stand-in for one. */
function unreadableAnswer(): unknown {
  try {
    workspaceListSchema.parse({ workspaces: 'not a list' });
    throw new Error('expected the shape to be rejected');
  } catch (error) {
    return error;
  }
}

/** Storage that behaves like the browser's, without being it. */
function scratchMemory(): Storage {
  const held = new Map<string, string>();
  return {
    get length() {
      return held.size;
    },
    key: (i: number) => [...held.keys()][i] ?? null,
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
    clear: () => held.clear(),
  } as Storage;
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The app, with a read that has come back in a shape it cannot understand. */
async function anOlderVersion(client: QueryClient): Promise<void> {
  await client
    .fetchQuery({ queryKey: ['workspaces'], queryFn: () => Promise.reject(unreadableAnswer()) })
    .catch(() => undefined);
}

function show(client: QueryClient, versions: Versions, memory: Storage) {
  return render(
    <QueryClientProvider client={client}>
      <Updating versions={versions} memory={memory}>
        <p>Your workspace</p>
      </Updating>
    </QueryClientProvider>,
  );
}

describe('Updating', () => {
  describe('a tab running an older version than the server picks the new one up by itself', () => {
    const situations = [
      {
        situation: 'a new version is waiting',
        newVersionWaiting: () => Promise.resolve(true),
        picksItUp: true,
      },
      {
        situation: 'nothing newer is there',
        newVersionWaiting: () => Promise.resolve(false),
        picksItUp: false,
      },
      {
        // Reloading on no evidence is the loop, which is worse than the dead
        // button this replaces.
        situation: 'the check itself cannot be made',
        newVersionWaiting: () => Promise.reject(new Error('offline')),
        picksItUp: false,
      },
      {
        // The real question, asked in a jsdom that has no service worker -
        // which is the shape of the dev server and of a browser without one.
        // Nothing is precaching the shell, so a reload genuinely fetches
        // whatever the server now has.
        situation: 'nothing is precaching the shell',
        newVersionWaiting: realVersions.newVersionWaiting,
        picksItUp: true,
      },
    ];

    it.each(situations)('$situation', async ({ newVersionWaiting, picksItUp }) => {
      const reload = vi.fn();
      const client = newClient();
      show(client, { newVersionWaiting, thisBuild: () => 'build-1', reload }, scratchMemory());
      await anOlderVersion(client);

      if (picksItUp) {
        await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(await screen.findByRole('heading', { name: 'Updating Cockpit' })).toBeVisible();
      } else {
        expect(
          await screen.findByRole('heading', { name: "Cockpit couldn't update" }),
        ).toBeVisible();
        expect(reload).not.toHaveBeenCalled();
      }
    });

    /**
     * The case that makes the automatic reload safe rather than reckless, and
     * the one the first attempt at this guard got wrong. A build still out of
     * date *after* updating would otherwise gate and reload for as long as the
     * tab is open.
     *
     * The reads that *do* work are what make this subtle: on a build that is
     * behind, `me` parses its own schema perfectly well a moment before the
     * workspace fails to parse. A guard cleared by "something read successfully"
     * is therefore already gone by the time the gate rises, and loops. So the
     * successful read is here in the walk rather than left out of it.
     */
    it('reloads once from a build, and never twice, however long the tab stays open', async () => {
      const reload = vi.fn();
      const versions = {
        newVersionWaiting: () => Promise.resolve(true),
        thisBuild: () => 'build-1',
        reload,
      };
      const memory = scratchMemory();

      const first = newClient();
      show(first, versions, memory);
      await anOlderVersion(first);
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

      // The page came back on the same build, still behind. Something reads
      // fine, as it always does, and then the workspace does not.
      const second = newClient();
      show(second, versions, memory);
      await second.fetchQuery({ queryKey: ['me'], queryFn: () => Promise.resolve({}) });
      await anOlderVersion(second);

      expect(await screen.findByRole('heading', { name: "Cockpit couldn't update" })).toBeVisible();
      expect(reload).toHaveBeenCalledTimes(1);
    });

    /**
     * And what stops that guard outliving its purpose: a tab left open across
     * two deployments has to take the second as readily as the first.
     */
    it('updates again for a build it has not tried yet', async () => {
      const reload = vi.fn();
      const memory = scratchMemory();
      let build = 'build-1';
      const versions = {
        newVersionWaiting: () => Promise.resolve(true),
        thisBuild: () => build,
        reload,
      };

      const first = newClient();
      show(first, versions, memory);
      await anOlderVersion(first);
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

      // The update landed, and much later the deployment after it does too.
      build = 'build-2';
      const second = newClient();
      show(second, versions, memory);
      await anOlderVersion(second);

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    });
  });

  describe('nothing of the app is usable while it is out of date', () => {
    it('takes the window, because the copy in hand is no safer than the answer', async () => {
      const client = newClient();
      show(client, { newVersionWaiting: () => Promise.resolve(false), thisBuild: () => 'build-1', reload: vi.fn() }, scratchMemory());
      expect(screen.getByText('Your workspace')).toBeVisible();

      await anOlderVersion(client);

      expect(await screen.findByRole('heading', { name: "Cockpit couldn't update" })).toBeVisible();
      expect(screen.queryByText('Your workspace')).not.toBeInTheDocument();
    });

    it('is nowhere to be seen while Cockpit can read what it is told', async () => {
      const client = newClient();
      show(client, { newVersionWaiting: () => Promise.resolve(true), thisBuild: () => 'build-1', reload: vi.fn() }, scratchMemory());

      await client.fetchQuery({ queryKey: ['workspaces'], queryFn: () => Promise.resolve({}) });

      expect(screen.getByText('Your workspace')).toBeVisible();
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });
  });
});
