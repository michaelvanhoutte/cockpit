#!/usr/bin/env node
/**
 * The wiring, and the only place the two halves meet.
 *
 *   analyze(repo) -> Model -> renderHtml(Model) -> a file
 *
 * `--json` stops after the first arrow, so anything else can consume the model:
 * a different renderer, a CI check, a diff against the previous run. That is the
 * escape hatch that makes the shape of the report cheap to change.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from './analyze/index.js';
import { renderHtml } from './render/html.js';
import { LEVEL_IDS, rollup, walk } from './model.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = path.resolve(here, '../../..');

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const repo = path.resolve(args.repo ?? DEFAULT_REPO);
  const model = analyze(repo);

  for (const warning of model.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }

  if (args.json) {
    const out = args.out ?? path.join(here, '../out/model.json');
    write(out, JSON.stringify(model, null, 2));
    process.stderr.write(`wrote ${path.relative(repo, out)}\n`);
    return 0;
  }

  if (args.check) return check(model);

  const out = args.out ?? path.join(here, '../out/index.html');
  write(out, renderHtml(model));
  process.stderr.write(`wrote ${path.relative(repo, out)}\n`);
  return 0;
}

/**
 * The gate this would become, kept deliberately dumb: exit non-zero when any
 * obligation is required and absent. It reports rather than blocks today, since
 * nothing is wired into CI.
 */
function check(model) {
  rollup(model.root);
  const failures = [];
  for (const node of walk(model.root)) {
    for (const level of LEVEL_IDS) {
      const cell = node.own?.[level];
      if (cell?.state === 'gap') failures.push({ path: node.path, level, why: cell.why });
    }
  }

  if (!failures.length) {
    process.stdout.write('No unmet obligations.\n');
    return 0;
  }

  process.stdout.write(`${failures.length} unmet obligation(s):\n\n`);
  for (const f of failures) {
    process.stdout.write(`  ${f.level.padEnd(3)} ${f.path}\n`);
    if (f.why) process.stdout.write(`      ${wrap(f.why, 96, '      ')}\n`);
  }
  process.stdout.write('\nThis POC reports; it does not gate. See docs/coverage-reporting-options.md, decision 4.\n');
  return 0;
}

function wrap(text, width, indent) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n' + indent);
}

function write(file, contents) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--check') args.check = true;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--repo') args.repo = argv[++i];
    else {
      process.stderr.write(`unknown argument: ${a}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  return args;
}

const USAGE = `Usage: node src/cli.js [options]

  --out <file>   Where to write. Defaults to out/index.html, or out/model.json with --json.
  --repo <dir>   Repository to analyze. Defaults to the repo this POC sits in.
  --json         Emit the model instead of a page, for another consumer.
  --check        List unmet obligations on stdout. Reports, does not gate.
  --help         This.
`;

process.exitCode = main(process.argv.slice(2));
