import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { test as setup } from '@playwright/test';

import { ADA, MICHAEL, signInToFirstScreen, signedInStateFile, type SavedSignIn } from './app';
import { walksProjectOf } from './projects';

/**
 * Signs each seeded person in once per project, ahead of the walks, and saves
 * the session for `signIn` to load (`playwright.config.ts` runs this as the
 * project every walks project depends on).
 *
 * **Through the real flow** (`signInToFirstScreen`), so a sign-in the issuer
 * or the Worker refuses fails the run here, once, rather than in every walk.
 * `test` comes from Playwright rather than `./app` because this is no walk, and
 * the stack-went-away guard there is written for walks.
 *
 * **The cookies alone are saved**, not the whole browser state: a walk starts
 * from what the session is and nothing the sign-in happened to leave in
 * localStorage, so no walk can come to depend on that by accident.
 */
for (const person of [MICHAEL, ADA]) {
  setup(`sign in ${person}`, async ({ page, isMobile }, info) => {
    await signInToFirstScreen(page, person, isMobile);

    const file = signedInStateFile(info, walksProjectOf(info.project.name), person);
    const saved: SavedSignIn = { cookies: (await page.context().storageState()).cookies };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(saved));
  });
}
