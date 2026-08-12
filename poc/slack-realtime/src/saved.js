#!/usr/bin/env node
// Can we find messages the user explicitly saved ("Save for later")?
//
// This matters more than the heuristics: saving is an intentional "I will deal with
// this later" signal, which is exactly what a follow-up inbox wants.
//
// Two conflicting claims to resolve:
//   - assistant.search.context documents a `modifiers` argument supporting `is:saved`.
//   - Slack has separately stated the "Later" APIs are not available, and that
//     stars.list no longer reflects anything users save.
//
// So the question is whether `is:saved` reaches the modern Later store, or a legacy
// one that is no longer written to. Only a live test with a genuinely saved message
// can tell them apart.
//
//   npm run saved
import { assertToken, config } from './config.js';
import { searchContext, slackCall } from './slack.js';
import { messageFields } from './normalize.js';

assertToken();

const AFTER = Math.floor(Date.now() / 1000) - config.lookbackDays * 86400;
const TYPES = ['im', 'mpim', 'public_channel', 'private_channel'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = {
    channel_types: TYPES,
    disable_semantic_search: true,
    sort: 'timestamp',
    sort_dir: 'desc',
    limit: 20,
    after: AFTER,
};

// Every plausible spelling. Slack's rejection messages tell us the expected type.
const ATTEMPTS = [
    { label: 'control — no modifier', args: { ...BASE, query: '*' } },
    { label: 'modifiers as string', args: { ...BASE, query: '*', modifiers: 'is:saved' } },
    { label: 'modifiers as array', args: { ...BASE, query: '*', modifiers: ['is:saved'] } },
    { label: 'modifiers as object', args: { ...BASE, query: '*', modifiers: { is: 'saved' } } },
    { label: 'is:saved inside the query', args: { ...BASE, query: 'is:saved' } },
    { label: 'term_clauses', args: { ...BASE, query: '*', term_clauses: [{ modifiers: ['is:saved'] }] } },
];

console.log('Can Real-time Search return saved ("Save for later") messages?\n');
console.log('─'.repeat(74));

const results = [];
for (const attempt of ATTEMPTS) {
    const { json, call } = await searchContext(attempt.args);
    const messages = json?.results?.messages ?? [];
    results.push({ label: attempt.label, ok: call.ok, error: call.error, count: messages.length, messages });
    const status = call.ok ? `${String(messages.length).padStart(2)} result(s)` : `REJECTED  ${call.error}`;
    console.log(`\n  ${status}   ${attempt.label}`);
    if (call.ok && messages.length && messages.length <= 4) {
        for (const m of messages) {
            const f = messageFields(m);
            console.log(`        ${f.ts}  ${String(f.text).slice(0, 46)}`);
        }
    }
    if (!call.ok && call.needed) console.log(`        needed: ${call.needed}`);
    await sleep(config.probeIntervalMs);
}

// The legacy path, for completeness. Slack says it no longer reflects new saves.
const { json: starsJson, call: starsCall } = await slackCall('stars.list', { limit: 20 });
console.log(`\n  ${starsCall.ok ? `${(starsJson.items || []).length} item(s)` : `REJECTED  ${starsCall.error}`}   stars.list (legacy)`);
if (!starsCall.ok && starsCall.needed) console.log(`        needed: ${starsCall.needed}`);

console.log('\n' + '─'.repeat(74));

const control = results[0];
const accepted = results.filter((r) => r.ok && r.label !== 'control — no modifier');
const narrowed = accepted.filter((r) => r.count < control.count);

console.log('\nReading this:');
if (!control.ok) {
    console.log('  The control failed, so nothing below is interpretable.');
} else if (control.count === 0) {
    console.log('  The control returned nothing, so the window is empty and no variant could');
    console.log('  have found anything. Inconclusive — post a message and re-run.');
} else {
    console.log(`  Control (no modifier) returned ${control.count} message(s) — the full window.`);
    const rejected = results.filter((r) => !r.ok);
    if (rejected.length) {
        console.log(`  ${rejected.length} spelling(s) rejected outright: ${rejected.map((r) => r.error).join(', ')}.`);
    }
    if (accepted.length && !narrowed.length) {
        console.log('  Every accepted spelling returned the SAME count as the control, which means');
        console.log('  the modifier was silently ignored rather than applied. A filter that changes');
        console.log('  nothing is not a filter — treat this as "not supported", not "nothing saved".');
    }
    if (narrowed.length) {
        console.log(`  ${narrowed.length} spelling(s) returned FEWER results than the control, so the filter`);
        console.log('  is doing something. Confirm it is the right something: the returned messages');
        console.log('  should be exactly the ones you saved.');
    }
}

console.log('\n  IMPORTANT: if you have not saved anything in Slack, a zero here proves nothing.');
console.log('  Save a message (message ... menu -> "Save for later"), then re-run.\n');

// ---------------------------------------------------------------------------
// If a spelling actually filters, characterise it. The headline question for an
// inbox is whether "saved" can be synced incrementally — and there is a trap:
// `after` filters on the MESSAGE timestamp, not on when you saved it. Saving a
// three-week-old message is a brand new intention attached to an old timestamp.
// ---------------------------------------------------------------------------
const working = narrowed[0];
if (!working || !working.count) {
    console.log('  No working spelling to characterise yet.\n');
    process.exit(0);
}

const savedTs = Math.max(...working.messages.map((m) => Number(messageFields(m).ts)).filter(Boolean));
console.log('─'.repeat(74));
console.log(`\nCharacterising the working spelling ("${working.label}")\n`);

const FOLLOWUPS = [
    {
        label: `after = saved message ts + 1s  (does 'after' filter save time or message time?)`,
        args: { ...BASE, query: 'is:saved', after: Math.floor(savedTs) + 1 },
        read: (n) => n === 0
            ? 'MESSAGE time. Saving an OLD message will NOT appear in an incremental window.\n        Cockpit must pull the full saved list each sync and diff locally, not use `after`.'
            : 'SAVE time — an incremental `after` window would capture newly-saved old messages.',
    },
    {
        label: 'channel_types = im/mpim only  (is the saved channel message excluded?)',
        args: { ...BASE, query: 'is:saved', channel_types: ['im', 'mpim'] },
        read: (n) => n === 0
            ? 'Yes — channel_types still applies, so DMs and channels can be queried separately.'
            : 'No — channel_types appears to be ignored alongside is:saved.',
    },
    {
        label: 'semantic search left ON  (does the filter need Slack AI Search?)',
        args: { ...BASE, query: 'is:saved', disable_semantic_search: undefined },
        read: (n) => n > 0
            ? 'Works either way.'
            : 'Returned nothing with semantic on — prefer disable_semantic_search: true.',
    },
];

for (const f of FOLLOWUPS) {
    await sleep(config.probeIntervalMs);
    const { json, call } = await searchContext(f.args);
    const n = (json?.results?.messages ?? []).length;
    console.log(`  ${call.ok ? `${String(n).padStart(2)} result(s)` : `REJECTED ${call.error}`}   ${f.label}`);
    if (call.ok) console.log(`        => ${f.read(n)}`);
}

console.log('\n  Note: results carry message_ts only — there is no "saved_at" field, so the API');
console.log('  cannot tell you WHEN something was saved.\n');
