#!/usr/bin/env node
//
// Start Cockpit locally with one command: `pnpm dev`.
//
// The testing strategy's definition of done requires that the application be
// started and the changed behaviour actually exercised before anything is
// claimed to work, and its enforcement section asks for the one-command way to
// do that to be written down. Four steps across two terminals is the kind of
// friction that turns "start the app" into "the unit tests passed", so this
// collapses them into one command that is safe to re-run.
//
// What it does, in order:
//   1. Applies D1 migrations locally, then the seed. Both are idempotent
//      (`migrations apply` skips what it has already run, seed.sql is
//      INSERT OR IGNORE), so this runs on every start rather than being a
//      one-time step someone has to remember or a state file that can lie.
//   2. Builds apps/web/dist if it is missing. Wrangler refuses to start when
//      the assets directory in wrangler.jsonc does not exist. Only existence
//      matters here — the SPA is served by Vite on :5173 during development,
//      so a stale dist is fine and rebuilding it on every start is not worth
//      the wait. `pnpm build` when a real one is needed.
//   3. Runs the API and the web dev server together, output prefixed per
//      process, either one exiting or Ctrl+C bringing down both.
//
// Node rather than bash, unlike the other scripts here: those run in CI on
// Ubuntu, this one runs on whatever the developer is using, and on Windows a
// bash script invoked through a pnpm script depends on which shell pnpm picks.
// Node is already a hard requirement (>=22) and needs no dependency to do this.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
// Node refuses to spawn a .cmd without a shell (the CVE-2024-27980 fix), and on
// Windows pnpm *is* a .cmd, so every spawn there goes through cmd.exe. Passing an
// args array *and* shell:true is deprecated (DEP0190) and warns on every start, so
// Windows gets one command string instead. Every argument is a literal defined in
// this file, so there is nothing to escape either way.
const command = (args) =>
  isWindows
    ? { file: [pnpm, ...args].join(' '), args: [], options: { shell: true } }
    : { file: pnpm, args, options: {} };
const color = !process.env.NO_COLOR && process.stdout.isTTY;
// ESC from its char code so the source carries no escape sequence of its own.
const ESC = String.fromCharCode(27);
const paint = (code, text) => (color ? ESC + '[' + code + 'm' + text + ESC + '[0m' : text);

/** Run one command to completion. Resolves only on exit code 0. */
function run(args, label) {
  return new Promise((resolve, reject) => {
    console.log(paint('2', `> ${label}`));
    const { file, args: argv, options } = command(args);
    const child = spawn(file, argv, { cwd: root, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`)),
    );
  });
}

/** Start a long-running process, prefixing every line it prints. */
function start(args, name, colorCode) {
  const tag = paint(colorCode, `[${name}]`);
  const { file, args: argv, options } = command(args);
  const child = spawn(file, argv, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  // Buffered per stream, because a chunk boundary lands mid-line often enough
  // that unbuffered prefixing visibly mangles Vite's and Wrangler's output.
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) console.log(`${tag} ${line}`);
    });
    stream.on('end', () => {
      if (rest) console.log(`${tag} ${rest}`);
    });
  }

  return child;
}

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    // Wrangler and Vite each spawn their own children. On Windows killing the
    // parent orphans them and leaves :8787 and :5173 held, so kill the tree.
    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

try {
  await run(['--filter', '@cockpit/api', 'db:migrate:local'], 'applying migrations');
  await run(['--filter', '@cockpit/api', 'db:seed:local'], 'seeding');

  if (!existsSync(join(root, 'apps/web/dist/index.html'))) {
    console.log(paint('2', '  apps/web/dist is missing; Wrangler needs it to start'));
    await run(['build'], 'building');
  }
} catch (error) {
  console.error(paint('31', `\n${error.message}`));
  process.exit(1);
}

console.log(
  `\n${paint('36', 'api')} http://localhost:8787   ${paint('35', 'web')} http://localhost:5173   (Ctrl+C to stop both)\n`,
);

children.push(start(['--filter', '@cockpit/api', 'dev'], 'api', '36'));
children.push(start(['--filter', '@cockpit/web', 'dev'], 'web', '35'));

for (const child of children) {
  child.on('exit', (code) => {
    // One half of the app dying leaves the other half serving something
    // broken, so it takes the whole command down rather than looking healthy.
    if (!shuttingDown) console.error(paint('31', `\na dev server exited (${code}); stopping both`));
    shutdown(code ?? 1);
  });
  child.on('error', (error) => {
    console.error(paint('31', `\nfailed to start: ${error.message}`));
    shutdown(1);
  });
}
