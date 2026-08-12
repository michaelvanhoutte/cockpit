// The probe battery. Each probe answers one thing that has to be true before Cockpit can
// build a follow-up inbox on the public Notion API (docs/notion-integration-options.md,
// "Selected approach").
//
// The four signals the inbox needs are the four things the user asked for:
//   1. actions newly assigned to me in a database
//   2. new mentions of me in document bodies
//   3. new mentions of me in comments
//   4. replies to comments I wrote
// and then, for each of them, whether Notion can tell us it was handled afterwards.
//
// Notion answers those four very differently from Slack. One is a first-class query; the
// other three have no query at all and can only be crawled. The probes are ordered to make
// that asymmetry visible rather than to flatter the API.
import { config } from './config.js';
import {
    callLog, callStats, listComments, listUsers, paginate, queryDataSource, resetCallLog,
    retrieveDataSource, retrieveSelf, sameId, search, urlToId,
} from './notion.js';
import {
    blockRichText, mentionsUser, namedInText, pageTitle,
    propertyNamesByType, toCockpitItem, mergeItems,
} from './normalize.js';
import { crawlWorkspace, projectCost } from './crawl.js';
import { collectAssignments, collectCommentMentions, collectPageMentions, collectReplies } from './signals.js';

const iso = (date) => new Date(date).toISOString();
const daysAgo = (n) => iso(Date.now() - n * 86400_000);

// ---------------------------------------------------------------------------
// N0 — is the token usable, and which capabilities did the integration get?
// Notion's equivalent of Slack scopes, set per integration in the UI.
// ---------------------------------------------------------------------------
async function probeAuth(ctx, log) {
    log('N0 token and capabilities');
    const { json, call } = await retrieveSelf();

    if (!call.ok) {
        return {
            id: 'N0',
            question: 'Is the integration token valid?',
            verdict: 'fail',
            headline: `GET /v1/users/me failed: ${call.error}`,
            detail: 'Nothing else can run. Check that NOTION_TOKEN is the Internal Integration Secret from the ' +
                'integration\'s Configuration tab, and that the integration still exists in this workspace.',
            evidence: { error: call.error, message: call.message, status: call.status },
        };
    }

    ctx.botId = json.id;
    ctx.botName = json.name;
    ctx.workspaceName = json.bot?.workspace_name ?? null;
    ctx.ownerType = json.bot?.owner?.type ?? null;

    // Capabilities are not reported anywhere, so the only way to know what the integration
    // was granted is to try the calls that need them. Both matter here: user-listing is how
    // "me" gets resolved, and comment-reading is two of the four signals.
    const users = await listUsers();
    ctx.canReadUsers = users.call.ok;
    // Deliberately an id that is not a block, so this call is *expected* to fail. What
    // matters is which way it fails: a capability problem answers `unauthorized` /
    // `restricted_resource`, while a merely-wrong id answers `validation_error` or
    // `object_not_found` — which means comments are readable.
    const comments = await listComments(json.id, undefined, 'expected to fail: capability probe, not a real block id');
    ctx.canReadComments = !['unauthorized', 'restricted_resource'].includes(comments.call.error);

    // Comment objects name their author only as `{object, id}`, so a follow-up inbox needs a
    // separate id-to-name map to render "X replied". Built here from whatever the capability
    // probe already returned, which is why N8 can report the workaround as well as the gap.
    ctx.userNames = new Map();
    for (const user of users.json?.results || []) if (user.name) ctx.userNames.set(user.id, user.name);

    const missing = [
        !ctx.canReadUsers && 'read user information (incl. email)',
        !ctx.canReadComments && 'read comments',
    ].filter(Boolean);

    return {
        id: 'N0',
        question: 'Is the token valid, and does the integration have the capabilities the four signals need?',
        verdict: missing.length ? 'partial' : 'pass',
        headline: `Authenticated as bot "${json.name}"${ctx.workspaceName ? ` in ${ctx.workspaceName}` : ''}`,
        detail: (missing.length
            ? `Missing capabilities: ${missing.join(', ')}. Turn them on in the integration's Configuration tab. `
            : 'Read content, read comments and read user information are all present. ') +
            'Note that this token authenticates a bot, not you — the bot id is useless for "assigned to me" ' +
            'and "mentions me", which is what N0b is for.',
        evidence: {
            botId: json.id, botName: json.name, workspace: ctx.workspaceName, ownerType: ctx.ownerType,
            canReadUsers: ctx.canReadUsers, canReadComments: ctx.canReadComments,
            usersError: users.call.error, commentsProbeError: comments.call.error,
        },
    };
}

