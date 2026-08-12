// Minimal .env reader so the POC stays dependency-free.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_DIR = resolve(ROOT, '.state');

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

const str = (name, fallback = '') => (process.env[name] || fallback).trim();
const num = (name, fallback) => Number(process.env[name] || fallback);

export const config = {
    token: str('NOTION_TOKEN'),
    version: str('NOTION_VERSION', '2026-03-11'),

    personEmail: str('NOTION_PERSON_EMAIL'),
    personUserId: str('NOTION_PERSON_USER_ID'),
    personName: str('NOTION_PERSON_NAME'),
    plan: str('NOTION_PLAN', 'free'),

    maxPages: num('MAX_PAGES', 40),
    maxBlockDepth: num('MAX_BLOCK_DEPTH', 2),
    // Defaults ON. Measured against a real workspace, the ordinary human comment — select some
    // text, hit comment — is anchored to a *block*, and GET /v1/comments on the page id does not
    // return it. Page-level-only crawling therefore reports zero comments on a page that visibly
    // has one, which is the worst possible default: a false negative that looks like a finding.
    deepComments: str('DEEP_COMMENTS', '1') !== '0',

    expectMentionPageUrl: str('EXPECT_MENTION_PAGE_URL'),
    expectCommentMentionPageUrl: str('EXPECT_COMMENT_MENTION_PAGE_URL'),
    expectReplyPageUrl: str('EXPECT_REPLY_PAGE_URL'),
    expectResolvedCommentPageUrl: str('EXPECT_RESOLVED_COMMENT_PAGE_URL'),

    lookbackDays: num('LOOKBACK_DAYS', 7),
    requestIntervalMs: num('REQUEST_INTERVAL_MS', 350),
    port: num('PORT', 4331),
    webhookPort: num('WEBHOOK_PORT', 4332),
};

export function assertToken() {
    if (!config.token || config.token === 'ntn_') {
        throw new Error('NOTION_TOKEN is missing. Copy .env.example to .env and paste your internal integration token.');
    }
    // A Notion OAuth *client secret* looks tokenish and is a common paste mistake; it
    // will fail with a flat 401 that says nothing useful, so name it here instead.
    if (!/^(ntn_|secret_)/.test(config.token)) {
        throw new Error(
            `NOTION_TOKEN does not look like an integration token (expected it to start with "ntn_" or "secret_"). ` +
            'Take it from the integration\'s "Configuration" tab under "Internal Integration Secret", not from the OAuth section.'
        );
    }
}
