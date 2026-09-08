import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { workspaceListSchema } from '@cockpit/shared';
import { Updating } from '../../../src/components/Updating';
import {
  pickUpTheNewVersion,
  realVersions,
  takeTheNewVersion,
  type Versions,
} from '../../../src/updating';

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
      show(
        client,
        {
          newVersionWaiting,
          thisBuild: () => 'build-1',
          servedBuild: () => Promise.resolve('build-1'),
          reload,
        },
        scratchMemory(),
      );
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
        // The gate never asks this one; it is here because the shape has it.
        servedBuild: () => Promise.resolve('build-1'),
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
        // The gate never asks this one; it is here because the shape has it.
        servedBuild: () => Promise.resolve(build),
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
      show(client, { newVersionWaiting: () => Promise.resolve(false), thisBuild: () => 'build-1', servedBuild: () => Promise.resolve('build-1'), reload: vi.fn() }, scratchMemory());
      expect(screen.getByText('Your workspace')).toBeVisible();

      await anOlderVersion(client);

      expect(await screen.findByRole('heading', { name: "Cockpit couldn't update" })).toBeVisible();
      expect(screen.queryByText('Your workspace')).not.toBeInTheDocument();
    });

    it('is nowhere to be seen while Cockpit can read what it is told', async () => {
      const client = newClient();
      show(client, { newVersionWaiting: () => Promise.resolve(true), thisBuild: () => 'build-1', servedBuild: () => Promise.resolve('build-1'), reload: vi.fn() }, scratchMemory());

      await client.fetchQuery({ queryKey: ['workspaces'], queryFn: () => Promise.resolve({}) });

      expect(screen.getByText('Your workspace')).toBeVisible();
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });
  });

  /**
   * The other way the server says "you are behind", and the one a shape it
   * cannot read does not cover: this build asks for an address a later one
   * dropped ("Update instead of failing when a build asks for an address that
   * has been retired", issue 217). Every case here is a refusal, so what is
   * being asked is which refusals mean *update* and which mean what they say.
   */
  describe('a read for something the server no longer has is a version behind, not a failure', () => {
    /** The message shape apps/web/src/api/client.ts throws for a refusal. */
    const refused = (status: number) => new Error(`workspaces failed: ${status}`);

    async function reading(client: QueryClient, answer: () => Promise<unknown>): Promise<void> {
      await client.fetchQuery({ queryKey: ['workspaces'], queryFn: answer }).catch(() => undefined);
    }

    it('fetches the new version when the address has been retired', async () => {
      const reload = vi.fn();
      const client = newClient();
      show(client, { newVersionWaiting: () => Promise.resolve(true), thisBuild: () => 'build-1', servedBuild: () => Promise.resolve('build-1'), reload }, scratchMemory());

      await reading(client, () => Promise.reject(refused(410)));

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    });

    /**
     * A change rather than a read, refused the way a change is refused: with
     * the server's own words and the status on the error rather than spelled
     * into the message. Both halves were missing - the status was read only out
     * of the message, and the gate watched only reads - so a build that *wrote*
     * to a retired address stayed exactly where it was.
     */
    it('fetches the new version when a change is refused as retired', async () => {
      const reload = vi.fn();
      const client = newClient();
      show(client, { newVersionWaiting: () => Promise.resolve(true), thisBuild: () => 'build-1', servedBuild: () => Promise.resolve('build-1'), reload }, scratchMemory());

      await client
        .getMutationCache()
        .build(client, {
          mutationFn: () =>
            Promise.reject(
              Object.assign(
                new Error('this address has been retired; the app needs a newer version'),
                { status: 410 },
              ),
            ),
        })
        .execute(undefined)
        .catch(() => undefined);

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    });

    it.each([
      // The refusal every read gets when a visit has ended. Sending somebody to
      // the logon page is the app's answer to this, and taking the window for
      // an update instead would hide it.
      { situation: 'a read refused for not being signed in', answer: () => Promise.reject(refused(401)) },
      // Something answered badly, which is what "having trouble" is for: trying
      // again can work, and reloading cannot.
      { situation: 'a read the server could not complete', answer: () => Promise.reject(refused(503)) },
      // Nothing answered at all - no status to read, and a reload would land on
      // a browser that still has no connection.
      { situation: 'a read nothing answered', answer: () => Promise.reject(new Error('Failed to fetch')) },
    ])('leaves $situation to the app', async ({ answer }) => {
      const reload = vi.fn();
      const client = newClient();
      show(client, { newVersionWaiting: () => Promise.resolve(true), thisBuild: () => 'build-1', servedBuild: () => Promise.resolve('build-1'), reload }, scratchMemory());

      await reading(client, answer);

      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText('Your workspace')).toBeVisible();
    });
  });

  /**
   * The third way to be behind, and the one no answer can carry: a file this
   * build named is not being served. The gate above cannot see it - the API
   * answers an older client perfectly well, and a file the browser fetches for
   * itself passes through neither cache that gate watches - so this is asked of
   * `takeTheNewVersion` directly, which is the whole of the decision.
   *
   * That the description's box actually asks it is
   * tests/unit/components/DescriptionBox.test.tsx.
   */
  /**
   * The third way to be behind, and the one no answer can carry: a file this
   * build named is not being served. The gate above cannot see it - the API
   * answers an older client perfectly well, and a file the browser fetches for
   * itself passes through neither cache that gate watches - so this is asked of
   * `takeTheNewVersion` directly, which is the whole of the decision.
   *
   * That the description's box actually asks it is
   * tests/unit/components/DescriptionBox.test.tsx.
   */
  describe('a tab whose own files have gone can still pick up the new version', () => {
    /** What the tab is running, what the server hands out, and what happens. */
    const asking = (served: string | null, reload = vi.fn(), memory = scratchMemory()) => ({
      reload,
      memory,
      versions: {
        // The question the gate asks, answered the way it is answered once the
        // new version has already claimed the page: nothing on its way. Taking
        // the new version anyway is the point, and nothing here may ask it.
        newVersionWaiting: () => Promise.reject(new Error('must not be asked')),
        thisBuild: () => 'build-1',
        servedBuild: () => Promise.resolve(served),
        reload,
      },
    });

    it('takes it when the server is handing out a different version', async () => {
      const { versions, memory, reload } = asking('build-2');

      await expect(takeTheNewVersion(versions, memory)).resolves.toBe('taken');

      expect(reload).toHaveBeenCalledTimes(1);
    });

    // The file goes missing for dull reasons too - a connection that dropped,
    // a proxy that ate it - and those reloads land back where they started with
    // the same thing broken, having thrown away whatever was half-written.
    it('leaves the page alone when the server is handing out this same version', async () => {
      const { versions, memory, reload } = asking('build-1');

      await expect(takeTheNewVersion(versions, memory)).resolves.toBe('nothing-new');

      expect(reload).not.toHaveBeenCalled();
    });

    // Which is not the same as there being nothing newer, and is not said as
    // though it were.
    it('says it could not find out when the server could not be asked', async () => {
      const { versions, memory, reload } = asking(null);

      await expect(takeTheNewVersion(versions, memory)).resolves.toBe('could-not-ask');

      expect(reload).not.toHaveBeenCalled();
    });

    it('says nothing is newer rather than reloading twice from the same version', async () => {
      const { versions, memory, reload } = asking('build-2');

      await expect(takeTheNewVersion(versions, memory)).resolves.toBe('taken');
      await expect(takeTheNewVersion(versions, memory)).resolves.toBe('nothing-new');

      expect(reload).toHaveBeenCalledTimes(1);
    });

    // The mark is the version it was written from, so a tab open across two
    // deployments takes the second as readily as the first.
    it('takes it again once the tab is on a version it has not tried from', async () => {
      const reload = vi.fn();
      const memory = scratchMemory();
      const onward = (build: string) => ({
        newVersionWaiting: () => Promise.reject(new Error('must not be asked')),
        thisBuild: () => build,
        servedBuild: () => Promise.resolve('newer'),
        reload,
      });

      await expect(takeTheNewVersion(onward('build-1'), memory)).resolves.toBe('taken');
      await expect(takeTheNewVersion(onward('build-2'), memory)).resolves.toBe('taken');

      expect(reload).toHaveBeenCalledTimes(2);
    });

    /**
     * The two ways of taking a version keep their marks apart. The gate returns
     * `true` from `newVersionWaiting` merely for there being no worker
     * registered yet, so its reload can land back on the same version and mark
     * it - and one key for both would then have this one telling somebody they
     * are up to date while a file of theirs is provably gone.
     */
    it('is not silenced by the window gate having already reloaded from this version', async () => {
      const memory = scratchMemory();
      const reload = vi.fn();
      const gate = {
        newVersionWaiting: () => Promise.resolve(true),
        thisBuild: () => 'build-1',
        servedBuild: () => Promise.resolve('build-1'),
        reload,
      };

      await expect(pickUpTheNewVersion(gate, memory)).resolves.toBe('taken');
      await expect(takeTheNewVersion({ ...gate, servedBuild: () => Promise.resolve('build-2') }, memory)).resolves.toBe('taken');

      expect(reload).toHaveBeenCalledTimes(2);
    });
  });
});