// ---------------------------------------------------------------------------
// N0b — which user id is "me"? Everything downstream keys off this, and it is the
// single easiest thing to get wrong: the bot's id is not the person's id.
// ---------------------------------------------------------------------------
async function probePersona(ctx, log) {
    log('N0b resolving "me"');

    if (config.personUserId) {
        ctx.personUserId = config.personUserId;
        ctx.personName = config.personName || null;
        return {
            id: 'N0b',
            question: 'Which Notion user id is "me"?',
            verdict: 'pass',
            headline: `Using NOTION_PERSON_USER_ID = ${config.personUserId}`,
            detail: 'Taken from .env, so no user listing was needed. This is the id the assignment filter and the ' +
                'mention matcher compare against.',
            evidence: { personUserId: ctx.personUserId, source: 'env' },
        };
    }

    if (!config.personEmail) {
        return {
            id: 'N0b',
            question: 'Which Notion user id is "me"?',
            verdict: 'fail',
            headline: 'Neither NOTION_PERSON_USER_ID nor NOTION_PERSON_EMAIL is set',
            detail: 'Three of the four signals are defined as "involving me", so without a person id there is nothing ' +
                'to test. Set one of the two in .env.',
            evidence: {},
        };
    }

    const users = await paginate((cursor) => listUsers(cursor));
    if (!users.ok) {
        return {
            id: 'N0b',
            question: 'Which Notion user id is "me"?',
            verdict: 'fail',
            headline: `GET /v1/users failed: ${users.error}`,
            detail: 'The integration lacks the "read user information including email addresses" capability, so it ' +
                'cannot map your email to a user id. Either grant it, or paste NOTION_PERSON_USER_ID directly.',
            evidence: { error: users.error, message: users.message },
        };
    }

    for (const user of users.results) if (user.name) ctx.userNames?.set(user.id, user.name);

    const people = users.results.filter((u) => u.type === 'person');
    const match = people.find((u) => (u.person?.email || '').toLowerCase() === config.personEmail.toLowerCase());
    ctx.workspaceMembers = people.length;

    if (!match) {
        return {
            id: 'N0b',
            question: 'Which Notion user id is "me"?',
            verdict: 'fail',
            headline: `${config.personEmail} is not among the ${people.length} member(s) this integration can see`,
            detail: 'Either the email is wrong, or the integration cannot see emails (they come back absent rather ' +
                'than as an error when the capability is partial). Emails seen: ' +
                people.map((u) => u.person?.email || `${u.name} <no email>`).join(', '),
            evidence: { members: people.map((u) => ({ id: u.id, name: u.name, email: u.person?.email ?? null })) },
        };
    }

    ctx.personUserId = match.id;
    ctx.personName = config.personName || match.name;

    return {
        id: 'N0b',
        question: 'Which Notion user id is "me"?',
        verdict: 'pass',
        headline: `${match.name} = ${match.id}`,
        detail: `Resolved from ${config.personEmail} by listing ${people.length} workspace member(s). This is a ` +
            'different id from the bot\'s, and it is the one the remaining probes match on.',
        evidence: { personUserId: match.id, personName: match.name, workspaceMembers: people.length },
    };
}

// ---------------------------------------------------------------------------
// N1 — reach. A Notion integration sees only what has been explicitly shared with it.
// This is the structural difference from the Slack POC, where a user token saw whatever
// the user saw, and it caps every signal below it.
// ---------------------------------------------------------------------------
async function probeReach(ctx, log) {
    log('N1 reach (what is shared with the integration)');
    const crawl = await crawlWorkspace({ log });
    ctx.crawl = crawl;

    if (crawl.searchError) {
        return {
            id: 'N1',
            question: 'How much of the workspace can the integration actually see?',
            verdict: 'fail',
            headline: `POST /v1/search failed: ${crawl.searchError.error}`,
            detail: crawl.searchError.message || 'Without search there is no way to enumerate anything.',
            evidence: crawl.searchError,
        };
    }

    const { pages, dataSources } = crawl;
    const zero = pages.length === 0 && dataSources.length === 0;

    return {
        id: 'N1',
        question: 'How much of the workspace can the integration actually see?',
        verdict: zero ? 'fail' : (crawl.pagesTruncated ? 'partial' : 'pass'),
        headline: zero
            ? 'Nothing is shared with this integration'
            : `${pages.length} page(s) and ${dataSources.length} data source(s) reachable`,
        detail: zero
            ? 'Notion integrations start with access to nothing. Open a page, then ··· → Connections → add your ' +
              'integration. Access is inherited by subpages, so connecting at the top of a teamspace is usually enough.'
            : `Reach is a hard ceiling on every signal below: a mention on a page the integration cannot see is ` +
              `invisible, and no error is raised — it simply is not in the results. ` +
              (crawl.pagesTruncated
                  ? `The crawl stopped at MAX_PAGES=${config.maxPages}, so this run does not cover the whole workspace.`
                  : 'The full reachable set was crawled.'),
        evidence: {
            pages: pages.slice(0, 20).map((p) => ({ id: p.id, title: pageTitle(p), url: p.url, lastEdited: p.last_edited_time })),
            dataSources: dataSources.map((d) => ({ id: d.id, title: pageTitle(d) })),
            truncated: crawl.pagesTruncated,
            cost: crawl.cost,
        },
    };
}

// ---------------------------------------------------------------------------
// SIGNAL 1 — N2: actions assigned to me in a database.
// The only one of the four with a real query behind it.
// ---------------------------------------------------------------------------
async function probeAssignments(ctx, log) {
    log('N2 signal 1: assigned to me in a database');
    const sources = ctx.crawl?.dataSources ?? [];

    if (!ctx.personUserId) {
        return skipped('N2', 'Can we list the database items assigned to me?', 'No person user id was resolved (see N0b).');
    }
    if (!sources.length) {
        return skipped('N2', 'Can we list the database items assigned to me?',
            'The integration can see no data sources, so there is no task database to query. Share one with it and re-run.');
    }

    const { databases: results, assignments: assigned, meTrap } = await collectAssignments({
        personUserId: ctx.personUserId,
        dataSources: sources,
    });
    ctx.assignments = assigned;
    ctx.databases = results;

    const queryable = results.filter((r) => (r.peopleProperties || []).length > 0);
    const withHandled = results.filter((r) => (r.handledProperties || []).length > 0);
    const anyQueryFailed = results.some((r) => (r.matches || []).some((m) => !m.ok));

    let verdict;
    let detail;
    if (!queryable.length) {
        verdict = 'skipped';
        detail = `${results.length} data source(s) reachable, none with a people-type property, so there is nothing ` +
            'that could be "assigned" to anyone. Add an Assignee property to a database and re-run.';
    } else if (anyQueryFailed) {
        verdict = 'fail';
        detail = 'At least one people filter was rejected. See the evidence for the error code.';
    } else {
        verdict = 'pass';
        detail = `The people filter works: \`{property: "<Assignee>", people: {contains: "<user-id>"}}\` against ` +
            `POST /v1/data_sources/{id}/query. ${assigned.length} row(s) assigned to you across ` +
            `${queryable.length} database(s). This is the one signal of the four that the API answers directly, with no ` +
            `crawling and no post-filtering. ` +
            (meTrap && meTrap.ok && meTrap.count === 0
                ? 'Note the trap probed here: the documented `"me"` shorthand resolves to the *authenticated* user, ' +
                  'which is the bot, so it returned 0 rows rather than an error. Always pass the explicit person id.'
                : '') +
            (withHandled.length < queryable.length
                ? ` Only ${withHandled.length} of ${queryable.length} have a status/checkbox/select property, so on the ` +
                  'others there would be nothing to watch to learn that the task was finished.'
                : ` All ${queryable.length} carry a status/checkbox/select property, which is what N7 keys "handled" off.`);
    }

    return {
        id: 'N2',
        question: 'Can we list the database items assigned to me?',
        verdict,
        headline: assigned.length ? `${assigned.length} row(s) assigned to you` : `${queryable.length} queryable database(s), 0 rows assigned to you`,
        detail,
        evidence: { databases: results, meShorthandTrap: meTrap },
    };
}

