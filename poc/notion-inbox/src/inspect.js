#!/usr/bin/env node
// Dumps raw Notion objects, so an argument about what the API actually returned costs a
// couple of requests instead of a re-run of the whole battery.
//
//   node src/inspect.js schema  <data-source-id|url>   property names and types
//   node src/inspect.js page    <page-id|url>          blocks, with mentions called out
//   node src/inspect.js comments <page-id|url>         page-level AND per-block comments
//
// The comments mode is the one that earns its keep: page-level and inline comments come from
// different block ids, and a page-level query returning nothing says nothing about whether
// an inline comment exists.
import { assertToken, config } from './config.js';
import { listComments, paginate, retrieveDataSource, retrievePage, blockChildren, urlToId, sameId } from './notion.js';
import { blockRichText, isTextBearing, pageTitle, plainText } from './normalize.js';

const [mode, target] = process.argv.slice(2);

function mentionsIn(richText) {
    return (richText || [])
        .filter((t) => t.type === 'mention')
        .map((t) => {
            const kind = t.mention?.type;
            const id = t.mention?.[kind]?.id;
            const isMe = kind === 'user' && sameId(id, config.personUserId);
            return `${kind}:${id ?? '?'}${isMe ? ' <-- YOU' : ''}`;
        });
}

async function schema(id) {
    const { json, call } = await retrieveDataSource(id);
    if (!call.ok) return console.error(`Failed: ${call.error} — ${call.message}`);
    console.log(`Data source: ${pageTitle(json)}  (${json.id})\n`);
    const rows = Object.entries(json.properties || {}).map(([name, prop]) => [name, prop.type]);
    const width = Math.max(...rows.map(([n]) => n.length), 8);
    for (const [name, type] of rows) console.log(`  ${name.padEnd(width)}  ${type}`);

    const people = rows.filter(([, t]) => t === 'people');
    const handled = rows.filter(([, t]) => ['status', 'checkbox', 'select'].includes(t));
    console.log(`\n  people properties : ${people.length ? people.map(([n]) => n).join(', ') : 'NONE — nothing can be "assigned to me" here'}`);
    console.log(`  handled candidates: ${handled.length ? handled.map(([n]) => `${n} (${rows.find(([x]) => x === n)[1]})`).join(', ') : 'NONE — no property expresses "done"'}`);
}

async function page(id) {
    const { json, call } = await retrievePage(id);
    if (call.ok) console.log(`Page: ${pageTitle(json)}  (${json.id})`);
    console.log(`Properties: ${Object.entries(json?.properties || {}).map(([n, p]) => `${n}:${p.type}`).join(', ') || '—'}\n`);

    // Page properties can hold mentions too — a title or rich_text property containing an
    // @-mention is a real reference that a block-only crawl would miss entirely.
    for (const [name, prop] of Object.entries(json?.properties || {})) {
        const rich = prop.type === 'title' ? prop.title : prop.type === 'rich_text' ? prop.rich_text : null;
        const found = rich ? mentionsIn(rich) : [];
        if (found.length) console.log(`  [property ${name}] ${plainText(rich)}\n      mentions: ${found.join(', ')}`);
        const people = prop.type === 'people' ? (prop.people || []).map((p) => `${p.id}${sameId(p.id, config.personUserId) ? ' <-- YOU' : ''}`) : [];
        if (people.length) console.log(`  [property ${name}] people: ${people.join(', ')}`);
    }

    const blocks = await paginate((cursor) => blockChildren(id, cursor));
    if (!blocks.ok) return console.error(`Blocks failed: ${blocks.error} — ${blocks.message}`);
    console.log(`\n${blocks.results.length} top-level block(s):\n`);
    for (const block of blocks.results) {
        const rich = blockRichText(block);
        const found = mentionsIn(rich);
        console.log(`  ${block.type.padEnd(20)} ${block.has_children ? '(has children) ' : ''}${plainText(rich).slice(0, 70)}`);
        if (found.length) console.log(`  ${' '.repeat(20)} mentions: ${found.join(', ')}`);
        if (!isTextBearing(block) && block.type !== 'to_do') console.log(`  ${' '.repeat(20)} (no rich_text on this block type, so it can never hold a mention)`);
    }
}

async function comments(id) {
    const atPage = await paginate((cursor) => listComments(id, cursor));
    console.log(`Page-level discussions (block_id = the page id):`);
    if (!atPage.ok) console.error(`  failed: ${atPage.error} — ${atPage.message}`);
    else if (!atPage.results.length) console.log('  none');
    for (const c of atPage.results) {
        console.log(`  ${c.discussion_id}  by ${c.created_by?.id}  ${c.created_time}`);
        console.log(`    "${plainText(c.rich_text)}"`);
        const found = mentionsIn(c.rich_text);
        if (found.length) console.log(`    mentions: ${found.join(', ')}`);
    }

    // The point of this script. An inline comment is anchored to a block, so it is invisible
    // to the page-level query above no matter how many times you run it.
    const blocks = await paginate((cursor) => blockChildren(id, cursor));
    if (!blocks.ok) return;
    console.log(`\nPer-block discussions (${blocks.results.length} block(s) probed, one request each):`);
    let any = false;
    for (const block of blocks.results) {
        const atBlock = await paginate((cursor) => listComments(block.id, cursor));
        if (!atBlock.ok || !atBlock.results.length) continue;
        any = true;
        console.log(`\n  on ${block.type} "${plainText(blockRichText(block)).slice(0, 50)}"`);
        for (const c of atBlock.results) {
            console.log(`    ${c.discussion_id}  by ${c.created_by?.id}  ${c.created_time}`);
            console.log(`      "${plainText(c.rich_text)}"`);
            const found = mentionsIn(c.rich_text);
            if (found.length) console.log(`      mentions: ${found.join(', ')}`);
        }
    }
    if (!any) console.log('  none');
    console.log('\nRemember: only *un-resolved* comments are ever returned. A thread you resolved will be absent here.');
}

async function main() {
    assertToken();
    const id = urlToId(target) || target;
    if (!mode || !id) {
        console.error('Usage: node src/inspect.js <schema|page|comments> <id-or-url>');
        process.exit(1);
    }
    if (mode === 'schema') return schema(id);
    if (mode === 'page') return page(id);
    if (mode === 'comments') return comments(id);
    console.error(`Unknown mode "${mode}". Use schema, page or comments.`);
    process.exit(1);
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
