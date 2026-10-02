// UserPromptSubmit hook: a prompt starting `/build <number>` (or `/build <issue URL>`) names the session `#<number> <title>`.
import { execFileSync } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const event = JSON.parse(input);
  const prompt = String(event.prompt ?? event.user_message ?? '');
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
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: `#${number} ${title}` },
        }),
      );
    }
  }
} catch {
  // A failing hook must never block the prompt; the session just keeps its default title.
}