// ---------------------------------------------------------------------------
// N3 — is "new since last sync" expressible for assignments?
// ---------------------------------------------------------------------------
async function probeAssignmentWindow(ctx, log) {
    log('N3 "new since" window for assignments');
    const target = (ctx.crawl?.dataSources ?? []).find((d) => ctx.assignments?.some((a) => a.database === pageTitle(d)))
        ?? (ctx.crawl?.dataSources ?? [])[0];

    if (!target || !ctx.personUserId) {
        return skipped('N3', 'Can we ask only for what changed since the last sync?', 'No queryable database with an assignment to window.');
    }

    let schema = target.properties;
    if (!schema) {
        const { json, call } = await retrieveDataSource(target.id);
        if (!call.ok) return skipped('N3', 'Can we ask only for what changed since the last sync?', `Could not read the schema: ${call.error}`);
        schema = json.properties;
    }
    const prop = propertyNamesByType(schema, 'people')[0];
    if (!prop) return skipped('N3', 'Can we ask only for what changed since the last sync?', 'No people property on the database.');

    const build = (after) => ({
        filter: {
            and: [
                { property: prop, people: { contains: ctx.personUserId } },
                { timestamp: 'last_edited_time', last_edited_time: { after } },
            ],
        },
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        page_size: 50,
    });

    const wide = await queryDataSource(target.id, build(daysAgo(config.lookbackDays)));
    const narrow = await queryDataSource(target.id, build(iso(Date.now() - 3600_000)));

    if (!wide.call.ok || !narrow.call.ok) {
        return {
            id: 'N3',
            question: 'Can we ask only for what changed since the last sync?',
            verdict: 'fail',
            headline: `Compound filter rejected: ${wide.call.error || narrow.call.error}`,
            detail: wide.call.message || narrow.call.message || 'Without a timestamp filter every sync re-reads every row.',
            evidence: { wide: wide.call, narrow: narrow.call },
        };
    }

    const wideCount = (wide.json.results || []).length;
    const narrowCount = (narrow.json.results || []).length;
    const cutoff = Date.now() - 3600_000;
    const violations = (narrow.json.results || []).filter((p) => new Date(p.last_edited_time).getTime() < cutoff).length;

    return {
        id: 'N3',
        question: 'Can we ask only for what changed since the last sync?',
        verdict: violations === 0 ? 'partial' : 'fail',
        headline: `${wideCount} row(s) over ${config.lookbackDays}d vs ${narrowCount} over 1h, ${violations} outside the window`,
        detail: violations === 0
            ? 'The `last_edited_time` filter bounds results correctly, so an incremental sync is expressible and can be ' +
              'combined with the assignee filter in one `and`. Marked partial, not pass, for a reason that will bite: ' +
              '`last_edited_time` is not "assigned to me at". Any edit to the row moves it — a typo fix in the title looks ' +
              'exactly like a fresh assignment, and re-assigning a row edited last week to you today gives it a new ' +
              'timestamp with no way to tell what changed. There is no assigned_at, and no per-property change history in ' +
              'the API. Cockpit must keep its own copy of the last-seen assignee set per row and diff it locally; the ' +
              'timestamp filter is only useful for narrowing which rows to diff.'
            : `${violations} row(s) came back older than the requested window, so the filter cannot be trusted on its own.`,
        evidence: { database: pageTitle(target), property: prop, wideCount, narrowCount, violations, filter: build('<after>') },
    };
}

