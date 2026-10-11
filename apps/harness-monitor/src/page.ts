import type { LinkingPage, SessionLine } from './linking';
import type { DayLine } from './store';

const number = (n: number) => n.toLocaleString('en-US');

/** Pull request titles are written by anyone, so none reaches the page unescaped. */
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function sessionRow(s: SessionLine): string {
  const cells =
    s.status.kind === 'linked'
      ? [
          `#${s.status.prNumber} ${escape(s.status.title)} (${s.status.state.toLowerCase()})`,
          s.status.issue === null ? 'none' : `#${s.status.issue}`,
          s.status.engineer === null ? 'unknown' : escape(s.status.engineer),
        ]
      : [s.status.kind === 'linking' ? 'linking…' : 'unattributed', '', ''];
  return `<tr><td>${escape(s.sessionId)}</td><td>${s.branch === null ? 'none' : escape(s.branch)}</td><td>${cells.join('</td><td>')}</td></tr>`;
}

function renderLinking({ lastSuccessAt, sessions }: LinkingPage): string {
  const when = lastSuccessAt === null ? 'Branch linking has not succeeded yet.' : `Branch linking last succeeded ${utc(lastSuccessAt)}.`;
  if (sessions.length === 0) return `<p>${when}</p>`;
  return `<p>${when}</p>
<table class="left">
<thead><tr><th>Session</th><th>Branch</th><th>Pull request</th><th>Issue</th><th>Engineer</th></tr></thead>
<tbody>
${sessions.map(sessionRow).join('\n')}
</tbody></table>`;
}

/** The public page: tokens per day, newest first. Counts only; never an email or any content. */
export function renderPage(lines: DayLine[], linking: LinkingPage): string {
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
<style>body{font:16px system-ui,sans-serif;margin:2rem auto;max-width:56rem;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{padding:.4rem .6rem;text-align:right;border-bottom:1px solid #8884}th:first-child,td:first-child{text-align:left}table.left th,table.left td{text-align:left}</style>
</head><body><h1>Harness Monitor</h1><h2>Tokens per day</h2>
${body}
<h2>Sessions</h2>
${renderLinking(linking)}
</body></html>`;
}
