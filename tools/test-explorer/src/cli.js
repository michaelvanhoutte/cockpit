/**
 * The wiring, and the only place analyze/ and the Harness Monitor meet.
 *
 *   analyze(repo) -> Model -> a model file
 *   a model file  -> sendSnapshot(Model) -> the Harness Monitor, with --send
 *
 * The Harness Monitor draws the Tests page from the model. `--send` reads a
 * model an earlier run wrote rather than analyzing, so the job holding the
 * write key needs neither the repository's packages nor its tests.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { walkTree } from './model.js';
import { MonitorError, sendSnapshot, whose } from './monitor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(here, '../../..');

async function main(argv) {
  const args = parseArgs(argv);
  if (args.unknown) {
    process.stderr.write(`unknown argument: ${args.unknown}\n\n${USAGE}`);
    return 2;
  }
  if (args.invalid) {
    process.stderr.write(`${args.invalid}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.send) return send(args.send, args.pullRequest ?? null);

  // Imported here rather than at the top, so `--send` runs without the packages analyze/ parses with.
  const { analyze } = await import('./analyze/index.js');
  const repo = path.resolve(args.repo ?? DEFAULT_REPO);

  if (args.checkConcepts) return checkConcepts(analyze(repo));

  const model = analyze(repo);
  for (const warning of model.warnings) process.stderr.write(`warning: ${warning}\n`);

  const out = path.resolve(args.model ?? path.join(here, '../out/model.json'));
  write(out, JSON.stringify(model));
  process.stderr.write(`wrote ${path.relative(repo, out)}\n`);
  return 0;
}

/**
 * Sends the model in `file` to the Harness Monitor at $HARNESS_MONITOR_URL
 * with $HARNESS_WRITE_KEY, as `main`'s tests or `pullRequest`'s, and exits
 * non-zero naming the part it refused.
 */