// ---------------------------------------------------------------------------
// SIGNAL 2 — N4: mentions of me in document bodies.
// The probe starts with a control that proves search cannot do this, because that
// negative is the whole reason the crawl exists.
// ---------------------------------------------------------------------------
async function probePageMentions(ctx, log) {
    log('N4 signal 2: mentions of me in page content');
    if (!ctx.personUserId) return skipped('N4', 'Can we find mentions of me inside documents?', 'No person user id (see N0b).');

    const crawl = ctx.crawl;
    ctx.pageMentions = collectPageMentions({ crawl, personUserId: ctx.personUserId });
    const mentioned = ctx.pageMentions;
    const pagesWithMention = [...new Set(mentioned.map((m) => m.pageId))];

    // The control: ask search for your own name. It matches titles only, so anything the
    // crawl found in a body that search did not return is direct evidence of the gap.
    let control = null;
    if (ctx.personName) {
        const { json, call } = await search({ query: ctx.personName, page_size: 100 });
        const hits = call.ok ? (json.results || []).map((r) => r.id) : [];
        control = {
            ok: call.ok,
            error: call.error,
            query: ctx.personName,
            hitCount: hits.length,
            foundByCrawlNotBySearch: pagesWithMention.filter((id) => !hits.some((h) => sameId(h, id))).length,
        };
    }

    // What a naive text search would have picked up instead: the name typed as plain text,
    // which notifies nobody and is pure noise in an inbox.
    const plainNameOnly = ctx.personName
        ? [
            ...crawl.allBlocks.map(({ block }) => blockRichText(block)),
            ...(crawl.allProperties || []).map(({ property }) => property.richText),
        ].filter((rich) => !mentionsUser(rich, ctx.personUserId) && namedInText(rich, ctx.personName)).length
        : null;

    const inBlocks = mentioned.filter((m) => m.anchor === 'block').length;
    const inProperties = mentioned.filter((m) => m.anchor === 'property').length;

    const wanted = urlToId(config.expectMentionPageUrl);
    const recall = wanted ? pagesWithMention.some((id) => sameId(id, wanted)) : null;

    let verdict;
    let detail;
    const gapProven = control?.ok && control.foundByCrawlNotBySearch > 0;

    if (!mentioned.length) {
        verdict = 'skipped';
        detail = `The crawl read ${crawl.cost.blocks} text block(s) and ${crawl.cost.properties} text property/properties ` +
            `across ${crawl.cost.pages} page(s) and found no mention token carrying your user id. Either nobody has ` +
            '@-mentioned you on a page the integration can see, or the mention is deeper than MAX_BLOCK_DEPTH. ' +
            'Mention yourself in a shared page and re-run.';
    } else {
        verdict = recall === false ? 'partial' : 'pass';
        detail = `${mentioned.length} reference(s) on ${pagesWithMention.length} page(s) mention you — ` +
            `${inBlocks} in a block, ${inProperties} in a page property — matched on the ` +
            '`mention` token carrying your user id rather than on your name as text' +
            (plainNameOnly ? ` — worth keeping: ${plainNameOnly} further block(s) merely contain your name as plain text, which notifies nobody and would be noise` : '') +
            '. The catch is not accuracy, it is how they were found: ' +
            (gapProven
                ? `POST /v1/search for "${control.query}" does not return ${control.foundByCrawlNotBySearch} of these ` +
                  'page(s) at all, because search matches titles only. '
                : 'POST /v1/search matches page titles only, never body content. ') +
            `There is no mentions endpoint and no content search, so this signal cost a full sweep: ` +
            `${crawl.cost.blockRequests} block request(s) over ${crawl.cost.pages} page(s), ` +
            `${(crawl.cost.wallMs / 1000).toFixed(1)}s wall clock.` +
            (inProperties
                ? ` Note what the property matches mean: ${inProperties} of these live in a page's title or a rich_text ` +
                  'column rather than in a block, which is the normal shape for a database row that references you. ' +
                  'Those rows often have no blocks at all, so a crawler that reads only blocks reports zero on them. ' +
                  'They cost nothing extra, because search returns page objects with their properties already attached.'
                : '') +
            (recall === false ? ' The page you flagged in EXPECT_MENTION_PAGE_URL was NOT among them, so recall is incomplete — check that the integration has access to it.' : '') +
            (recall === true ? ' The page you flagged in EXPECT_MENTION_PAGE_URL was found.' : '');
    }

    return {
        id: 'N4',
        question: 'Can we find mentions of me inside documents?',
        verdict,
        headline: mentioned.length
            ? `${mentioned.length} mention(s) of you in documents (${inBlocks} in blocks, ${inProperties} in properties), ` +
              `found by crawling ${crawl.cost.blocks} block(s) and ${crawl.cost.properties} property/properties`
            : `No document mentions found in ${crawl.cost.blocks} block(s) and ${crawl.cost.properties} property/properties`,
        detail,
        evidence: {
            searchControl: control,
            inBlocks,
            inProperties,
            plainNameOnlyFields: plainNameOnly,
            recallCheck: recall,
            samples: ctx.pageMentions.slice(0, 5),
            crawlCost: crawl.cost,
        },
    };
}

