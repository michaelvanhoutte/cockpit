// SessionStart hook: a session whose branch has no commits of its own and sits behind origin/main is fast-forwarded to it.
// The desktop app cuts a worktree from local main, which only moves when a session starts in the main checkout, so a new session can start stale.
// A branch with commits of its own is left alone: main is merged in only when GitHub reports a conflict.
// The desktop app ignores project-level hooks, so a user-level SessionStart launcher has to run this file from the session's cwd.
import { execFileSync } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  const { cwd } = JSON.parse(input);
  git(cwd, 'fetch', '--quiet', 'origin', 'main');
  const behind = Number(git(cwd, 'rev-list', '--count', 'HEAD..origin/main'));
  const ahead = Number(git(cwd, 'rev-list', '--count', 'origin/main..HEAD'));
  if (behind > 0 && ahead === 0 && git(cwd, 'status', '--porcelain') === '') {
    git(cwd, 'merge', '--ff-only', '--quiet', 'origin/main');
    const message = `Fast-forwarded to origin/main (${behind} new commit${behind === 1 ? '' : 's'}): the branch had no work of its own and started behind.`;
    process.stdout.write(
      JSON.stringify({
        systemMessage: message,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
      }),
    );
  }
} catch {
  // Offline, not a repository, or a branch that will not fast-forward: the session starts where it is.
}
