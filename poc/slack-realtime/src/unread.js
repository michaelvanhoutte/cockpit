#!/usr/bin/env node
// Separate question from the search battery: can we get *unread* state at all, and
// what does it cost in permissions?
//
// Real-time Search returns messages matching a query. It has no unread filter and
// its results carry no read state. Unread lives on the conversation, not the message,
// so answering "which DMs are unread" means calling conversation APIs — which need
// exactly the broad scopes the data-minimisation argument was trying to avoid.
// This script establishes which of those are reachable with the current token.
import { assertToken, config } from './config.js';
import { slackCall } from './slack.js';

assertToken();

const CHECKS = [
    {
        label: 'users.conversations — list my channels/DMs',
        method: 'users.conversations',
        body: { types: 'public_channel,private_channel,im,mpim', limit: 20, exclude_archived: true },
        scopes: 'channels:read, groups:read, im:read, mpim:read',
        reads: (json) => `${(json.channels || []).length} conversation(s); unread fields present: ` +
            `${(json.channels || []).some((c) => c.unread_count !== undefined) ? 'yes' : 'no'}`,
    },
    {
        label: 'conversations.info on a known DM — last_read / unread_count',
        method: 'conversations.info',
        body: { channel: process.argv[2] || 'D0BP6FR1XFF', include_num_members: false },
        scopes: 'im:read (plus channels:read for channels)',
        reads: (json) => {
            const c = json.channel || {};
            const present = ['last_read', 'unread_count', 'unread_count_display'].filter((k) => c[k] !== undefined);
            return present.length ? `has ${present.map((k) => `${k}=${c[k]}`).join(', ')}` : 'no read-state fields returned';
        },
    },
    {
        label: 'users.counts — per-conversation unread and mention counts (legacy)',
        method: 'users.counts',
        body: { mpim_aware: true },
        scopes: 'undocumented legacy method; historically client-only',
        reads: (json) => {
            const buckets = ['channels', 'groups', 'ims', 'mpims'].filter((k) => Array.isArray(json[k]));
            if (!buckets.length) return 'no count buckets returned';
            return buckets.map((k) => {
                const withMentions = json[k].filter((c) => (c.mention_count ?? 0) > 0).length;
                const withUnread = json[k].filter((c) => (c.unread_count ?? 0) > 0).length;
                return `${k}: ${json[k].length} total, ${withUnread} unread, ${withMentions} with mentions`;
            }).join('; ');
        },
    },
];

console.log('Can Real-time Search answer "unread"? Checking the alternatives.\n');
console.log(`Search API: no unread request parameter, no read-state field in results. Structurally cannot.\n`);
console.log('─'.repeat(72));

for (const check of CHECKS) {
    const { json, call } = await slackCall(check.method, check.body);
    console.log(`\n${call.ok ? '[OK  ]' : '[FAIL]'} ${check.label}`);
    console.log(`       method: ${check.method}   scopes needed: ${check.scopes}`);
    if (call.ok) {
        console.log(`       ${check.reads(json)}`);
    } else {
        console.log(`       error: ${call.error}${call.needed ? `   needed: ${call.needed}` : ''}`);
    }
}

console.log('\n' + '─'.repeat(72));
console.log(`\nLookback for reference: ${config.lookbackDays} days.`);
console.log('A [FAIL] with missing_scope is itself the finding: unread state is not free, it costs');
console.log('conversation-level read scopes on top of the search scopes.\n');
