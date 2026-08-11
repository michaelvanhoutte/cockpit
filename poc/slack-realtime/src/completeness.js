#!/usr/bin/env node
// "The mechanism works" and "it returns everything" are different claims. The probe
// battery established the first. This script attacks the second, which is what
// "find ALL my new DMs" actually depends on.
//
//   npm run completeness
//
// Optional ground truth in .env, comma-separated permalinks of messages you know exist:
//   EXPECT_ALL_DM_PERMALINKS=...
//   EXPECT_ALL_MENTION_PERMALINKS=...
import { assertToken, config } from './config.js';
import { searchContext, permalinkToTs } from './slack.js';
import { messageFields } from './normalize.js';

assertToken();

const AFTER = Math.floor(Date.now() / 1000) - config.lookbackDays * 86400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = config.probeIntervalMs;

let last = 0;
async function paced(args) {
    const wait = PACE - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    return searchContext(args);
}

const list = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
const EXPECT_DMS = list(process.env.EXPECT_ALL_DM_PERMALINKS);
const EXPECT_MENTIONS = list(process.env.EXPECT_ALL_MENTION_PERMALINKS);

function tsSet(messages) {
    return new Set(messages.map((m) => String(messageFields(m).ts || '')));
}

/** Page through with a small limit and report whether pagination is coherent. */
async function paginate(args, pageSize) {
    const seen = [];
    let cursor;
    let pages = 0;
    for (;;) {
        const { json, call } = await paced({ ...args, limit: pageSize, ...(cursor ? { cursor } : {}) });
        if (!call.ok) return { ok: false, error: call.error, pages, seen };
        const messages = json?.results?.messages ?? [];
        seen.push(...messages);
        pages++;
        cursor = json?.response_metadata?.next_cursor;
        if (!cursor || messages.length === 0 || pages >= 8) break;
    }
    return { ok: true, pages, seen, truncated: Boolean(cursor) };
}

console.log('Completeness checks for Real-time Search\n');
console.log(`Lookback ${config.lookbackDays}d, paced at ${PACE}ms between calls.\n`);
console.log('─'.repeat(72));

// ---------------------------------------------------------------------------
// C1 — pagination. If cursors do not enumerate reliably, "all new DMs" fails the
// moment a sync window holds more than one page.
// ---------------------------------------------------------------------------
const allTypes = ['im', 'mpim', 'public_channel', 'private_channel'];
const wildcard = { query: '*', disable_semantic_search: true, channel_types: allTypes, sort: 'timestamp', sort_dir: 'desc', after: AFTER };

const single = await paced({ ...wildcard, limit: 20 });
const singleMessages = single.json?.results?.messages ?? [];
const paged = await paginate(wildcard, 1);

console.log('\nC1 · Does cursor pagination enumerate the same set as one big page?');
if (!single.call.ok || !paged.ok) {
    console.log(`     INCONCLUSIVE — ${single.call.error || paged.error}`);
} else {
    const a = tsSet(singleMessages);
    const b = tsSet(paged.seen);
    const missing = [...a].filter((ts) => !b.has(ts));
    const extra = [...b].filter((ts) => !a.has(ts));
    console.log(`     one page (limit 20): ${a.size} message(s)`);
    console.log(`     paged (limit 1):     ${b.size} message(s) over ${paged.pages} page(s)${paged.truncated ? ' (stopped at page cap)' : ''}`);
    if (a.size === 0) {
        console.log('     INCONCLUSIVE — nothing in the window to paginate.');
    } else if (!missing.length && !extra.length) {
        console.log('     PASS — identical sets, so pagination is safe for multi-page syncs.');
    } else {
        console.log(`     FAIL — paging disagrees: ${missing.length} missing, ${extra.length} extra.`);
        console.log('     A sync window larger than one page would silently drop messages.');
    }
}

// ---------------------------------------------------------------------------
// C2 — does the wildcard actually match every message, whatever its content?
// A keyword index may have nothing to match on for an emoji-only or link-only
// message, which would put silent holes in "all new DMs".
// ---------------------------------------------------------------------------
console.log('\nC2 · Does query "*" match messages regardless of content?');
if (!EXPECT_DMS.length && !EXPECT_MENTIONS.length) {
    console.log('     SKIPPED — set EXPECT_ALL_DM_PERMALINKS / EXPECT_ALL_MENTION_PERMALINKS in .env');
    console.log('     to the permalinks of messages you know exist, then re-run.');
} else {
    const found = tsSet(singleMessages);
    for (const [label, expected] of [['DM', EXPECT_DMS], ['mention', EXPECT_MENTIONS]]) {
        for (const permalink of expected) {
            const ts = permalinkToTs(permalink);
            const hit = ts && [...found].some((f) => f.startsWith(String(ts).slice(0, 15)));
            console.log(`     ${hit ? 'found  ' : 'MISSING'}  ${label}  ${permalink}`);
        }
    }
    const total = EXPECT_DMS.length + EXPECT_MENTIONS.length;
    const hits = [...EXPECT_DMS, ...EXPECT_MENTIONS].filter((p) => {
        const ts = permalinkToTs(p);
        return ts && [...found].some((f) => f.startsWith(String(ts).slice(0, 15)));
    }).length;
    console.log(`     ${hits}/${total} of the messages you flagged were returned by the broad query.`);
}

// ---------------------------------------------------------------------------
// C3 — the mention forms a <@USER_ID> query cannot see.
// @channel/@here/@everyone and user-group pings notify you, but Slack encodes them
// as <!channel>, <!here>, <!subteam^S...> — none of which contain your user id.
// ---------------------------------------------------------------------------
console.log('\nC3 · Broadcast and user-group mentions (@channel, @here, @team-name)');
const broadcastQueries = [
    { label: '<!channel>', query: '<!channel>' },
    { label: '<!here>', query: '<!here>' },
    { label: '<!subteam (user groups)', query: '<!subteam' },
];
let broadcastTotal = 0;
for (const b of broadcastQueries) {
    const { json, call } = await paced({
        query: b.query,
        disable_semantic_search: true,
        channel_types: ['public_channel', 'private_channel'],
        sort: 'timestamp',
        sort_dir: 'desc',
        limit: 20,
        after: AFTER,
    });
    const n = (json?.results?.messages ?? []).length;
    broadcastTotal += n;
    console.log(`     ${call.ok ? `${String(n).padStart(2)} result(s)` : `error ${call.error}`}  query ${b.label}`);
}
console.log(broadcastTotal
    ? '     These exist in the workspace and a <@USER_ID> search would NOT return them.'
    : '     None present in this window — post an @channel message to test this properly.');

console.log('\n' + '─'.repeat(72));
console.log('\nC1 is the one that decides whether "all new DMs" scales. C3 is a coverage gap');
console.log('in the mention query itself, independent of volume.\n');