// ---------------------------------------------------------------------------
// SIGNAL 3 — N5: mentions of me in comments.
// ---------------------------------------------------------------------------
async function probeCommentMentions(ctx, log) {
    log('N5 signal 3: mentions of me in comments');
    if (!ctx.personUserId) return skipped('N5', 'Can we find mentions of me in comments?', 'No person user id (see N0b).');

    const crawl = ctx.crawl;
    if (crawl.commentAccessError) {
        return {
            id: 'N5',
            question: 'Can we find mentions of me in comments?',
            verdict: 'fail',
            headline: `GET /v1/comments failed: ${crawl.commentAccessError.error}`,
            detail: (crawl.commentAccessError.message || '') +
                ' Most often this is the "read comments" capability being off on the integration.',
            evidence: crawl.commentAccessError,
        };
    }

    ctx.commentMentions = collectCommentMentions({ crawl, personUserId: ctx.personUserId });
    const mentions = ctx.commentMentions;

    const wanted = urlToId(config.expectCommentMentionPageUrl);
    const recall = wanted ? mentions.some((m) => sameId(m.pageId, wanted)) : null;
    const inlineBlind = !config.deepComments;
    const inline = mentions.filter((m) => m.anchor === 'block').length;

    // Does commenting bump the page's `last_edited_time`?
    //
    // This decides whether a timestamp-bounded sweep — search sorted by last_edited_time,
    // stopping at the last high-water mark — can see comments at all. Any comment created
    // after its page's last_edited_time proves it cannot: the page looks untouched while
    // holding a brand-new comment. Free to compute from what the crawl already fetched.
    const timestampProbe = crawl.allComments.map(({ comment, page }) => ({
        pageTitle: pageTitle(page),
        pageLastEdited: page.last_edited_time,
        commentCreated: comment.created_time,
        minutesNewer: Math.round((Date.parse(comment.created_time) - Date.parse(page.last_edited_time)) / 60000),
    }));
    const newerThanPage = timestampProbe.filter((t) => t.minutesNewer > 0);
    ctx.commentTimestampFinding = {
        checked: timestampProbe.length,
        newerThanPage: newerThanPage.length,
        // A comment in the same minute proves nothing: Notion timestamps are minute-granular.
        decisive: newerThanPage.length > 0,
        widestGapMinutes: newerThanPage.length ? Math.max(...newerThanPage.map((t) => t.minutesNewer)) : 0,
        samples: timestampProbe.slice(0, 5),
    };
    // A comment you wrote that mentions you. In Slack this was pure noise; in Notion it is a
    // recognised note-to-self pattern, so it is reported rather than filtered.
    const selfAuthored = mentions.filter((m) => sameId(m.authorId, ctx.personUserId)).length;

    let verdict;
    let detail;
    if (!crawl.allComments.length) {
        verdict = 'skipped';
        detail = `No comments at all came back from ${crawl.cost.pages} page(s), so nothing was tested. ` +
            (inlineBlind
                ? 'Note that DEEP_COMMENTS is off, so only page-level discussions were read — an inline comment on a ' +
                  'paragraph would not have been seen. Set DEEP_COMMENTS=1 and re-run.'
                : 'Add a comment mentioning yourself on a shared page and re-run.');
    } else {
        verdict = mentions.length === 0 ? 'skipped' : (recall === false ? 'partial' : 'pass');
        detail = `${crawl.allComments.length} comment(s) read, ${mentions.length} mentioning you. ` +
            'Comments are readable and mentions inside them are exact. Two structural limits, both of which shape the ' +
            'integration rather than block it: there is no workspace-wide comment listing — GET /v1/comments takes one ' +
            '`block_id` at a time, so "comments involving me" can only be reconstructed by sweeping every page — and ' +
            'the endpoint returns *un-resolved* comments only, which is what makes N7 interesting. ' +
            (inlineBlind
                ? `This run read page-level discussions only (DEEP_COMMENTS=0), so inline comments anchored to ` +
                  `individual blocks were not covered; that costs one request per block, ${crawl.cost.blocks} here. ` +
                  'Be careful reading a zero from this configuration: the ordinary comment, made by selecting text, is ' +
                  'a block comment and is invisible to a page-level query.'
                : `Deep mode was on, at a cost of ${crawl.cost.commentRequests} comment request(s) — and it earned that: ` +
                  `${inline} of ${mentions.length} mention(s) are anchored to a block rather than to the page, so a ` +
                  'page-level-only sweep would have reported zero.') +
            (selfAuthored
                ? ` ${selfAuthored} of these you wrote yourself. Unlike Slack, that is not automatically noise — ` +
                  '@-mentioning yourself in a Notion comment is a common note-to-self, so Cockpit should decide this ' +
                  'deliberately rather than filtering on author by reflex.'
                : '') +
            (ctx.commentTimestampFinding?.decisive
                ? ` One measured consequence that decides the sync architecture: ${ctx.commentTimestampFinding.newerThanPage} ` +
                  `comment(s) here are newer than their own page's \`last_edited_time\` (by up to ` +
                  `${ctx.commentTimestampFinding.widestGapMinutes} minutes), which proves that **commenting does not ` +
                  'bump the page timestamp**. So a cheap timestamp-bounded sweep — search sorted by `last_edited_time`, ' +
                  'stopping at the last high-water mark — is blind to signals 3 and 4: the page holding a brand-new ' +
                  'comment looks untouched. Covering comments therefore means either the `comment.created` webhook, or ' +
                  'a full block-level sweep every time. There is no cheap middle option, because search does not index ' +
                  'comments either.'
                : '') +
            (recall === false ? ' The page flagged in EXPECT_COMMENT_MENTION_PAGE_URL produced no mention of you — check integration access, and whether the comment is inline rather than page-level.' : '') +
            (recall === true ? ' The page flagged in EXPECT_COMMENT_MENTION_PAGE_URL was found.' : '');
    }

    return {
        id: 'N5',
        question: 'Can we find mentions of me in comments?',
        verdict,
        headline: `${mentions.length} comment mention(s) out of ${crawl.allComments.length} comment(s) read`,
        detail,
        evidence: {
            recallCheck: recall,
            deepComments: config.deepComments,
            anchoredToBlock: inline,
            anchoredToPage: mentions.length - inline,
            selfAuthored,
            commentsBumpPageTimestamp: ctx.commentTimestampFinding,
            commentRequests: crawl.cost.commentRequests,
            samples: ctx.commentMentions.slice(0, 5),
        },
    };
}

// ---------------------------------------------------------------------------
// SIGNAL 4 — N6: replies to comments I wrote.
// Reconstructed from discussion_id + created_by, since there is no "my threads" query.
// ---------------------------------------------------------------------------
async function probeReplies(ctx, log) {
    log('N6 signal 4: replies to my comments');
    if (!ctx.personUserId) return skipped('N6', 'Can we detect replies to comments I wrote?', 'No person user id (see N0b).');

    const crawl = ctx.crawl;
    const { replies, discussionsVisible, discussionsInvolvingMe } = collectReplies({ crawl, personUserId: ctx.personUserId });
    ctx.commentReplies = replies;

    const wanted = urlToId(config.expectReplyPageUrl);
    const recall = wanted ? replies.some((r) => sameId(r.pageId, wanted)) : null;

    if (!discussionsInvolvingMe) {
        return {
            id: 'N6',
            question: 'Can we detect replies to comments I wrote?',
            verdict: 'skipped',
            headline: `None of the ${discussionsVisible} visible discussion(s) contains a comment written by you`,
            detail: 'The mechanism is straightforward — group comments by `discussion_id`, find threads where you ' +
                'authored a comment, take anything later by somebody else — but there is nothing here to run it on. ' +
                'Write a comment on a shared page, have someone reply, and re-run. ' +
                'Note that a resolved thread disappears from the API entirely, so if the thread you had in mind is ' +
                'resolved it will never appear here.',
            evidence: { discussionsVisible, samples: [] },
        };
    }

    return {
        id: 'N6',
        question: 'Can we detect replies to comments I wrote?',
        verdict: recall === false ? 'partial' : (replies.length ? 'pass' : 'partial'),
        headline: `${replies.length} reply/replies to you across ${discussionsInvolvingMe} thread(s) you started or joined`,
        detail: `Reconstructable, but only by reconstruction: comment objects carry \`discussion_id\` and \`created_by\`, ` +
            'so grouping recovers the thread and anything after your comment by another author is a reply. There is no ' +
            '"threads I participate in" query, so this rides entirely on the same sweep as N5 and inherits its reach. ' +
            'The sharper limit is that only *un-resolved* discussions are returned: the moment a thread is resolved it ' +
            'vanishes, taking your own comment with it, so Cockpit cannot look back at a thread after the fact — it has ' +
            'to have recorded it while it was open. ' +
            (replies.some((r) => !r.authorName)
                ? 'Reply authors come back as bare user ids (`created_by: {object, id}`), with no name, so rendering "X replied" ' +
                  'needs a separate user lookup and therefore the user-information capability.'
                : '') +
            (recall === false ? ' The page flagged in EXPECT_REPLY_PAGE_URL produced no reply — check whether that thread has been resolved.' : '') +
            (recall === true ? ' The page flagged in EXPECT_REPLY_PAGE_URL was found.' : ''),
        evidence: { discussionsVisible, discussionsInvolvingYou: discussionsInvolvingMe, recallCheck: recall, samples: replies.slice(0, 5) },
    };
}

