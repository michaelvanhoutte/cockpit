#!/usr/bin/env node
// Webhook receiver.
//
// docs/notion-integration-options.md selects Integration/Connection Webhooks as the change
// detector. Everything else in this POC measures the *pull* side; this measures the push
// side, and it exists mainly to answer one question the documentation does not:
//
//   when a comment is resolved in Notion, does any webhook event fire?
//
// The published event list has comment.created, comment.updated and comment.deleted, and
// nothing for resolution. If resolving emits comment.updated (or comment.deleted), Cockpit
// gets a push signal for "handled". If it emits nothing, resolution can only ever be found
// by re-reading the comment list and noticing an absence. That difference decides whether
// Cockpit's comment items can be closed in near-real-time or only on a sweep.
//
// Notion requires a public HTTPS endpoint, so this needs a tunnel in front of it:
//
//   npm run webhook
//   cloudflared tunnel --url http://localhost:4332      (or: ngrok http 4332)
//
// Paste the tunnel's https URL into the integration's Webhooks tab. Notion immediately
// POSTs a one-time verification_token, which this prints in full — copy it back into the
// Verify box in Notion. Then act in Notion and watch what arrives.
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { STATE_DIR, config } from './config.js';

const LOG = resolve(STATE_DIR, 'webhook-events.jsonl');
mkdirSync(STATE_DIR, { recursive: true });

const counts = new Map();

function readBody(req) {
    return new Promise((res, rej) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; if (raw.length > 2_000_000) req.destroy(); });
        req.on('end', () => res(raw));
        req.on('error', rej);
    });
}

const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('Notion webhook receiver. POST here.\n');
    }

    const raw = await readBody(req);
    let body;
    try {
        body = JSON.parse(raw);
    } catch {
        body = { unparsed: raw.slice(0, 2000) };
    }

    // Always 200 promptly. Notion retries with exponential backoff for up to ~24 hours, and
    // a slow handler turns one event into a pile of duplicates.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    appendFileSync(LOG, JSON.stringify({ receivedAt: new Date().toISOString(), body }) + '\n');

    if (body.verification_token) {
        console.log('\n' + '='.repeat(72));
        console.log('VERIFICATION TOKEN — paste this into the Verify box in the integration\'s Webhooks tab:\n');
        console.log(body.verification_token);
        console.log('='.repeat(72) + '\n');
        return;
    }

    const type = body.type || '(no type)';
    counts.set(type, (counts.get(type) || 0) + 1);

    const entity = body.entity ? `${body.entity.type} ${body.entity.id}` : '(no entity)';
    const parent = body.data?.parent ? `parent ${body.data.parent.type} ${body.data.parent.id}` : '';
    console.log(`${new Date().toLocaleTimeString()}  ${type.padEnd(28)} ${entity} ${parent}`);

    // The payload carries ids and metadata, never the changed content, so anything Cockpit
    // wants to show still costs a retrieve. Worth seeing once rather than taking on trust.
    const keys = Object.keys(body.data || {});
    if (keys.length) console.log(`  data keys: ${keys.join(', ')}`);

    if (type.startsWith('comment.')) {
        console.log('  ^ comment event — if you just resolved a thread, this is the answer to whether resolution pushes.');
    }
});

server.listen(config.webhookPort, () => {
    console.log('Cockpit — Notion webhook receiver');
    console.log(`Listening on http://localhost:${config.webhookPort}`);
    console.log(`Events appended to ${LOG}\n`);
    console.log('Notion only accepts a public HTTPS subscription URL, so put a tunnel in front of this:');
    console.log(`  cloudflared tunnel --url http://localhost:${config.webhookPort}`);
    console.log(`  ngrok http ${config.webhookPort}\n`);
    console.log('Then, in the integration\'s Webhooks tab, subscribe that URL to at least:');
    console.log('  page.properties_updated   (a task\'s status changing)');
    console.log('  page.content_updated      (a mention being added or edited away)');
    console.log('  comment.created           (a new comment or reply)');
    console.log('  comment.updated, comment.deleted  (the two candidates for "resolved")\n');
    console.log('Waiting for events. Ctrl+C to stop.\n');
});

process.on('SIGINT', () => {
    console.log('\n\nEvent types seen this session:');
    if (!counts.size) console.log('  none');
    for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(4)}  ${type}`);
    }
    console.log(`\nFull payloads: ${LOG}\n`);
    process.exit(0);
});
