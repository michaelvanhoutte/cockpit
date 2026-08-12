#!/usr/bin/env node
// The handled-afterwards experiment — the second half of the question this POC exists to
// answer: once an item is dealt with in Notion, can Cockpit find out?
//
// It cannot be answered by a single API call, because "handled" is not a field. It is a
// *change*, so it needs two observations with a human action in between:
//
//   1. node src/handled.js            -> takes a snapshot of all four signals
//   2. go into Notion and, by hand:   -> set a task's status to done
//                                        resolve a comment thread that mentions you
//                                        reply to one of your own threads, or delete a reply
//                                        remove an @-mention of yourself from a page
//   3. node src/handled.js            -> diffs against the snapshot and classifies what
//                                        the API actually let us observe
//
// The classification is the finding. Some changes are reported precisely; comment changes
// come back only as a disappearance, and the diff says so rather than guessing.
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { STATE_DIR, assertToken, config } from './config.js';
import { listUsers, paginate, resetCallLog, retrievePage, callStats, sameId } from './notion.js';
import { crawlWorkspace } from './crawl.js';
import { collectAssignments, collectCommentMentions, collectPageMentions, collectReplies } from './signals.js';

const SNAPSHOT = resolve(STATE_DIR, 'handled-snapshot.json');

async function resolvePerson() {
    if (config.personUserId) return { id: config.personUserId, name: config.personName || null };
    if (!config.personEmail) throw new Error('Set NOTION_PERSON_USER_ID or NOTION_PERSON_EMAIL in .env.');
    const users = await paginate((cursor) => listUsers(cursor));
    if (!users.ok) throw new Error(`Could not list users (${users.error}). Paste NOTION_PERSON_USER_ID into .env instead.`);
    const match = users.results.find((u) => (u.person?.email || '').toLowerCase() === config.personEmail.toLowerCase());
    if (!match) throw new Error(`${config.personEmail} is not among the workspace members this integration can see.`);
    return { id: match.id, name: match.name };
}

/** One observation of all four signals, reduced to what a diff needs. */
async function observe(person, log) {
    const crawl = await crawlWorkspace({ log });
    const { assignments } = await collectAssignments({ personUserId: person.id, dataSources: crawl.dataSources });
    const pageMentions = collectPageMentions({ crawl, personUserId: person.id });
    const commentMentions = collectCommentMentions({ crawl, personUserId: person.id });
    const { replies } = collectReplies({ crawl, personUserId: person.id });

    return {
        takenAt: new Date().toISOString(),
        person,
        reachablePageIds: crawl.pages.map((p) => p.id),
        assignments: Object.fromEntries(assignments.map((a) => [a.id, {
            title: a.title, database: a.database, handledState: a.handledState,
            assignees: a.assignees, lastEdited: a.lastEdited, inTrash: a.inTrash, url: a.url,
        }])),
        pageMentions: Object.fromEntries(pageMentions.map((m) => [m.blockId, {
            pageId: m.pageId, pageTitle: m.pageTitle, text: m.text, isTodo: m.isTodo, checked: m.checked, url: m.url,
        }])),
        commentMentions: Object.fromEntries(commentMentions.map((c) => [c.commentId, {
            pageId: c.pageId, pageTitle: c.pageTitle, discussionId: c.discussionId, text: c.text, url: c.url,
        }])),
        commentReplies: Object.fromEntries(replies.map((r) => [r.commentId, {
            pageId: r.pageId, pageTitle: r.pageTitle, discussionId: r.discussionId, text: r.text, url: r.url,
        }])),
        cost: crawl.cost,
    };
}

/**
 * Why a comment vanished, as far as the API can say.
 *
 * Resolving a thread and deleting a comment produce byte-identical evidence: the comment
 * simply stops being returned, because GET /v1/comments only ever returns un-resolved
 * comments and there is no resolved field to read. Fetching the page narrows it — if the
 * page is gone or inaccessible, that explains the disappearance without anyone having
 * handled anything, which is the false positive worth ruling out.
 */
async function explainVanishedComment(pageId) {
    const { json, call } = await retrievePage(pageId);
    if (!call.ok) {
        return {
            classification: 'page-unreachable',
            meaning: `The page itself no longer reads back (${call.error}), so the comment's disappearance says nothing ` +
                'about it being handled. Trashing a page, or losing the integration\'s access to it, looks identical to ' +
                'a resolved comment unless you check for exactly this.',
        };
    }
    if (json.in_trash || json.archived) {
        return {
            classification: 'page-trashed',
            meaning: 'The page is in the trash. The comment is gone because the page is gone, not because anyone dealt with it.',
        };
    }
    return {
        classification: 'resolved-or-deleted',
        meaning: 'The page is still readable, so the comment was resolved or deleted. The API cannot distinguish the two: ' +
            'there is no resolved field on a comment object, and no comment.resolved webhook event. For a follow-up inbox ' +
            'both mean "stop showing me this", so this is usable — it just cannot be labelled more precisely than that.',
    };
}