// ---------------------------------------------------------------------------
// N7 — the second half of the question: when one of these is dealt with in Notion,
// can Cockpit find out? The answer differs per signal, which is the finding.
// ---------------------------------------------------------------------------
async function probeHandled(ctx, log) {
    log('N7 handled-afterwards detection');

    // (a) Assignments: only detectable if the database has a property that expresses done.
    // Reuses the schemas N2 already resolved, so nothing is re-fetched.
    const withHandled = (ctx.databases ?? [])
        .filter((d) => (d.handledProperties || []).length > 0)
        .map((d) => ({ database: d.title, properties: d.handledProperties }));

    // (b) Comments: the API returns un-resolved comments only. If a page is known to have a
    // resolved thread, its absence from the results is the measurement.
    let resolvedCheck = null;
    const resolvedPageId = urlToId(config.expectResolvedCommentPageUrl);
    if (resolvedPageId) {
        const { results, ok, error } = await paginate((cursor) => listComments(resolvedPageId, cursor));
        resolvedCheck = {
            pageId: resolvedPageId,
            ok,
            error,
            commentsReturned: ok ? results.length : null,
            discussionIds: ok ? [...new Set(results.map((c) => c.discussion_id))] : [],
        };
    }

    // (c) to_do blocks are the other place a Notion "action" lives, and unlike a comment
    // they carry their handled state in the payload.
    const todoMentions = (ctx.pageMentions || []).filter((m) => m.isTodo);

    const detail = [
        'The answer is different for each of the four signals, so treat this as four answers.',
        '',
        `1. Database assignment — yes. A status/checkbox/select property is readable on every query, so "done" is ` +
        `just a property value, and the \`page.properties_updated\` webhook fires on the change. ` +
        (withHandled.length
            ? `${withHandled.length} reachable database(s) carry such a property.`
            : 'No reachable database carries one, though, so on this workspace there is currently nothing to read.'),
        '',
        `2. Document mention — no. Notion has no notion of a page mention being handled: it is text in a block. The ` +
        `only observable change is the mention being edited away, which Cockpit sees as the block no longer matching ` +
        `on the next sweep. Dismissal has to live in Cockpit, not Notion. ` +
        (todoMentions.length
            ? `Partial exception measured here: ${todoMentions.length} of your page mentions sit inside a to_do block, ` +
              'which carries `checked: true/false`, so for those the checkbox is a real completion signal.'
            : 'One partial exception exists: a mention inside a to_do block carries `checked`, which is a real ' +
              'completion signal. None of your mentions are in to_do blocks on this run.'),
        '',
        `3 & 4. Comment mention and comment reply — only as a disappearance, and ambiguously. GET /v1/comments is ` +
        `documented as returning "un-resolved" comments, and the comment object has no resolved field at all. So a ` +
        `resolved thread does not come back marked resolved; it stops coming back. That is usable as a handled signal ` +
        `— an item Cockpit is tracking that is no longer in the results has been dealt with — but four different things ` +
        `produce exactly the same disappearance: resolved, deleted, page trashed, or integration access removed. ` +
        `Cockpit cannot tell them apart from the API alone. It can narrow it: the page still being fetchable rules out ` +
        `trashing and access loss, which leaves resolved-or-deleted. For a follow-up inbox that is usually enough, ` +
        `since both mean "stop showing me this".`,
        '',
        resolvedCheck
            ? (resolvedCheck.ok
                ? `Measured on the page flagged in EXPECT_RESOLVED_COMMENT_PAGE_URL: ${resolvedCheck.commentsReturned} ` +
                  `comment(s) returned across ${resolvedCheck.discussionIds.length} discussion(s). If the thread you ` +
                  'resolved is not among them, that is the invisibility confirmed.'
                : `Could not read comments on the flagged page: ${resolvedCheck.error}.`)
            : 'Set EXPECT_RESOLVED_COMMENT_PAGE_URL to a page where you have resolved a thread to measure the ' +
              'invisibility directly rather than taking the documentation for it.',
        '',
        'Run `npm run handled` for the real experiment: it snapshots all four signals, you then mark things handled in ' +
        'Notion by hand, and the second run classifies exactly what the API let us observe.',
    ].join('\n');

    return {
        id: 'N7',
        question: 'If one of these is marked handled in Notion afterwards, can we detect it?',
        verdict: 'partial',
        headline: 'Yes for database assignments, no for document mentions, only as an ambiguous disappearance for comments',
        detail,
        evidence: {
            databasesWithHandledProperty: withHandled,
            resolvedCommentCheck: resolvedCheck,
            todoMentions: todoMentions.length,
            webhookEventsAvailable: [
                'page.properties_updated — fires on the assignment/status change (aggregated, sub-minute delay)',
                'page.content_updated — fires when blocks change, so a mention being removed is observable, but the payload names the page, not the block',
                'comment.created, comment.updated, comment.deleted — not aggregated',
                'no event exists for a comment being resolved, and none for anything entering the Notion Inbox',
            ],
        },
    };
}

