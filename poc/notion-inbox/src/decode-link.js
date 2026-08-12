#!/usr/bin/env node
// Decodes a Notion notification email's tracking link, offline.
//
//   node src/decode-link.js "https://mg.mail.notion.so/c/eJx..."
//
// This is the mechanism that makes email a viable change detector rather than merely a
// human notification (docs/notion-integration-options.md, "Revision, August 2026").
//
// The path segment after /c/ is base64url over a zlib stream. Inflating it yields the
// query string Notion would have redirected to, which carries everything Cockpit needs to
// go straight to the API: the page id, the specific block id, a machine-readable event
// subtype, the workspace id, and a stable id for deduplication.
//
// Two properties make this worth relying on despite being undocumented:
//   - it needs no HTTP request, so it does not consume the tracked click or tell Notion
//     that a mail was read;
//   - it fails loudly. A format change throws on inflate rather than silently mis-reading
//     an event, which is the failure mode that matters when the alternative is parsing
//     localised prose. (The sample subjects were in Dutch; `email_subtype` is not.)
import { inflateSync, inflateRawSync, gunzipSync } from 'node:zlib';

const UUID = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i;

const dashed = (raw) => {
    const m = UUID.exec(String(raw || '').replace(/-/g, ''));
    return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}`.toLowerCase() : null;
};

export function decodeTrackingLink(url) {
    const segment = /\/c\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
    if (!segment) throw new Error('Not a Notion tracking link: expected a /c/<payload> path segment.');

    const buf = Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    let text = null;
    for (const inflate of [inflateSync, inflateRawSync, gunzipSync]) {
        try { text = inflate(buf).toString('utf8'); break; } catch { /* try the next framing */ }
    }
    if (text === null) throw new Error('Could not inflate the payload — Notion may have changed the link format.');

    const params = new URLSearchParams(text);
    const target = params.get('l');
    const targetUrl = target ? new URL(target) : null;

    // Notion repeats `t` for each key=value pair, so collect them all rather than taking one.
    const tags = {};
    for (const value of params.getAll('t')) {
        const [key, ...rest] = value.split('=');
        tags[key] = rest.join('=');
    }

    let spaceId = null;
    try { spaceId = JSON.parse(params.get('metadata') || '{}').space_id ?? null; } catch { /* absent or not JSON */ }

    // The page id is the trailing 32 hex chars of the slug; the fragment, when present, is
    // the block the notification points at — the anchor of an inline comment or a mention.
    const pageId = dashed(/([0-9a-f]{32})$/i.exec(targetUrl?.pathname || '')?.[1]);
    const blockId = dashed((targetUrl?.hash || '').replace(/^#/, ''));

    return {
        raw: text,
        targetUrl: target,
        pageId,
        blockId,
        emailType: tags.email_type ?? null,
        emailSubtype: tags.email_subtype ?? null,
        // The `n` values live in the *target* URL's query string, not the outer payload.
        activity: targetUrl ? targetUrl.searchParams.getAll('n') : [],
        spaceId: dashed(spaceId) ?? spaceId,
        emailUuid: (() => {
            try { return JSON.parse(params.get('email_uuid') || '{}').email_uuid ?? null; } catch { return null; }
        })(),
        recipient: params.get('r'),
        sentAt: params.get('e') ? new Date(Number(params.get('e')) * 1000).toISOString() : null,
        messageId: params.get('i'),
    };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('decode-link.js')) {
    const url = process.argv[2];
    if (!url) {
        console.error('Usage: node src/decode-link.js "<notion tracking url>"');
        process.exit(1);
    }
    try {
        const out = decodeTrackingLink(url);
        console.log(`event subtype : ${out.emailSubtype ?? '(none)'}      <- locale-independent; use this, not the subject line`);
        console.log(`activity      : ${out.activity.join(', ') || '(none)'}`);
        console.log(`page id       : ${out.pageId ?? '(none)'}`);
        console.log(`block id      : ${out.blockId ?? '(none)'}      <- the anchor: skip the sweep, fetch this`);
        console.log(`workspace id  : ${out.spaceId ?? '(none)'}`);
        console.log(`dedupe uuid   : ${out.emailUuid ?? '(none)'}`);
        console.log(`recipient     : ${out.recipient ?? '(none)'}`);
        console.log(`sent at       : ${out.sentAt ?? '(none)'}`);
        console.log(`\ntarget: ${out.targetUrl ?? '(none)'}`);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
