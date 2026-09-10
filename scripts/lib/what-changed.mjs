//
// Whether a diff touches anything the mechanical checks cover.
//
// Typecheck, Lint, Test, E2E (F3), Build, Scripts and CodeQL's two legs read
// product sources; a diff confined to `docs/`, `.claude/` or a root-level `*.md`
// cannot make any of them say anything new. "Document that claude-review passes
// on any finding, not just a clean one" (pull request 341) paid the full suite -
// 7.7 minutes of browser tier alone - to establish that about a CLAUDE.md edit,
// which is what "Skip the mechanical checks on a pull request that touches
// nothing they cover" (issue 345) is about.
//
// **An allowlist, so anything unrecognised runs everything.** A path counts as
// non-product only by matching one of the three rules below, which is what keeps
// `.github/workflows/**`, `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`,
// `playwright.config.ts`, `wrangler.jsonc` and every file under `apps/`,
// `packages/`, `scripts/` and `tools/` gating without an entry of their own. A
// denylist gets the opposite failure - the path nobody thought of ships
// untested - and it is silent.
//
// Everything here takes its inputs as arguments and reads nothing: no
// filesystem, no environment, no subprocess, for the reason review-gate.mjs
// gives. `scripts/what-changed.mjs` is the I/O around it, and the workflows call
// that.
//

/** Directory prefixes whose files no mechanical check reads. */
const NON_PRODUCT_DIRS = ['docs/', '.claude/'];

/**
 * A root-level Markdown file - `CLAUDE.md`, `readme.md`. No slash, so a
 * `.md` anywhere else is matched by its directory or not at all: `apps/web/`
 * holds no prose worth an exception, and one nested under `tools/` is a
 * package's own readme sitting beside code the checks do read.
 */
const ROOT_MARKDOWN = /^[^/]+\.md$/;

/**
 * Whether one changed path is one the mechanical checks have no opinion about.
 *
 * Exact, case-sensitive prefixes. GitHub's filesystem is case-sensitive and
 * `Docs/` is not a directory here, so an unexpected case falls through to
 * "product" - the direction that costs a CI run rather than a merge.
 */
export function isNonProduct(path) {
  const file = String(path ?? '').trim();
  if (file === '') return false;
  if (NON_PRODUCT_DIRS.some((dir) => file.startsWith(dir))) return true;
  return ROOT_MARKDOWN.test(file);
}

/**
 * Whether this diff needs the mechanical jobs to run.
 *
 * One product-affecting path is enough: a mixed diff runs everything, because
 * the docs half says nothing about the code half.
 *
 * An empty list is `true`, not `false`. A diff that changed nothing is possible
 * - an empty commit on `main` - and so is a range this could not read, and the
 * two are indistinguishable from here. Skipping the suite on "no paths" would
 * make every failure to compute one look like a documentation change.
 */
export function productChanged(paths) {
  const files = (paths ?? []).map((path) => String(path ?? '').trim()).filter((path) => path !== '');
  if (files.length === 0) return true;
  return files.some((path) => !isNonProduct(path));
}

/**
 * The product-affecting paths in a diff, for a run log that has to say why the
 * suite ran.
 */
export function productPaths(paths) {
  return (paths ?? []).map((path) => String(path ?? '').trim()).filter((path) => path !== '' && !isNonProduct(path));
}

/** `git diff --name-only -z` output, which is NUL-separated and never quoted. */
export function pathsFromDiff(stdout) {
  return String(stdout ?? '')
    .split('\0')
    .map((path) => path.trim())
    .filter((path) => path !== '');
}

/** A commit GitHub will name in an event payload. */
const SHA = /^[0-9a-f]{40}$/i;

/** What `before` is on a push that has no previous commit to diff against. */
const NO_COMMIT = '0'.repeat(40);

/**
 * What to hand `git diff`, or null where this run cannot work one out - which
 * the caller reads as "run everything".
 *
 * `event` is the payload at `GITHUB_EVENT_PATH`, parsed. Reading the payload
 * rather than taking the shas as interpolated `${{ }}` values keeps an
 * attacker-controllable string out of a `run:` block, which is one of the things
 * CodeQL's `actions` leg is here to find.
 *
 * - **A pull request** diffs `base...head`, so the range holds what the branch
 *   added rather than what `main` has moved on by since. Both commits are
 *   parents of the merge commit the runner checked out, so a full-history
 *   checkout has them.
 * - **A push**, which ci.yml only ever takes on `main`, diffs `before..after`:
 *   the commits that merge actually brought in. A first push has no `before` and
 *   a force push may have left it unreachable, so both fall back to null.
 *
 * Anything else - a re-run dispatched by hand, a schedule - is null as well. A
 * range that is not a pair of real commits is not one to guess at.
 */
export function diffRange({ eventName, event } = {}) {
  const payload = event ?? {};
  if (eventName === 'pull_request') {
    const base = payload.pull_request?.base?.sha;
    const head = payload.pull_request?.head?.sha;
    return SHA.test(String(base ?? '')) && SHA.test(String(head ?? '')) ? `${base}...${head}` : null;
  }
  if (eventName === 'push') {
    const before = String(payload.before ?? '');
    const after = String(payload.after ?? '');
    if (before === NO_COMMIT || !SHA.test(before) || !SHA.test(after)) return null;
    return `${before}..${after}`;
  }
  return null;
}
