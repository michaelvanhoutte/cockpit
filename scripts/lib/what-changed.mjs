//
// Whether a diff touches anything the mechanical checks cover.
//
// Typecheck, Lint, Test, E2E (F3) and Build read product sources; a diff
// confined to `docs/`, `.claude/` or a root-level `*.md` cannot make any of them
// say anything new. "Document that claude-review passes on any finding, not just
// a clean one" (pull request 341) paid the full suite - 7.7 minutes of browser
// tier alone - to establish that about a CLAUDE.md edit, which is what "Skip the
// mechanical checks on a pull request that touches nothing they cover" (issue
// 345) is about.
//
// CodeQL's two legs are not gated on this, though the issue listed them:
// codeql.yml says why, and deployment.md's "Bootstrap runbook" holds the
// measurement behind it.
//
// **An allowlist, so anything unrecognised runs everything.** A path counts as
// non-product only by matching one of the three rules below, which is what keeps
// `.github/workflows/**`, `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`,
// `playwright.config.ts`, `wrangler.jsonc` and every file under `apps/`,
// `packages/`, `scripts/` and `tools/` gating without an entry of their own. A
// denylist gets the opposite failure - the path nobody thought of ships
// untested - and it is silent.
//
// Everything here reads nothing of its own: no filesystem, no environment, no
// subprocess, for the reason review-gate.mjs gives. `classify` takes the two
// pieces of I/O it needs as functions, so every way this can fail is a case in
// what-changed.test.mjs rather than a path only a runner ever walks;
// `scripts/what-changed.mjs` is the dozen lines that supply them.
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

/** A path list with the blanks dropped, which is the only shape below reads. */
function normalize(paths) {
  return (paths ?? []).map((path) => String(path ?? '').trim()).filter((path) => path !== '');
}

/**
 * The product-affecting paths in a diff, for a run log that has to say why the
 * suite ran.
 */
export function productPaths(paths) {
  return normalize(paths).filter((path) => !isNonProduct(path));
}

/**
 * Whether this diff needs the mechanical jobs to run.
 *
 * One product-affecting path is enough: a mixed diff runs everything, because
 * the docs half says nothing about the code half. Asked of `productPaths` rather
 * than deciding a second time, so the answer and the reasons the job prints
 * beside it cannot disagree.
 *
 * An empty list is `true`, not `false`. A diff that changed nothing is possible
 * - an empty commit on `main` - and so is a range this could not read, and the
 * two are indistinguishable from here. Skipping the suite on "no paths" would
 * make every failure to compute one look like a documentation change.
 */
export function productChanged(paths) {
  const files = normalize(paths);
  return files.length === 0 || productPaths(files).length > 0;
}

/** Anything at or below this is a control character, and never part of a path. */
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;

/**
 * One line of text with nothing in it a runner would read as an instruction.
 *
 * Everything logged below is a path out of `git diff` or a message out of git,
 * so a branch may choose it: `apps/x.ts` followed by a newline and
 * `::stop-commands::` is a legal filename, and printed raw it turns the rest of
 * the job's log into whatever its author wanted. Actions' commands are
 * line-based, so flattening the control characters stops all of them.
 */
export function printable(text) {
  return [...String(text ?? '')]
    .map((character) => {
      const code = character.codePointAt(0);
      return code < FIRST_PRINTABLE || code === DELETE ? '?' : character;
    })
    .join('');
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

/** The event payload, or `{}` where there is none to read or none to parse. */
function parseEvent(readFile, eventPath) {
  try {
    return JSON.parse(readFile(eventPath ?? ''));
  } catch {
    return {};
  }
}

/** How many product paths a run log names before it starts counting instead. */
const NAMED = 20;

/**
 * The whole decision, and the lines the job should print beside it.
 *
 * `readFile` is handed `GITHUB_EVENT_PATH` and returns its text; `gitDiff` is
 * handed a range and returns `git diff --name-only -z` output. Either may throw,
 * and the reason both are arguments is that **every way this can fail has to say
 * "product changed"**: a skipped job satisfies a required status check
 * (docs/deployment.md, "Bootstrap runbook"), so a crash that read as
 * "documentation only" would wave an untested change through five green ticks.
 */
export function classify({ eventName, eventPath, readFile, gitDiff } = {}) {
  const range = diffRange({ eventName, event: parseEvent(readFile, eventPath) });
  if (range === null) {
    return { changed: true, lines: [`No diff range for a ${printable(eventName ?? 'nameless')} event, so every check runs.`] };
  }

  let paths;
  try {
    paths = pathsFromDiff(gitDiff(range));
  } catch (error) {
    const why = printable(String(error?.message ?? error).replace(/\s+/g, ' ').trim());
    return { changed: true, lines: [`::warning::Could not diff ${range}, so every check runs: ${why}`] };
  }

  const forcing = productPaths(paths);
  const lines = [`${range}: ${paths.length} path(s) changed, ${forcing.length} of them product.`];
  // Named, because "why did this run" is the only question anybody asks of this
  // job, and the answer is usually one path. Capped, so a large diff does not
  // print itself into the log for an answer nobody is in doubt about.
  for (const path of forcing.slice(0, NAMED)) lines.push(`  ${printable(path)}`);
  if (forcing.length > NAMED) lines.push(`  ... and ${forcing.length - NAMED} more`);
  return { changed: productChanged(paths), lines };
}
