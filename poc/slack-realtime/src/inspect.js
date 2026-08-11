#!/usr/bin/env node
// One-off: dump the raw shape of a single search response. Useful when a probe's
// interpretation of the data is in doubt, at the cost of one API call.
//   node src/inspect.js "<@U123>"            channels
//   node src/inspect.js "*" im               DMs
import { assertToken, config } from './config.js';
import { searchContext } from './slack.js';

assertToken();

const query = process.argv[2] || '*';
const scope = process.argv[3] || 'channels';
const channel_types = scope === 'im' ? ['im', 'mpim'] : ['public_channel', 'private_channel'];

const { json, call } = await searchContext({
    query,
    channel_types,
    disable_semantic_search: true,
    sort: 'timestamp',
    sort_dir: 'desc',
    limit: 20,
    after: Math.floor(Date.now() / 1000) - config.lookbackDays * 86400,
});

console.log(`query=${JSON.stringify(query)} scope=${scope} status=${call.status} ok=${call.ok} error=${call.error ?? '—'}`);
const messages = json?.results?.messages ?? [];
console.log(`${messages.length} message(s)\n`);
for (const m of messages) {
    console.log(JSON.stringify(m, null, 2));
    console.log('—'.repeat(60));
}