// ---------------------------------------------------------------------------
// N8 — does each signal carry what a Cockpit row needs?
// ---------------------------------------------------------------------------
function probeRowShape(ctx) {
    const items = buildItems(ctx);
    if (!items.length) {
        return skipped('N8', 'Do the results carry everything a Cockpit row needs?', 'No items from any of the four signals to inspect.');
    }

    const needed = ['title', 'from', 'isoTime', 'url'];
    const coverage = Object.fromEntries(needed.map((k) => [k, items.filter((i) => i[k]).length]));
    const approximateLinks = items.filter((i) => !i.urlIsExact).length;
    const complete = needed.every((k) => coverage[k] === items.length);

    // Measured on the source objects, not on the rendered rows: the question is what the
    // comment payload itself carried, before the harness patched the name in.
    const commentSources = [...(ctx.commentMentions || []), ...(ctx.commentReplies || [])];
    const authorNameInPayload = commentSources.filter((c) => c.authorName).length;
    const resolvedByLookup = commentSources.filter((c) => !c.authorName && ctx.userNames?.get(c.authorId)).length;
    const stillUnknown = commentSources.filter((c) => !c.authorName && !ctx.userNames?.get(c.authorId)).length;

    return {
        id: 'N8',
        question: 'Do the results carry everything a Cockpit row needs?',
        verdict: complete && !approximateLinks && !stillUnknown ? 'pass' : 'partial',
        headline: `${items.length} item(s); ${approximateLinks} with an approximate link, ` +
            `${commentSources.length - authorNameInPayload} needing an author lookup`,
        detail: 'Pages are self-sufficient: a page object carries `url`, so assignment and document-mention rows deep-link ' +
            'exactly, with no follow-up call. Comments are not, in two ways. ' +
            'First, a comment object has no url and no permalink, only ids, so a comment row can only link to the page the ' +
            'thread lives on — Cockpit lands the user on the right page and leaves them to find the thread. ' +
            `Second, \`created_by\` is a bare \`{object, id}\` with no name. Author names therefore come from one of two ` +
            `places, and this run measured which: ${authorNameInPayload} of ${commentSources.length} comment(s) carried a ` +
            'usable name in `display_name.resolved_name`' +
            (authorNameInPayload
                ? ' — better than the documentation implies, since that field is described as a custom name an integration ' +
                  'sets, yet it was populated for an ordinary human comment. Worth relying on, but not worth relying on ' +
                  'exclusively: keep the id-to-name fallback, because a field that is documented as optional can be absent.'
                : ', so every author needed a lookup.') +
            ` ${resolvedByLookup} author(s) needed the GET /v1/users fallback` +
            (stillUnknown ? `, and ${stillUnknown} could not be resolved at all.` : '.'),
        evidence: {
            coverage, sampleSize: items.length, approximateLinks,
            commentAuthors: { total: commentSources.length, nameInPayload: authorNameInPayload, resolvedByLookup, stillUnknown },
            sample: items.slice(0, 5),
        },
    };
}

// ---------------------------------------------------------------------------
// N9 — what the sweep costs, and where the rate limit bites. The cost is the reason
// the sync design cannot just be "poll everything".
// ---------------------------------------------------------------------------
async function probeCost(ctx, includeRateLimit, log) {
    const cost = ctx.crawl?.cost;
    if (!cost) return skipped('N9', 'What does one full sweep cost?', 'No crawl was performed.');

    const projected = projectCost(cost, Number(process.env.WORKSPACE_PAGE_ESTIMATE || 500));
    let burst = null;

    if (includeRateLimit) {
        log('N9 rate-limit burst (20 unpaced requests)');
        burst = [];
        for (let i = 0; i < 20; i++) {
            // Deliberately bypasses the paced client to find the real ceiling.
            const started = Date.now();
            const res = await fetch('https://api.notion.com/v1/users/me', {
                headers: { Authorization: `Bearer ${config.token}`, 'Notion-Version': config.version },
            });
            burst.push({ i: i + 1, status: res.status, retryAfter: res.headers.get('retry-after'), ms: Date.now() - started });
            if (res.status === 429) break;
        }
    }

    const limited = burst?.find((b) => b.status === 429);

    return {
        id: 'N9',
        question: 'What does one full sweep cost, and where does the rate limit bite?',
        verdict: 'info',
        headline: `Sweep: ${cost.totalRequests} request(s) for ${cost.pages} page(s) in ${(cost.wallMs / 1000).toFixed(1)}s; ` +
            `${callStats().requests} request(s) in the whole run` +
            (limited ? ` · 429 after ${limited.i} unpaced request(s)` : ''),
        detail: `Signal 1 is one request per database. Signals 2, 3 and 4 share a sweep costing about ` +
            `${projected?.requestsPerPage ?? '?'} request(s) per page` +
            (cost.deepComments ? ' with inline comments included' : ' with page-level comments only; inline comments would add one request per block') +
            `. Extrapolated to a ${projected?.workspacePages ?? '?'}-page workspace that is roughly ` +
            `${projected?.projectedRequests ?? '?'} requests, about ${projected?.projectedSeconds ?? '?'}s at the ` +
            'documented ~3 requests/second, for one user. Read that as the **backfill and full-reconciliation** cost, ' +
            'not as a per-sync cost: it is what a cold start or a catch-up after downtime costs, not what steady state ' +
            'costs. Full sweeps are for reconciliation on a schedule, not for latency. Webhooks (`page.content_updated`, ' +
            '`comment.created`) are what make the common case cheap, because the payload names the changed object and ' +
            'Cockpit then fetches only that — one or two requests per real change, not a sweep. ' +
            (ctx.commentTimestampFinding?.decisive
                ? 'The two halves are not equivalent, though, and N5 measured why. Signals 1 and 2 are page edits, so a ' +
                  'timestamp-bounded sweep can catch up on them cheaply: walk search sorted by `last_edited_time` until ' +
                  'you pass the high-water mark, and stop. Signals 3 and 4 cannot be caught up that way at all, because ' +
                  'commenting does not bump the page timestamp — reconciling comments always costs the full block-level ' +
                  'sweep. That asymmetry is the real argument for webhooks here: not latency, but the fact that a missed ' +
                  '`comment.created` is expensive to recover from, while a missed page edit is not. '
                : '') +
            (cost.depthTruncatedPages ? `${cost.depthTruncatedPages} page(s) had blocks deeper than MAX_BLOCK_DEPTH=${cost.maxBlockDepth} and were not fully read, so this cost is a floor.` : ''),
        evidence: { cost, projected, burst, apiCalls: callStats() },
    };
}