function diffAssignments(before, after) {
    const changes = [];
    for (const [id, prev] of Object.entries(before.assignments)) {
        const now = after.assignments[id];
        if (!now) {
            changes.push({
                signal: 'assignment', id, title: prev.title, url: prev.url,
                classification: 'no-longer-assigned',
                meaning: 'The row no longer matches the assignee filter — you were unassigned, the row was deleted, or it ' +
                    'was moved out of reach. Detectable, and unambiguous enough: the next query simply does not return it.',
            });
            continue;
        }
        for (const [prop, value] of Object.entries(prev.handledState)) {
            if (JSON.stringify(now.handledState[prop]) !== JSON.stringify(value)) {
                changes.push({
                    signal: 'assignment', id, title: prev.title, url: prev.url,
                    classification: 'property-changed',
                    property: prop, from: value, to: now.handledState[prop],
                    meaning: `"${prop}" moved from ${JSON.stringify(value)} to ${JSON.stringify(now.handledState[prop])}. ` +
                        'This is the clean case: handled state is a property value, readable on every query and delivered by ' +
                        'the page.properties_updated webhook.',
                });
            }
        }
        if (JSON.stringify(now.assignees) !== JSON.stringify(prev.assignees)) {
            changes.push({
                signal: 'assignment', id, title: prev.title, url: prev.url,
                classification: 'assignees-changed', from: prev.assignees, to: now.assignees,
                meaning: 'The people property changed while you are still on it. Only visible because Cockpit kept the old ' +
                    'value — the API has no per-property history to ask.',
            });
        }
        if (now.inTrash && !prev.inTrash) {
            changes.push({
                signal: 'assignment', id, title: prev.title, url: prev.url,
                classification: 'trashed',
                meaning: 'The row was moved to the trash, which reads back as in_trash: true and also fires page.deleted.',
            });
        }
    }
    for (const [id, now] of Object.entries(after.assignments)) {
        if (!before.assignments[id]) {
            changes.push({
                signal: 'assignment', id, title: now.title, url: now.url,
                classification: 'newly-assigned',
                meaning: 'New since the snapshot. Note that this was detected by diffing against Cockpit\'s own copy, not by ' +
                    'asking Notion — there is no assigned_at, and last_edited_time moves on any edit.',
            });
        }
    }
    return changes;
}

function diffPageMentions(before, after) {
    const changes = [];
    for (const [blockId, prev] of Object.entries(before.pageMentions)) {
        const now = after.pageMentions[blockId];
        if (!now) {
            const pageStillReachable = after.reachablePageIds.some((id) => sameId(id, prev.pageId));
            changes.push({
                signal: 'page-mention', id: blockId, title: prev.pageTitle, url: prev.url,
                classification: pageStillReachable ? 'mention-removed' : 'page-unreachable',
                meaning: pageStillReachable
                    ? 'The block no longer mentions you: someone edited the mention away, or deleted the block. That is the ' +
                      'only thing Notion can tell us here — a page mention has no handled state, so an unread/handled ' +
                      'distinction has to live in Cockpit.'
                    : 'The page is no longer in the reachable set, so this says nothing about the mention itself.',
            });
            continue;
        }
        if (prev.isTodo && prev.checked !== now.checked) {
            changes.push({
                signal: 'page-mention', id: blockId, title: prev.pageTitle, url: prev.url,
                classification: 'todo-checked', from: prev.checked, to: now.checked,
                meaning: 'The mention sits in a to_do block and its checkbox changed. This is the one place a document ' +
                    'mention carries real completion state, and it is worth designing around: an "@you" inside a checklist ' +
                    'item is the only page mention Notion can tell us was finished.',
            });
        } else if (prev.text !== now.text) {
            changes.push({
                signal: 'page-mention', id: blockId, title: prev.pageTitle, url: prev.url,
                classification: 'text-edited',
                meaning: 'The block still mentions you but its text changed. Visible, but it means nothing about handling.',
            });
        }
    }
    for (const [blockId, now] of Object.entries(after.pageMentions)) {
        if (!before.pageMentions[blockId]) {
            changes.push({
                signal: 'page-mention', id: blockId, title: now.pageTitle, url: now.url,
                classification: 'new-mention',
                meaning: 'A new mention of you, found by re-crawling. There is no query for this, so latency here is ' +
                    'whatever the sweep interval is — unless page.content_updated narrows it to the page that changed.',
            });
        }
    }
    return changes;
}

