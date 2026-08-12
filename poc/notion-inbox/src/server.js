// Serves the POC page and exposes the probe battery over HTTP, so the result can be read
// as a report rather than as terminal output.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { ROOT, config } from './config.js';
import { runProbes } from './probes.js';

const PUBLIC_DIR = resolve(ROOT, 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

function json(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}

async function serveStatic(res, urlPath) {
    const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^([/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(body);
    } catch {
        json(res, 404, { error: 'not_found' });
    }
}

const tokenKind = () => {
    if (!config.token || config.token === 'ntn_') return 'missing';
    if (/^(ntn_|secret_)/.test(config.token)) return 'integration';
    return 'unknown';
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${config.port}`);

    if (url.pathname === '/api/status') {
        const kind = tokenKind();
        return json(res, 200, {
            configured: kind === 'integration' && Boolean(config.personUserId || config.personEmail),
            tokenKind: kind,
            personConfigured: Boolean(config.personUserId || config.personEmail),
            plan: config.plan,
            apiVersion: config.version,
            crawlBudget: { maxPages: config.maxPages, maxBlockDepth: config.maxBlockDepth, deepComments: config.deepComments },
            groundTruth: {
                pageMention: Boolean(config.expectMentionPageUrl),
                commentMention: Boolean(config.expectCommentMentionPageUrl),
                reply: Boolean(config.expectReplyPageUrl),
                resolvedComment: Boolean(config.expectResolvedCommentPageUrl),
            },
        });
    }

    if (url.pathname === '/api/probe' && req.method === 'POST') {
        const kind = tokenKind();
        if (kind !== 'integration') {
            return json(res, 400, { error: 'no_token', message: 'Set NOTION_TOKEN to an internal integration secret in poc/notion-inbox/.env' });
        }
        if (!config.personUserId && !config.personEmail) {
            return json(res, 400, { error: 'no_person', message: 'Set NOTION_PERSON_EMAIL or NOTION_PERSON_USER_ID: three of the four signals are defined as "involving me".' });
        }
        try {
            const report = await runProbes({ includeRateLimit: url.searchParams.get('ratelimit') === '1' });
            return json(res, 200, report);
        } catch (err) {
            return json(res, 500, { error: 'probe_failed', message: err.message });
        }
    }

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });

    return serveStatic(res, url.pathname);
});

server.listen(config.port, () => {
    console.log(`Notion follow-up inbox POC → http://localhost:${config.port}`);
    if (tokenKind() !== 'integration') console.log('No NOTION_TOKEN set yet — the page will tell you what to do.');
});