// ---------------------------------------------------------------------------

function skipped(id, question, detail) {
    return { id, question, verdict: 'skipped', headline: 'Inconclusive — no data to test against', detail, evidence: {} };
}

function buildItems(ctx) {
    const authorName = (comment) => comment.authorName || ctx.userNames?.get(comment.authorId) || comment.authorId || 'unknown';
    return mergeItems([
        (ctx.assignments || []).map((a) => toCockpitItem({
            origin: 'assignment',
            id: `assignment:${a.id}`,
            title: a.title,
            text: `${a.title} · ${a.database}`,
            url: a.url,
            from: a.database,
            isoTime: a.lastEdited,
            pageId: a.id,
            extra: { handledState: a.handledState },
        })),
        (ctx.pageMentions || []).map((m) => toCockpitItem({
            origin: 'page-mention',
            id: `page-mention:${m.blockId}`,
            title: m.pageTitle,
            text: m.text || m.pageTitle,
            url: m.url,
            from: m.pageTitle,
            isoTime: m.lastEdited,
            pageId: m.pageId,
        })),
        (ctx.commentMentions || []).map((c) => toCockpitItem({
            origin: 'comment-mention',
            id: `comment-mention:${c.commentId}`,
            title: c.pageTitle,
            text: c.text,
            url: c.url,
            urlIsExact: false,
            from: authorName(c),
            isoTime: c.createdTime,
            pageId: c.pageId,
        })),
        (ctx.commentReplies || []).map((r) => toCockpitItem({
            origin: 'comment-reply',
            id: `comment-reply:${r.commentId}`,
            title: r.pageTitle,
            text: r.text,
            url: r.url,
            urlIsExact: false,
            from: authorName(r),
            isoTime: r.createdTime,
            pageId: r.pageId,
        })),
    ]);
}

export async function runProbes({ includeRateLimit = false, onProgress = () => {} } = {}) {
    resetCallLog();
    const startedAt = new Date().toISOString();
    const ctx = {};
    const probes = [];

    const auth = await probeAuth(ctx, onProgress);
    probes.push(auth);
    if (auth.verdict === 'fail') return finish({ startedAt, ctx, probes, aborted: true });

    probes.push(await probePersona(ctx, onProgress));

    const reach = await probeReach(ctx, onProgress);
    probes.push(reach);
    if (reach.verdict === 'fail') return finish({ startedAt, ctx, probes, aborted: false });

    probes.push(await probeAssignments(ctx, onProgress));
    probes.push(await probeAssignmentWindow(ctx, onProgress));
    probes.push(await probePageMentions(ctx, onProgress));
    probes.push(await probeCommentMentions(ctx, onProgress));
    probes.push(await probeReplies(ctx, onProgress));
    probes.push(await probeHandled(ctx, onProgress));
    probes.push(probeRowShape(ctx));
    probes.push(await probeCost(ctx, includeRateLimit, onProgress));

    return finish({ startedAt, ctx, probes, aborted: false });
}

// The four questions asked, answered one line each, so the report leads with what was
// asked rather than with probe ids.
const SIGNAL_MAP = [
    { key: 'assignments', question: '1. All new actions assigned to me in a database', probe: 'N2' },
    { key: 'page-mentions', question: '2. All new mentions of me in documents', probe: 'N4' },
    { key: 'comment-mentions', question: '3. All new mentions of me in comments', probe: 'N5' },
    { key: 'comment-replies', question: '4. All replies to comments I created', probe: 'N6' },
    { key: 'handled', question: '5. Notification when one of these is marked handled', probe: 'N7' },
];

function finish({ startedAt, ctx, probes, aborted }) {
    const byId = Object.fromEntries(probes.map((p) => [p.id, p]));
    const signals = SIGNAL_MAP.map((s) => {
        const probe = byId[s.probe];
        return {
            ...s,
            verdict: probe?.verdict ?? 'not-run',
            headline: probe?.headline ?? 'Not reached in this run',
        };
    });

    const scored = probes.filter((p) => ['pass', 'partial', 'fail'].includes(p.verdict));
    const failed = scored.filter((p) => p.verdict === 'fail');
    const partial = scored.filter((p) => p.verdict === 'partial');
    // The four signals are what the POC exists to answer. If any was skipped for lack of
    // data, the run has no verdict to give however green the rest looks.
    const coreSkipped = probes.filter((p) => ['N2', 'N4', 'N5', 'N6'].includes(p.id) && p.verdict === 'skipped');

    let conclusion;
    if (aborted) conclusion = 'blocked';
    else if (failed.length) conclusion = 'no';
    else if (coreSkipped.length) conclusion = 'inconclusive';
    else if (partial.length) conclusion = 'qualified-yes';
    else conclusion = 'yes';

    const dataCaveat = coreSkipped.length
        ? `No verdict is possible for ${coreSkipped.map((p) => p.id).join(', ')}: there was nothing in the workspace to ` +
          'test against. Seed it first — assign yourself a database row, @-mention yourself in a page body, have someone ' +
          'comment mentioning you, and have someone reply to a comment of yours — then re-run.'
        : null;

    return {
        startedAt,
        finishedAt: new Date().toISOString(),
        conclusion,
        signals,
        dataCaveat,
        plan: config.plan,
        apiVersion: config.version,
        identity: {
            botId: ctx.botId, botName: ctx.botName, workspace: ctx.workspaceName,
            personUserId: ctx.personUserId ?? null, personName: ctx.personName ?? null,
            canReadUsers: ctx.canReadUsers ?? null, canReadComments: ctx.canReadComments ?? null,
        },
        reach: ctx.crawl
            ? { pages: ctx.crawl.pages.length, dataSources: ctx.crawl.dataSources.length, truncated: ctx.crawl.pagesTruncated }
            : null,
        cost: ctx.crawl?.cost ?? null,
        probes,
        inboxPreview: buildItems(ctx),
        calls: callLog,
    };
}
