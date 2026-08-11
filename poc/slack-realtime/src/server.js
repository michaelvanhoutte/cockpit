// Serves the POC page and exposes the probe battery over HTTP, so the result can
// be read as a report rather than as terminal output.
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

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${config.port}`);

    if (url.pathname === '/api/status') {
        const token = config.token;
        return json(res, 200, {
            configured: Boolean(token) && !token.startsWith('xoxb-'),
            tokenKind: !token ? 'missing' : token.startsWith('xoxb-') ? 'bot' : token.startsWith('xoxp-') ? 'user' : 'unknown',
            lookbackDays: config.lookbackDays,
            recallChecks: {
                mention: Boolean(config.expectMentionPermalink),
                dm: Boolean(config.expectDmPermalink),
            },
        });
    }

    if (url.pathname === '/api/probe' && req.method === 'POST') {
        if (!config.token || config.token.startsWith('xoxb-')) {
            return json(res, 400, { error: 'no_user_token', message: 'Set SLACK_USER_TOKEN to an xoxp- token in poc/slack-realtime/.env' });
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
    console.log(`Slack Real-time Search POC → http://localhost:${config.port}`);
    if (!config.token) console.log('No SLACK_USER_TOKEN set yet — the page will tell you what to do.');
});