async function diffComments(before, after, key, label) {
    const changes = [];
    for (const [commentId, prev] of Object.entries(before[key])) {
        if (after[key][commentId]) continue;
        const explained = await explainVanishedComment(prev.pageId);
        changes.push({ signal: label, id: commentId, title: prev.pageTitle, url: prev.url, text: prev.text, ...explained });
    }
    for (const [commentId, now] of Object.entries(after[key])) {
        if (before[key][commentId]) continue;
        changes.push({
            signal: label, id: commentId, title: now.pageTitle, url: now.url, text: now.text,
            classification: 'new',
            meaning: 'New since the snapshot. comment.created fires for this, and unlike the page events it is not aggregated.',
        });
    }
    return changes;
}

async function main() {
    if (process.argv.includes('--reset')) {
        if (existsSync(SNAPSHOT)) rmSync(SNAPSHOT);
        console.log('Snapshot cleared. Run again to take a fresh one.');
        return;
    }

    assertToken();
    resetCallLog();
    mkdirSync(STATE_DIR, { recursive: true });

    const person = await resolvePerson();
    console.log(`Cockpit — Notion handled-afterwards experiment`);
    console.log(`Watching on behalf of ${person.name || person.id}\n`);

    const first = !existsSync(SNAPSHOT);
    // Padding before the carriage return, so each step overwrites the last instead of
    // leaving the tail of a longer line behind it.
    const log = (msg) => process.stdout.write(`${msg.slice(0, 88).padEnd(89)}\r`);

    const now = await observe(person, log);
    process.stdout.write(`${''.padEnd(89)}\r`);

    if (first) {
        writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2));
        console.log('Snapshot taken:\n');
        console.log(`  ${Object.keys(now.assignments).length} assignment(s) to you`);
        console.log(`  ${Object.keys(now.pageMentions).length} mention(s) of you in page content`);
        console.log(`  ${Object.keys(now.commentMentions).length} comment(s) mentioning you`);
        console.log(`  ${Object.keys(now.commentReplies).length} reply/replies to your comments`);
        console.log(`\n  (${now.cost.totalRequests} requests, ${(now.cost.wallMs / 1000).toFixed(1)}s)`);
        console.log('\nNow go into Notion and mark some of these handled — set a task to Done, resolve a comment thread,');
        console.log('tick a to_do that mentions you, delete a mention. Then run `npm run handled` again.\n');
        console.log(`Snapshot: ${SNAPSHOT}`);
        return;
    }

    const before = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
    const changes = [
        ...diffAssignments(before, now),
        ...diffPageMentions(before, now),
        ...await diffComments(before, now, 'commentMentions', 'comment-mention'),
        ...await diffComments(before, now, 'commentReplies', 'comment-reply'),
    ];

    const ageMinutes = Math.round((Date.parse(now.takenAt) - Date.parse(before.takenAt)) / 60000);
    console.log(`Diff against a snapshot taken ${ageMinutes} minute(s) ago.\n`);

    if (!changes.length) {
        console.log('Nothing changed. Either nothing was touched in Notion, or the change is one the API cannot express —');
        console.log('re-read the snapshot counts and check you changed something that appears in them.\n');
    } else {
        for (const change of changes) {
            console.log(`[${change.signal}] ${change.classification}`);
            console.log(`  ${change.title}${change.property ? ` · ${change.property}` : ''}`);
            if (change.text) console.log(`  "${change.text.slice(0, 80)}"`);
            console.log(`  ${change.meaning}`);
            if (change.url) console.log(`  ${change.url}`);
            console.log();
        }
    }

    const ambiguous = changes.filter((c) => c.classification === 'resolved-or-deleted').length;
    console.log('─'.repeat(76));
    console.log(`${changes.length} observable change(s). ${ambiguous} of them can only be described as ` +
        '"resolved or deleted", which is the ceiling of what the public API reports for a comment.\n');

    const path = resolve(STATE_DIR, `handled-diff-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ before: before.takenAt, after: now.takenAt, changes, calls: callStats() }, null, 2));
    writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2));
    console.log(`Diff written to ${path}`);
    console.log('The snapshot has been advanced, so the next run diffs from here. `npm run handled:reset` starts over.\n');
}

main().catch((err) => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
});
