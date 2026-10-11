import type { DayLine } from './store';

const number = (n: number) => n.toLocaleString('en-US');

/** The public page: tokens per day, newest first. Counts only; never an email or any content. */
export function renderPage(lines: DayLine[]): string {
  const body =
    lines.length === 0
      ? '<p>Nothing yet. No Claude Code requests have been reported.</p>'
      : `<table>
<thead><tr><th>Day (UTC)</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache write</th><th>Cache read</th></tr></thead>
<tbody>
${lines
  .map(
    (l) =>
      `<tr><td>${l.day}</td><td>${number(l.requests)}</td><td>${number(l.inputTokens)}</td><td>${number(l.outputTokens)}</td><td>${number(l.cacheCreationTokens)}</td><td>${number(l.cacheReadTokens)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Monitor</title>
<style>body{font:16px system-ui,sans-serif;margin:2rem auto;max-width:56rem;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{padding:.4rem .6rem;text-align:right;border-bottom:1px solid #8884}th:first-child,td:first-child{text-align:left}</style>
</head><body><h1>Harness Monitor</h1><h2>Tokens per day</h2>
${body}
</body></html>`;
}
