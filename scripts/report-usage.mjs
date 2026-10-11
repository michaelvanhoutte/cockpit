#!/usr/bin/env node
//
// Stop hook: sends the Harness Monitor each request this session has made and
// not yet sent. The I/O around scripts/lib/usage-report.mjs, which decides
// everything. Registered in .claude/settings.json to run in the background
// under a short timeout.
//
// Needs HARNESS_WRITE_KEY and HARNESS_MONITOR_URL in the environment; without
// the key it does nothing. **It always exits 0 and prints nothing**, so a
// session is never held up or broken by it. What was sent is remembered in a
// file per session in the git directory, so a failed send is made up on the
// next turn.
//

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { allRequests, parseLog, sendUnsent, toRow, whereItRan } from './lib/usage-report.mjs';
import { parseRecord, recordFileName } from './lib/session-record.mjs';

const SEND_TIMEOUT_MS = 8000;

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

async function main() {
  const key = process.env.HARNESS_WRITE_KEY;
  const url = process.env.HARNESS_MONITOR_URL;
  if (!key || !url) return;

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input);
  const transcript = String(event.transcript_path ?? '');
  const sessionId = String(event.session_id ?? '');
  if (!transcript || !sessionId || !existsSync(transcript)) return;

  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8', cwd: event.cwd || undefined }).trim();

  const logs = [{ lines: parseLog(read(transcript)), sessionId, subagent: false }];
  const subagents = join(dirname(transcript), sessionId, 'subagents');
  if (existsSync(subagents)) {
    for (const name of readdirSync(subagents).filter((n) => n.endsWith('.jsonl'))) {
      logs.push({ lines: parseLog(read(join(subagents, name))), sessionId, subagent: true });
    }
  }

  const marksOf = (branch) => {
    try {
      return parseRecord(read(join(gitDir, recordFileName(branch))));
    } catch {
      return [];
    }
  };
  const ranWhere = whereItRan(process.env);
  const rows = allRequests(logs).map((request) => toRow(request, { ranWhere, marksOf }));

  const sentFile = join(gitDir, `cockpit-usage-sent.${encodeURIComponent(sessionId).replaceAll('%', '_')}.json`);
  let sentIds = [];
  try {
    sentIds = JSON.parse(read(sentFile) || '[]');
  } catch {
    sentIds = [];
  }

  const endpoint = new URL('/v1/usage', url);
  const { sent } = await sendUnsent({
    key,
    rows,
    sentIds,
    post: async (batch) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ rows: batch }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      return response.ok;
    },
  });
  writeFileSync(sentFile, JSON.stringify([...sent]));
}

try {
  await main();
} catch {
  // Never hold up or break the session.
}
process.exit(0);