async function send(file, pullRequest) {
  const url = process.env.HARNESS_MONITOR_URL;
  const key = process.env.HARNESS_WRITE_KEY;
  if (!url || !key) {
    process.stderr.write('--send needs HARNESS_MONITOR_URL and HARNESS_WRITE_KEY set (docs/deployment.md, "The Harness Monitor").\n');
    return 2;
  }
  let model;
  try {
    model = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`Could not read the model at ${file}: ${error.message}\n`);
    return 2;
  }
  try {
    const sent = await sendSnapshot({ url, key, model, pullRequest });
    const largest = sent.largestArea ? `, the largest area ${JSON.stringify(sent.largestArea.key)} at ${sent.largestArea.bytes} bytes` : '';
    process.stderr.write(`sent ${whose(pullRequest)} at ${sent.commit} to the Harness Monitor and showed them: the tree at ${sent.treeBytes} bytes gzipped and ${sent.areas} areas${largest}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof MonitorError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

/**
 * docs/test-explorer-spec.md §7 (amended by §2a): every feature area a test
 * file actually declares (its outer describe) must be registered in
 * concepts.json. Exits nonzero listing every unregistered name — this is the
 * check CI runs, and it is a build-hygiene failure (a typo, or a new area
 * nobody added yet), not a judgment about test coverage. It also fails on an
 * entry of not-worth-a-test.json it cannot place, as it does on an
 * unregistered area (`conceptsCheck`).
 *
 * This replaced the original "every source file matches exactly one area"
 * check: once a file could legitimately back more than one feature area
 * (testing-strategy.md §9.1's undotted-area convention), there was nothing
 * left for a file-overlap check to reject.
 */
function checkConcepts(model) {
  const { code, text } = conceptsCheck(model);
  process.stdout.write(text);
  return code;
}

/**
 * The check's verdict on a model, as the exit code and what it prints: it fails
 * on an unregistered area, and on an entry of not-worth-a-test.json the analyzer
 * could not place, each named. Pure, so a test can hold it to an analyzed
 * fixture repository.
 *
 * @param {import('./model.js').Model} model
 * @returns {{ code: number, text: string }}
 */
export function conceptsCheck(model) {
  const problems = model.notWorthATestProblems ?? [];
  const lines = [];
  if (model.unregisteredAreas.length) {
    lines.push(`${model.unregisteredAreas.length} feature area(s) used in tests but missing from concepts.json:`, '');
    for (const name of model.unregisteredAreas) lines.push(`  ${name}`);
    lines.push('', 'Add the area to tools/test-explorer/concepts.json, or fix the typo in the describe.');
  }
  if (problems.length) {
    if (lines.length) lines.push('');
    lines.push(`${problems.length} entr${problems.length === 1 ? 'y' : 'ies'} of tools/test-explorer/not-worth-a-test.json that cannot be placed:`, '');
    for (const problem of problems) lines.push(`  ${problem}`);
    lines.push('', 'Each entry names a source file the analyzer walks, with a reason and how many of its statements were not run when decided.');
  }
  if (lines.length) return { code: 1, text: `${lines.join('\n')}\n` };
  const nodes = [...walkTree(model.tree)];
  const total = nodes.reduce((sum, n) => sum + n.rules.length, 0);
  return { code: 0, text: `concepts.json OK: ${total} rule(s) across ${nodes.length} area(s), nothing unregistered; ${(model.notWorthATest ?? []).length} file(s) decided not worth a test, each placed.\n` };
}

function write(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

/**
 * Pure: no process.exit, no I/O — an unrecognized flag comes back as
 * `{ unknown: a }`, and a flag missing its value or flags that do not combine
 * as `{ invalid: reason }`, for
 * main() to act on, rather than parseArgs deciding how the process ends.
 * That's what makes this testable as plain logic.
 *
 * @param {string[]} argv
 * @returns {{ help?: boolean, checkConcepts?: boolean, repo?: string, model?: string, send?: string, pullRequest?: number, unknown?: string, invalid?: string }}
 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--check-concepts') args.checkConcepts = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--model' || a === '--send') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { invalid: `${a} needs a path to a model file` };
      args[a.slice(2)] = value;
    } else if (a === '--pull-request') {
      const value = argv[++i];
      if (!value || !/^[1-9]\d{0,9}$/.test(value)) return { invalid: '--pull-request needs a pull request number' };
      args.pullRequest = Number(value);
    } else return { unknown: a };
  }
  if (args.model && args.checkConcepts) return { invalid: '--model writes the model, so it does not combine with --check-concepts' };
  if (args.pullRequest !== undefined && !args.send) return { invalid: '--pull-request names whose tests --send sends, so it needs --send' };
  if (args.send && Object.keys(args).some((name) => name !== 'send' && name !== 'pullRequest')) return { invalid: '--send reads a model and writes nothing, so it takes no option but --pull-request' };
  return args;
}

const USAGE = `Usage: node src/cli.js [options]

  --model <file>     Where to write the model. Defaults to out/model.json.
  --repo <dir>        Repository to analyze. Defaults to the repo this tool sits in.
  --send <file>      Send the model a run wrote to the Harness Monitor at
                       $HARNESS_MONITOR_URL with $HARNESS_WRITE_KEY, as main's tests, and write nothing.
  --pull-request <n> With --send: send them as pull request n's tests instead.
  --check-concepts   Fail if any test declares a feature area missing from concepts.json, or if
                       not-worth-a-test.json has an entry it cannot place.
  --help                This.
`;

// Guarded so that importing this module (tests/unit/cli.test.js imports parseArgs) never runs the
// real CLI against the test runner's own process.argv — only running `node src/cli.js` does.
// pathToFileURL (not a raw `file://` template) so this compares correctly on Windows, where
// process.argv[1] is backslash-separated and needs proper drive-letter/URL encoding to match
// import.meta.url's file:///C:/... form.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    },
  );
}
