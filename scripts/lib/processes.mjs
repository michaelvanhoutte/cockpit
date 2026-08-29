//
// Process plumbing shared by scripts/dev.mjs (the app you develop against) and
// scripts/e2e-stack.mjs (the throwaway stack the browser tests drive). Both
// need the same three things and got them wrong in the same ways: spawning
// pnpm portably, prefixing two servers' interleaved output, and taking the
// whole tree down when one half dies or Ctrl+C arrives.
//
// Extracted when the second script appeared rather than copied, because the
// Windows-specific parts below are exactly the kind of detail that gets fixed
// in one copy and not the other.
//

import { spawn } from 'node:child_process';

export const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';

// Node refuses to spawn a .cmd without a shell (the CVE-2024-27980 fix), and on
// Windows pnpm *is* a .cmd, so every spawn there goes through cmd.exe. Passing an
// args array *and* shell:true is deprecated (DEP0190) and warns on every start, so
// Windows gets one command string instead. Every argument is a literal defined by
// the callers, so there is nothing to escape either way.
export const command = (args) =>
  isWindows
    ? { file: [pnpm, ...args].join(' '), args: [], options: { shell: true } }
    : { file: pnpm, args, options: {} };

const color = !process.env.NO_COLOR && process.stdout.isTTY;
// ESC from its char code so the source carries no escape sequence of its own.
const ESC = String.fromCharCode(27);
export const paint = (code, text) => (color ? ESC + '[' + code + 'm' + text + ESC + '[0m' : text);

/** Run one command to completion. Resolves only on exit code 0. */
export function run(args, label, cwd) {
  return new Promise((resolve, reject) => {
    console.log(paint('2', `> ${label}`));
    const { file, args: argv, options } = command(args);
    const child = spawn(file, argv, { cwd, stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`)),
    );
  });
}

/** Start a long-running process, prefixing every line it prints. */
export function start(args, name, colorCode, cwd, env) {
  const tag = paint(colorCode, `[${name}]`);
  const { file, args: argv, options } = command(args);
  const child = spawn(file, argv, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env: { ...process.env, ...env } } : {}),
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

/**
 * Ties a set of long-running children together: Ctrl+C stops all of them, and
 * one of them exiting stops the rest rather than leaving half an application
 * listening and looking healthy.
 */
export function supervise(children) {
  let shuttingDown = false;

  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      // Wrangler and Vite each spawn their own children. On Windows killing the
      // parent orphans them and leaves the ports held, so kill the tree.
      if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
    process.exitCode = code;
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  for (const child of children) {
    // A child that died before this ran has already emitted 'exit', and Node
    // does not replay it for a listener attached afterwards — so without this
    // check the caller would supervise a corpse and keep the rest running. That
    // is reachable: callers start their children one at a time, and anything
    // between the first spawn and this call is a window one of them can die in.
    if (child.exitCode !== null || child.signalCode !== null) {
      console.error(paint('31', `\na server exited (${child.exitCode ?? child.signalCode}) before it could be supervised; stopping the rest`));
      shutdown(child.exitCode ?? 1);
      break;
    }
    child.on('exit', (code) => {
      if (!shuttingDown) console.error(paint('31', `\na server exited (${code}); stopping the rest`));
      shutdown(code ?? 1);
    });
    child.on('error', (error) => {
      console.error(paint('31', `\nfailed to start: ${error.message}`));
      shutdown(1);
    });
  }

  return shutdown;
}
