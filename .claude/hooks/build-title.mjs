// UserPromptSubmit hook: a prompt starting `/build <number>` (or `/build <issue URL>`) hands the agent the session title `#<number> <title>`.
// `sessionTitle` is honoured only on SessionStart, which fires before the prompt exists, so the agent sets it with `set_session_title`.
// The desktop app ignores project-level hooks, so ~/.claude/settings.json registers a UserPromptSubmit launcher
// (~/.claude/hooks/run-project-build-title.mjs) that runs this file from the session's cwd.
import { execFileSync } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const event = JSON.parse(input);
  const prompt = String(event.prompt ?? event.user_input ?? event.user_message ?? '');
  const number = /^\s*\/build\s+(?:#|\S*\/issues\/)?(\d+)/.exec(prompt)?.[1];
  if (number) {
    const title = execFileSync(
      'gh',
      ['issue', 'view', number, '--json', 'title', '-q', '.title'],
      { encoding: 'utf8', cwd: event.cwd, timeout: 15000 },
    ).trim();
    if (title) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              `Session title: before anything else, load \`set_session_title\` with ToolSearch (select:mcp__ccd_session_mgmt__set_session_title) and call it with exactly ${JSON.stringify(`#${number} ${title}`)}. Skip it if ToolSearch finds no such tool.`,
          },
        }),
      );
    }
  }
} catch {
  // A failing hook must never block the prompt; the session just keeps its default title.
}
