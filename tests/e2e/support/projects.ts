/**
 * How the project that signs people in ahead of a walks project is named, in a
 * file of its own because playwright.config.ts needs the name and must not load
 * `./app` for it: that module extends `test` at load, which is a walk's affair.
 */

/** The suffix that names the project signing people in ahead of a walks project. */
const SIGN_IN_SUFFIX = ' sign-in';

/** The setup project that signs people in ahead of the walks project `walks`. */
export const signInProjectOf = (walks: string): string => `${walks}${SIGN_IN_SUFFIX}`;

/** The walks project a setup project signs people in for: the inverse of `signInProjectOf`, refusing a name it did not make. */
export function walksProjectOf(setup: string): string {
  if (!setup.endsWith(SIGN_IN_SUFFIX)) throw new Error(`"${setup}" is not a sign-in project: it does not end in "${SIGN_IN_SUFFIX}"`);
  return setup.slice(0, -SIGN_IN_SUFFIX.length);
}
