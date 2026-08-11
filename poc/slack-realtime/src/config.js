// Minimal .env reader so the POC stays dependency-free.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
    let raw;
    try {
        raw = readFileSync(resolve(ROOT, '.env'), 'utf8');
    } catch {
        return;
    }
    for (const line of raw.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const value = m[2].trim().replace(/^["'](.*)["']$/, '$1');
        if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
}

loadDotEnv();

export const config = {
    token: (process.env.SLACK_USER_TOKEN || '').trim(),
    userId: (process.env.SLACK_USER_ID || '').trim(),
    expectMentionPermalink: (process.env.EXPECT_MENTION_PERMALINK || '').trim(),
    expectDmPermalink: (process.env.EXPECT_DM_PERMALINK || '').trim(),
    lookbackDays: Number(process.env.LOOKBACK_DAYS || 7),
    port: Number(process.env.PORT || 4321),
    // Slack documents ~10 requests/min per user, so the battery paces itself.
    // Larger workspaces get a higher ceiling; lower this if yours does.
    probeIntervalMs: Number(process.env.PROBE_INTERVAL_MS || 6500),
};

export function assertToken() {
    if (!config.token) {
        throw new Error('SLACK_USER_TOKEN is missing. Copy .env.example to .env and paste your xoxp- token.');
    }
    if (config.token.startsWith('xoxb-')) {
        throw new Error(
            'SLACK_USER_TOKEN holds a bot token (xoxb-). assistant.search.context needs a user token (xoxp-) ' +
            'unless you also pass an action_token obtained from a Slack event payload.'
        );
    }
}
