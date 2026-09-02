import { statSync } from 'node:fs';
import { join } from 'node:path';

//
// Which ports this checkout's servers listen on.
//
// The problem this exists for: several git worktrees of this repository are
// open at once - one per issue being worked - and every one of them wants to
// run `pnpm dev`. They do not fight over anything else. Each worktree already
// has its own `apps/api/.wrangler/state`, so the databases are separate, and
// Vite already takes the API's address from COCKPIT_API_ORIGIN, which is how
// the browser tier pairs its Vite with its own Wrangler. Only the port numbers
// were hard-coded, in four places, so the second worktree to start simply could
// not.
//
// **The primary checkout keeps the documented ports.** It is the one the readme
// is written for, and a linked worktree is by definition a second copy that
// must not take them. Which is which is a fact of the filesystem rather than a
// setting: `git worktree add` leaves a `.git` *file* holding a `gitdir:` line,
// while the primary checkout has a `.git` directory.
//
// **A worktree's ports are derived from its own path**, so they are the same
// every time it is started. That matters more than it first appears: a browser
// keys localStorage and IndexedDB by origin, and Cockpit keeps its persisted
// snapshot in IndexedDB and the view you were last on in localStorage. A port
// that moved between runs would be a new origin every run - so the instant
// paint from a stored copy, which is the second architectural driver, could
// never be exercised by hand, and no tab or bookmark would survive a restart.
// "Any free port" is therefore not an option; "the same port for this worktree,
// always" is.
//
// **Two worktrees can still collide**, and that is a real limitation rather
// than an oversight. With 512 slots and nine worktrees open the chance that
// some pair shares one is about seven per cent (there are 36 pairs, each
// colliding with probability 1/512). It surfaces as the port check refusing to
// start and naming what is holding the port, and it is fixed for good by
// setting one of the overrides below in that worktree. A registry file would
// remove the last seven per cent at the cost of a shared file to keep tidy and
// prune; that trade can be made later if this ever actually bites.
//

/** The ports the readme, the documents and everyone's muscle memory know. */
export const DOCUMENTED_PORTS = Object.freeze({
  devWeb: 5173,
  devApi: 8787,
  e2eWeb: 5273,
  e2eApi: 8887,
});

/**
 * Where each derived port counts from. Four bands rather than one block of
 * four, so a worktree's web port still looks like a web port and its API port
 * like an API port in the line `pnpm dev` prints.
 *
 * Each band is `SLOTS` wide, they do not overlap each other, and none of them
 * contains any of the four above - which is what stops a worktree ever landing
 * on the primary checkout's ports. `every band is clear of the documented
 * ports` in ports.test.mjs is what holds that true if these numbers are edited.
 */
export const BANDS = Object.freeze({
  devWeb: 5300,
  devApi: 8900,
  e2eWeb: 6300,
  e2eApi: 9900,
});

/** How many worktrees can be told apart before two share a slot. */
export const SLOTS = 512;

/** The environment variable that overrides each port, by name. */
export const OVERRIDES = Object.freeze({
  devWeb: 'COCKPIT_DEV_WEB_PORT',
  devApi: 'COCKPIT_DEV_API_PORT',
  e2eWeb: 'COCKPIT_E2E_WEB_PORT',
  e2eApi: 'COCKPIT_E2E_API_PORT',
});

/**
 * The slot a path falls in: FNV-1a over the path, folded into `SLOTS`.
 *
 * The path is normalised first - separators forwards, no trailing slash, folded
 * to lower case - because on Windows the same worktree is reached by several
 * spellings (`C:\GitHub\...` from PowerShell, `C:/GitHub/...` from Git Bash)
 * and all of them have to answer the same, or `pnpm dev` and `pnpm test:e2e`
 * would disagree about which ports this worktree has.
 *
 * FNV-1a rather than a cryptographic hash because nothing here is a secret and
 * the whole point is that it is short, has no dependencies, and gives the same
 * answer on every machine and every Node version.
 */
export function slotFor(path) {
  const normalised = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  let hash = 0x811c9dc5;
  for (let at = 0; at < normalised.length; at += 1) {
    hash ^= normalised.charCodeAt(at);
    // The FNV prime, by shifts: `hash * 16777619` overflows a double's exact
    // integer range, and `Math.imul` keeps it to the 32 bits the algorithm is
    // defined over.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SLOTS;
}

/**
 * Whether this checkout is a linked worktree rather than the primary one.
 *
 * `git worktree add` writes `.git` as a file holding `gitdir: <path>`; a
 * primary checkout has it as a directory. Read from the filesystem rather than
 * by running `git`, so this costs nothing and works before anything is spawned.
 *
 * Anything unreadable answers "primary", which is the conservative way round: a
 * checkout that cannot be identified keeps the documented ports rather than
 * being moved somewhere nobody expects.
 */
export function isLinkedWorktree(root, { look = statSync } = {}) {
  try {
    return look(join(root, '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * The four ports this checkout uses, each one overridable by its own
 * environment variable.
 *
 * `linked` is taken rather than looked up so the deciding is provable without a
 * filesystem; the callers pass `isLinkedWorktree(root)`.
 */
export function portsFor(root, { linked = false, env = {} } = {}) {
  const slot = slotFor(root);
  const port = (which) =>
    asked(env[OVERRIDES[which]], OVERRIDES[which]) ??
    (linked ? BANDS[which] + slot : DOCUMENTED_PORTS[which]);
  // Written out rather than built by a loop over BANDS, so the shape is a shape
  // rather than a bag: playwright.config.ts reads `.e2eWeb` off this and a
  // dynamically-keyed object would give it nothing to check that against.
  return {
    devWeb: port('devWeb'),
    devApi: port('devApi'),
    e2eWeb: port('e2eWeb'),
    e2eApi: port('e2eApi'),
  };
}

/**
 * A port named by hand, or undefined where none was.
 *
 * Refused rather than repaired: a typo would otherwise become `NaN`, and
 * `listen(NaN)` binds a random free port - which is the one outcome this whole
 * module exists to avoid, arrived at silently.
 */
function asked(value, name) {
  if (value === undefined || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} is "${value}", which is not a port number between 1 and 65535.`);
  }
  return port;
}

/**
 * What to say when a port this checkout wants is already taken.
 *
 * It names the override rather than only the problem, because the two things
 * that produce this are a stack left behind by an interrupted run - stop it -
 * and the one-in-512 case of two worktrees sharing a slot, where the answer is
 * to give this one a port of its own for good.
 */
export function howToFreeThePort(which, port) {
  return (
    `Either something is still holding it - most likely a server left behind by an ` +
    `interrupted run - or this checkout shares a slot with another worktree. Stop the ` +
    `first, or give this one a port of its own: ${OVERRIDES[which]}=${port + 1} pnpm dev.`
  );
}
