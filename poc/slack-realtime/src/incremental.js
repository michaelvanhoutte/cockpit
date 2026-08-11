#!/usr/bin/env node
// Answers: "why do we get the same messages back every run?"
//
// Because `after` is ours to set, and the probe battery deliberately sets it to a
// fixed lookback window (LOOKBACK_DAYS) on every run — a probe needs stable, repeatable
// data to measure against. If it advanced a high-water mark, the second run would
// return nothing and prove nothing.
//
// There is no server-side notion of "new". "New" is entirely the client's job:
// remember the newest message_ts you have seen, pass it as `after` next time.
// This script demonstrates that loop, and pins down the boundary semantics.
import { assertToken, config } from './config.js';
import { searchContext, tsToDate } from './slack.js';
import { messageFields } from './normalize.js';

assertToken();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TYPES = ['im', 'mpim', 'public_channel', 'private_channel'];

async function sync(afterTs, label) {
    const { json, call } = await searchContext({
        query: '*',
        disable_semantic_search: true,
        channel_types: TYPES,
        sort: 'timestamp',
        sort_dir: 'desc',
        limit: 20,
        after: afterTs,
    });
    const messages = json?.results?.messages ?? [];
    console.log(`\n${label}`);
    console.log(`  after = ${afterTs} (${new Date(afterTs * 1000).toISOString()})`);
    if (!call.ok) {
        console.log(`  ERROR ${call.error}`);
        return [];
    }
    console.log(`  ${messages.length} message(s) returned`);
    for (const m of messages) {
        const f = messageFields(m);
        console.log(`    ${f.ts}  ${tsToDate(f.ts).toISOString()}  ${String(f.text).slice(0, 42)}`);
    }
    return messages;
}

console.log('Incremental sync: how "new" actually works\n' + '─'.repeat(72));

// Sync 1 — a cold start, exactly what the probe battery does every time.
const cold = Math.floor(Date.now() / 1000) - config.lookbackDays * 86400;
const first = await sync(cold, `SYNC 1 — cold start, ${config.lookbackDays}-day lookback`);

if (!first.length) {
    console.log('\nNothing in the window, so there is nothing to demonstrate. Post a message and re-run.');
    process.exit(0);
}

// The high-water mark a real client would persist.
const tsValues = first.map((m) => Number(messageFields(m).ts)).filter(Boolean);
const maxTs = Math.max(...tsValues);
const watermark = Math.floor(maxTs);

console.log(`\n  high-water mark from sync 1: ${maxTs}`);

await sleep(config.probeIntervalMs);
const atBoundary = await sync(watermark, 'SYNC 2 — after = high-water mark (is the boundary inclusive?)');

await sleep(config.probeIntervalMs);
const pastBoundary = await sync(watermark + 1, 'SYNC 3 — after = high-water mark + 1s');

console.log('\n' + '─'.repeat(72));
console.log('\nWhat this shows:');
console.log(`  Sync 1 returned ${first.length} message(s) — everything in the ${config.lookbackDays}-day window.`);
console.log(`  Sync 2 returned ${atBoundary.length}, sync 3 returned ${pastBoundary.length}.`);

if (atBoundary.length > 0 && pastBoundary.length === 0) {
    console.log('\n  => `after` is INCLUSIVE of the boundary second. Storing the raw high-water mark');
    console.log('     re-delivers the newest message(s) every sync. Cockpit must either advance to');
    console.log('     maxTs + 1, or dedupe on message_ts. Deduping is safer: several messages can');
    console.log('     share the same second, and +1 would skip them.');
} else if (atBoundary.length === 0 && pastBoundary.length === 0) {
    console.log('\n  => `after` is EXCLUSIVE. Storing the raw high-water mark is sufficient;');
    console.log('     the next sync returns only genuinely newer messages.');
} else {
    console.log('\n  => Boundary behaviour is not clear-cut here; dedupe on message_ts regardless.');
}

console.log('\n  The API has no idea what you have already seen. Pass a stale `after` and you get');
console.log('  old messages; pass your last high-water mark and you get only what is new.\n');
