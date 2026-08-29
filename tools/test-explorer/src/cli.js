/**
 * The wiring, and the only place analyze/ and render/ meet.
 *
 *   analyze(repo) -> Model -> renderHtml(Model) -> a file
 *
 * `--json` stops after the first arrow, so anything else can consume the
 * model: a different renderer, a CI check, a diff against the previous run.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { analyze } from './analyze/index.js';
import { renderHtml } from './render/html.js';
import { walkTree } from './model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(here, '../../..');

function main(argv) {
  const args = parseArgs(argv);
  if (args.unknown) {
    process.stderr.write(`unknown argument: ${args.unknown}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const repo = path.resolve(args.repo ?? DEFAULT_REPO);

  if (args.checkConcepts) return checkConcepts(repo);

  const model = analyze(repo);
  for (const warning of model.warnings) process.stderr.write(`warning: ${warning}\n`);

  if (args.json) {
    const out = args.out ?? path.join(here, '../out/model.json');
    write(out, JSON.stringify(model, null, 2));
    process.stderr.write(`wrote ${path.relative(repo, out)}\n`);
    return 0;
  }

  const out = args.out ?? path.join(here, '../out/index.html');
  // File links in the report (rule/gap file:line) need to know where the
  // report itself will be opened from, to compute a relative href — a render
  // concern (docs/test-explorer-spec.md §6.1's split keeps analyze/ ignorant
  // of it), so it's built here rather than inside renderHtml or the Model.
  const repoRelPrefix = path.relative(path.dirname(out), repo).split(path.sep).join('/');
  write(out, renderHtml(model, { repoRelPrefix }));
  process.stderr.write(`wrote ${path.relative(repo, out)}\n`);
  return 0;
}

/**
 * docs/test-explorer-spec.md §7 (amended by §2a): every feature area a test
 * file actually declares (its outer describe) must be registered in
 * concepts.json. Exits nonzero listing every unregistered name — this is the
 * check CI runs, and it is a build-hygiene failure (a typo, or a new area
 * nobody added yet), not a judgment about test coverage.
 *
 * This replaced the original "every source file matches exactly one area"
 * check: once a file could legitimately back more than one feature area
 * (testing-strategy.md §9.1's undotted-area convention), there was nothing
 * left for a file-overlap check to reject.
 */
function checkConcepts(repo) {
  const model = analyze(repo);
  if (!model.unregisteredAreas.length) {
    const nodes = [...walkTree(model.tree)];
    const total = nodes.reduce((sum, n) => sum + n.rules.length, 0);
    process.stdout.write(`concepts.json OK: ${total} rule(s) across ${nodes.length} area(s), nothing unregistered.\n`);
    return 0;
  }

  process.stdout.write(`${model.unregisteredAreas.length} feature area(s) used in tests but missing from concepts.json:\n\n`);
  for (const name of model.unregisteredAreas) process.stdout.write(`  ${name}\n`);
  process.stdout.write('\nAdd the area to tools/test-explorer/concepts.json, or fix the typo in the describe.\n');
  return 1;
}

function write(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/**
 * Pure: no process.exit, no I/O — an unrecognized flag comes back as
 * `{ unknown: a }` for main() to act on, rather than parseArgs deciding how
 * the process ends. That's what makes this testable as plain logic.
 *
 * @param {string[]} argv
 * @returns {{ help?: boolean, json?: boolean, checkConcepts?: boolean, out?: string, repo?: string, unknown?: string }}
 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--check-concepts') args.checkConcepts = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else return { unknown: a };
  }
  return args;
}

const USAGE = `Usage: node src/cli.js [options]

  --out <file>       Where to write. Defaults to out/index.html, or out/model.json with --json.
  --repo <dir>        Repository to analyze. Defaults to the repo this tool sits in.
  --json               Emit the model instead of a page, for another consumer.
  --check-concepts   Fail if any test declares a feature area missing from concepts.json.
  --help                This.
`;

// Guarded so that importing this module (tests/unit/cli.test.js imports parseArgs) never runs the
// real CLI against the test runner's own process.argv — only running `node src/cli.js` does.
// pathToFileURL (not a raw `file://` template) so this compares correctly on Windows, where
// process.argv[1] is backslash-separated and needs proper drive-letter/URL encoding to match
// import.meta.url's file:///C:/... form.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
