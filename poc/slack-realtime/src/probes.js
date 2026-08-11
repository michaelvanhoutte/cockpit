// The probe battery. Each probe answers one question that has to be true before
// Cockpit can build its follow-up inbox on the Real-time Search API
// (docs/slack-integration-options.md, "Selected Approach").
import { config } from './config.js';
import { authTest, searchContext, searchInfo, permalinkToTs, tsToDate, resetCallLog, callLog } from './slack.js';
import { messageFields, mentionsUser, toCockpitItems } from './normalize.js';

// assistant.search.context is documented at ~10 requests/minute per user, so the
// battery paces itself instead of firing everything at once. The rate-limit probe
// deliberately ignores this.
const MIN_INTERVAL_MS = config.probeIntervalMs;
let lastCallAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pacedSearch(args, { paced = true } = {}) {
    if (paced) {
        const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
        if (wait > 0) await sleep(wait);
    }
    lastCallAt = Date.now();
    let { json, call } = await searchContext(args);

    // One polite retry so a burst does not get reported as a capability failure.
    if (call.status === 429) {
        const retryAfter = Number(call.headers['retry-after'] || 30);
        await sleep(Math.min(retryAfter, 60) * 1000);
        lastCallAt = Date.now();
        ({ json, call } = await searchContext(args));
    }
    return { json, call };
}

function resultMessages(json) {
    return json?.results?.messages ?? json?.messages ?? [];
}

function verdictOf(passed, partial) {
    if (passed) return 'pass';
    return partial ? 'partial' : 'fail';
}

function containsTs(messages, wantedTs) {
    if (!wantedTs) return null;
    return messages.some((m) => String(messageFields(m).ts || '').startsWith(String(wantedTs).slice(0, 15)));
}

/** Run a set of query shapes for the same question and report which ones worked. */
async function runVariants(variants, onProgress) {
    const runs = [];
    for (const variant of variants) {
        onProgress?.(`  ${variant.label}`);
        const { json, call } = await pacedSearch(variant.args);
        const messages = resultMessages(json);
        runs.push({
            label: variant.label,
            args: variant.args,
            ok: call.ok,
            error: call.error,
            needed: call.needed,
            count: messages.length,
            ms: call.ms,
            messages,
        });
    }
    return runs;
}

// ---------------------------------------------------------------------------
// P0 — is the token usable at all, and does it carry the search scopes?
// ---------------------------------------------------------------------------
async function probeAuth(ctx, log) {
    log('P0 auth.test');
    const { json, call } = await authTest();
    if (!call.ok) {
        return {
            id: 'P0',
            question: 'Is the user token valid?',
            verdict: 'fail',
            headline: `auth.test failed: ${call.error}`,
            detail: 'Nothing else can run. Check that SLACK_USER_TOKEN is a current xoxp- token for the right workspace.',
            evidence: { error: call.error },
        };
    }
    ctx.userId = config.userId || json.user_id;
    ctx.userName = json.user;
    ctx.team = json.team;
    ctx.teamId = json.team_id;
    ctx.url = json.url;

    const scopes = (call.headers['x-oauth-scopes'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    ctx.scopes = scopes;
    const required = ['search:read.public', 'search:read.im', 'search:read.private'];
    const missing = scopes.length ? required.filter((s) => !scopes.includes(s)) : [];

    return {
        id: 'P0',
        question: 'Is the user token valid, and does it carry the search:read.* scopes?',
        verdict: missing.length ? 'partial' : 'pass',
        headline: `Authenticated as ${json.user} (${ctx.userId}) in ${json.team}`,
        detail: scopes.length
            ? (missing.length ? `Missing scopes: ${missing.join(', ')}` : 'All expected search scopes present.')
            : 'Slack did not return an x-oauth-scopes header; scopes could not be verified here.',
        evidence: { userId: ctx.userId, team: json.team, scopes, missing },
    };
}

// ---------------------------------------------------------------------------
// P0b — does this workspace's plan actually include semantic search?
// Slack: "Semantic search is available only on workspaces within plans that
// include Slack AI Search" (Business+ and above). Free and Pro workspaces can
// still call the API, but only keyword search will behave.
// ---------------------------------------------------------------------------
async function probeEntitlement(ctx, log) {
    log('P0b assistant.search.info (plan entitlement)');
    const { json, call } = await searchInfo();

    if (!call.ok) {
        ctx.aiSearchEnabled = null;
        const accessError = ['not_allowed_token_type', 'method_not_supported_for_team', 'missing_scope', 'not_authed'].includes(call.error);
        return {
            id: 'P0b',
            question: 'Does this workspace have Slack AI Search (semantic search) enabled?',
            verdict: 'partial',
            headline: `assistant.search.info failed: ${call.error}`,
            detail: accessError
                ? 'This usually means the app is not enrolled in Real-time Search, or the scope is missing. ' +
                  'The remaining probes will still run, but treat their failures as inconclusive until this succeeds.'
                : 'Entitlement could not be determined. The remaining probes still run, using keyword search where possible.',
            evidence: { error: call.error, needed: call.needed },
        };
    }

    ctx.aiSearchEnabled = json.is_ai_search_enabled === true;

    return {
        id: 'P0b',
        question: 'Does this workspace have Slack AI Search (semantic search) enabled?',
        verdict: ctx.aiSearchEnabled ? 'pass' : 'partial',
        headline: ctx.aiSearchEnabled
            ? 'Slack AI Search is enabled — semantic and natural-language queries are available'
            : 'Slack AI Search is NOT enabled — keyword search only',
        detail: ctx.aiSearchEnabled
            ? 'Natural-language queries such as "anything sent to me recently" are supported on this plan.'
            : 'Slack gates semantic search behind plans that include Slack AI Search (Business+ and above). ' +
              'On this workspace only keyword matching will work, so any probe below that relies on a natural-language ' +
              'query is testing the plan, not the API. Read those results with that in mind.',
        evidence: { is_ai_search_enabled: json.is_ai_search_enabled },
    };
}

// ---------------------------------------------------------------------------
// P1 — can we enumerate recent DMs? This is the riskiest question: the API is a
// *search* endpoint and always wants a query, but an inbox wants "everything new".
// ---------------------------------------------------------------------------
async function probeDms(ctx, log) {
    log('P1 direct messages');
    const after = ctx.afterTs;
    const base = { channel_types: ['im', 'mpim'], sort: 'timestamp', sort_dir: 'desc', limit: 20, after };

    // The first two variants are "give me everything"; the third is targeted. The
    // difference between them is the finding.
    const runs = await runVariants([
        { label: 'broad natural-language query, semantic on', args: { ...base, query: 'anything sent to me recently' } },
        { label: 'wildcard query, semantic off', args: { ...base, query: '*', disable_semantic_search: true } },
        { label: 'own name as query', args: { ...base, query: ctx.userName || 'me' } },
    ], log);

    const [broad, wildcard, targeted] = runs;
    const enumerates = [broad, wildcard].some((r) => r.ok && r.count > 0);
    const best = runs.filter((r) => r.ok).sort((a, b) => b.count - a.count)[0];
    const anyOk = runs.some((r) => r.ok);
    const gotResults = (best?.count ?? 0) > 0;
    const recall = containsTs(best?.messages ?? [], permalinkToTs(config.expectDmPermalink));

    ctx.dmMessages = best?.messages ?? [];
    ctx.dmBestVariant = best?.label ?? null;

    let verdict;
    let detail;
    if (!anyOk) {
        verdict = 'fail';
        detail = `Every DM query was rejected (${runs.map((r) => r.error).filter(Boolean).join(', ')}). ` +
            'invalid_auth/missing_scope points at app config; not_allowed_token_type or a program error points at Real-time Search access.';
    } else if (!gotResults) {
        verdict = 'fail';
        detail = 'The calls succeeded but returned nothing at all. Either there were no DMs in the lookback window ' +
            '(re-run when you know there were), or the API will not surface DMs without a meaningful search term.';
    } else if (!enumerates) {
        verdict = 'partial';
        detail = `Only the targeted query worked: "${targeted.label}" returned ${targeted.count} DM(s), while both ` +
            '"give me everything" variants returned nothing. This is the core risk for the inbox design — Real-time Search ' +
            'behaves like a search box, not like a feed, so Cockpit cannot ask it for "all new DMs" and would have to ' +
            'issue standing topic queries instead. Worth re-checking against Option 2 (conversations.list + history) for DMs.' +
            (ctx.aiSearchEnabled === false
                ? ' Caveat: this workspace has no Slack AI Search, so the natural-language variant never had a fair chance. ' +
                  'Re-run on a Business+ workspace before treating this as a verdict on the API.'
                : '');
    } else {
        // A workspace whose only DMs are Slackbot notices has not really been tested.
        const human = (best.messages || []).filter((m) => messageFields(m).isBot !== true).length;
        if (human === 0) {
            verdict = 'skipped';
            detail = `The only DM(s) returned came from Slackbot or an app, not from a person. The mechanism works — ` +
                'the API returned a DM without being told what to look for - but there is no human conversation here to ' +
                'test recall against. Send yourself or a colleague a real DM and re-run.';
        } else {
            verdict = recall === false ? 'partial' : 'pass';
            detail = `Broad enumeration works: "${best.label}" returned ${best.count} DM(s) without naming a topic, ${human} from a person.` +
                (recall === false ? ' However, the DM you flagged in EXPECT_DM_PERMALINK was NOT among them, so recall is incomplete.' : '') +
                (recall === true ? ' The DM you flagged in EXPECT_DM_PERMALINK was found.' : '');
        }
    }

    return {
        id: 'P1',
        question: 'Can we retrieve recent direct messages without naming what we are looking for?',
        verdict,
        headline: gotResults ? `${best.count} DM(s) via "${best.label}"` : (anyOk ? 'Calls succeeded, zero DMs returned' : 'All DM queries rejected'),
        detail,
        evidence: { runs: runs.map(stripMessages), broadEnumerationWorks: enumerates, recallCheck: recall },
    };
}

// ---------------------------------------------------------------------------
// P2 — can we find explicit @mentions of this user in channels?
// ---------------------------------------------------------------------------
async function probeMentions(ctx, log) {
    log('P2 @mentions');
    const after = ctx.afterTs;
    const base = { channel_types: ['public_channel', 'private_channel'], sort: 'timestamp', sort_dir: 'desc', limit: 20, after };
    const mentionToken = `<@${ctx.userId}>`;

    // The control comes first and deliberately does not mention anyone. Without it,
    // "zero mentions found" is unreadable: it could mean the search failed, or simply
    // that this workspace has no channel messages to find.
    const [control] = await runVariants([
        { label: 'control: any channel message at all', args: { ...base, query: '*', disable_semantic_search: true } },
    ], log);
    ctx.channelCorpus = control.ok ? control.count : null;

    const runs = await runVariants([
        { label: 'literal <@USER_ID>, semantic off', args: { ...base, query: mentionToken, disable_semantic_search: true } },
        { label: 'literal <@USER_ID>, semantic on', args: { ...base, query: mentionToken } },
        { label: 'natural language "messages mentioning <name>"', args: { ...base, query: `messages mentioning ${ctx.userName || 'me'}` } },
    ], log);

    const best = runs.filter((r) => r.ok).sort((a, b) => b.count - a.count)[0];
    const anyOk = runs.some((r) => r.ok);

    // No channel messages exist in the window, so the mention queries were never
    // given anything to find. Not a result either way.
    if (control.ok && control.count === 0) {
        return {
            id: 'P2',
            question: `Can we find channel messages containing ${mentionToken}?`,
            verdict: 'skipped',
            headline: 'Inconclusive — this workspace has no channel messages in the window',
            detail: 'The control query asked for any channel message at all and got nothing back, so the mention ' +
                'queries had an empty corpus to search. This says nothing about whether mention search works. ' +
                `Post a few messages in a channel, have someone (or yourself) write ${mentionToken}, then re-run.`,
            evidence: { control: stripMessages(control), runs: runs.map(stripMessages) },
        };
    }

    // Precision matters as much as recall: a semantic search for a name will happily
    // return messages that merely talk about the person.
    const scored = runs.filter((r) => r.ok).map((r) => {
        const withToken = r.messages.filter((m) => mentionsUser(messageFields(m).text, ctx.userId)).length;
        return { label: r.label, count: r.count, containingRealMention: withToken };
    });

    const recall = containsTs(best?.messages ?? [], permalinkToTs(config.expectMentionPermalink));
    const precise = scored.find((s) => s.count > 0 && s.containingRealMention === s.count);

    ctx.mentionMessages = (best?.messages ?? []).filter((m) => mentionsUser(messageFields(m).text, ctx.userId));
    ctx.mentionBestVariant = best?.label ?? null;

    // Mentions you wrote yourself are not follow-ups. Worth knowing the API does not
    // filter them, since a naive integration would put your own messages in your inbox.
    const selfAuthored = ctx.mentionMessages.filter((m) => messageFields(m).authorId === ctx.userId).length;

    let detail;
    if (!anyOk) {
        detail = `Every mention query was rejected (${runs.map((r) => r.error).filter(Boolean).join(', ')}).`;
    } else if (!(best?.count > 0)) {
        detail = 'Calls succeeded but no channel messages came back for the lookback window.';
    } else {
        detail = scored.map((s) => `"${s.label}": ${s.count} result(s), ${s.containingRealMention} containing a real ${mentionToken}`).join('. ') + '.' +
            (precise ? ` "${precise.label}" is exact — every result is a genuine mention.` : ' No variant returned only genuine mentions, so results need client-side filtering on the raw text.') +
            (ctx.aiSearchEnabled === false ? ' Note: no Slack AI Search on this workspace, so the semantic variants fell back to keyword matching.' : '') +
            (recall === false ? ' The mention you flagged in EXPECT_MENTION_PERMALINK was NOT returned.' : '') +
            (recall === true ? ' The mention you flagged in EXPECT_MENTION_PERMALINK was found.' : '') +
            (selfAuthored ? ` ${selfAuthored} of them you wrote yourself — Cockpit would need to drop self-authored mentions.` : '');
    }

    return {
        id: 'P2',
        question: `Can we find channel messages containing ${mentionToken}?`,
        verdict: verdictOf(Boolean(precise) && recall !== false, anyOk && best?.count > 0),
        headline: best?.count > 0 ? `${ctx.mentionMessages.length} genuine mention(s) out of ${best.count} result(s)` : (anyOk ? 'Calls succeeded, zero results' : 'All mention queries rejected'),
        detail,
        evidence: { control: stripMessages(control), runs: runs.map(stripMessages), precision: scored, recallCheck: recall, selfAuthored },
    };
}

// ---------------------------------------------------------------------------
// P3 — does `after` actually bound results? Incremental sync depends on it.
// ---------------------------------------------------------------------------
async function probeIncremental(ctx, log) {
    log('P3 incremental sync window');
    const wide = Math.floor(Date.now() / 1000) - config.lookbackDays * 86400;
    const narrow = Math.floor(Date.now() / 1000) - 3600;
    const shared = { channel_types: ['im', 'mpim', 'public_channel', 'private_channel'], sort: 'timestamp', sort_dir: 'desc', limit: 20, query: '*', disable_semantic_search: true };

    const runs = await runVariants([
        { label: `after = ${config.lookbackDays}d ago`, args: { ...shared, after: wide } },
        { label: 'after = 1h ago', args: { ...shared, after: narrow } },
    ], log);

    const [wideRun, narrowRun] = runs;
    if (!wideRun.ok || !narrowRun.ok) {
        return {
            id: 'P3',
            question: 'Does the `after` timestamp bound results, so we can sync incrementally?',
            verdict: 'fail',
            headline: 'Could not test — the windowed calls were rejected',
            detail: `Errors: ${[wideRun.error, narrowRun.error].filter(Boolean).join(', ')}`,
            evidence: { runs: runs.map(stripMessages) },
        };
    }

    const violations = narrowRun.messages
        .map((m) => tsToDate(messageFields(m).ts))
        .filter((d) => d && d.getTime() < narrow * 1000).length;
    const monotonic = narrowRun.count <= wideRun.count;

    return {
        id: 'P3',
        question: 'Does the `after` timestamp bound results, so we can sync incrementally?',
        verdict: violations === 0 && monotonic ? 'pass' : 'partial',
        headline: `${wideRun.count} result(s) over ${config.lookbackDays}d vs ${narrowRun.count} over 1h, ${violations} outside the window`,
        detail: violations === 0
            ? 'Every returned message falls inside the requested window, so "give me what is new since last sync" is expressible.'
            : `${violations} message(s) came back older than the requested \`after\`, so the window cannot be trusted on its own — Cockpit would have to re-filter by ts.`,
        evidence: { runs: runs.map(stripMessages), violations, monotonic },
    };
}

// ---------------------------------------------------------------------------
// P4 — do results carry what a Cockpit row needs? (deep link, author, channel, ts)
// ---------------------------------------------------------------------------
function probeFields(ctx) {
    const sample = [...(ctx.dmMessages || []), ...(ctx.mentionMessages || [])];
    if (!sample.length) {
        return {
            id: 'P4',
            question: 'Do results carry everything a Cockpit row needs (permalink, author, channel, timestamp)?',
            verdict: 'skipped',
            headline: 'No messages available to inspect',
            detail: 'P1 and P2 returned nothing, so there was nothing to check the shape of.',
            evidence: {},
        };
    }

    const needed = ['ts', 'text', 'permalink', 'authorId', 'channelId'];
    const coverage = {};
    for (const key of needed) {
        coverage[key] = sample.filter((m) => messageFields(m)[key] !== undefined).length;
    }
    const complete = needed.every((k) => coverage[k] === sample.length);
    const missing = needed.filter((k) => coverage[k] < sample.length);
    const botCount = sample.filter((m) => messageFields(m).isBot === true).length;
    const thin = sample.length < 3 || botCount === sample.length;

    return {
        id: 'P4',
        question: 'Do results carry everything a Cockpit row needs (permalink, author, channel, timestamp)?',
        verdict: complete ? (thin ? 'partial' : 'pass') : 'partial',
        headline: complete
            ? `All ${needed.length} fields present on all ${sample.length} sampled message(s)`
            : `Missing on some messages: ${missing.join(', ')}`,
        detail: (complete
            ? 'Rows can be built directly, including the deep link back into Slack that the prototype already uses.'
            : 'Some rows would need a second API call (conversations.info / users.info) to be complete, which weakens the data-minimisation argument.') +
            (thin ? ` Sample is too thin to generalise from: ${sample.length} message(s), ${botCount} of them from a bot.` : ''),
        evidence: { sampleSize: sample.length, botCount, coverage, rawKeys: Object.keys(sample[0] || {}) },
    };
}

// ---------------------------------------------------------------------------
// P5 — what does the rate limit actually feel like? Opt-in: it burns quota.
// ---------------------------------------------------------------------------
async function probeRateLimit(ctx, log) {
    log('P5 rate limit (burst of 12, unpaced)');
    const args = { query: '*', disable_semantic_search: true, channel_types: ['public_channel'], limit: 1, after: ctx.afterTs };
    const results = [];
    for (let i = 0; i < 12; i++) {
        const { call } = await searchContext(args);
        results.push({ i: i + 1, status: call.status, ok: call.ok, error: call.error, retryAfter: call.headers['retry-after'] ?? null, ms: call.ms });
        if (call.status === 429) break;
    }
    const limited = results.find((r) => r.status === 429);
    return {
        id: 'P5',
        question: 'Where does the per-user rate limit actually bite?',
        verdict: 'info',
        headline: limited ? `429 after ${limited.i} request(s), Retry-After ${limited.retryAfter ?? 'unset'}s` : `12 requests with no 429`,
        detail: limited
            ? 'Confirms the documented ~10 req/min per user. Background polling for many users has to be budgeted against this.'
            : 'No throttling observed in a 12-request burst; the documented limit may be higher for this workspace.',
        evidence: { results },
    };
}

// Keeps a couple of raw messages per variant. Without them, questioning a probe's
// interpretation of the data costs another API call — which is exactly how the
// mention-token bug went unnoticed for a run.
function stripMessages(run) {
    const { messages, ...rest } = run;
    return { ...rest, sample: (messages || []).slice(0, 2) };
}

export async function runProbes({ includeRateLimit = false, onProgress = () => {} } = {}) {
    resetCallLog();
    const startedAt = new Date().toISOString();
    const ctx = { afterTs: Math.floor(Date.now() / 1000) - config.lookbackDays * 86400 };
    const probes = [];

    const auth = await probeAuth(ctx, onProgress);
    probes.push(auth);

    if (auth.verdict === 'fail') {
        return finish({ startedAt, ctx, probes, aborted: true });
    }

    probes.push(await probeEntitlement(ctx, onProgress));
    probes.push(await probeDms(ctx, onProgress));
    probes.push(await probeMentions(ctx, onProgress));
    probes.push(await probeIncremental(ctx, onProgress));
    probes.push(probeFields(ctx));
    if (includeRateLimit) probes.push(await probeRateLimit(ctx, onProgress));

    return finish({ startedAt, ctx, probes, aborted: false });
}

function finish({ startedAt, ctx, probes, aborted }) {
    const all = [
        ...toCockpitItems(ctx.dmMessages || [], 'dm'),
        ...toCockpitItems(ctx.mentionMessages || [], 'mention'),
    ].sort((a, b) => String(b.isoTime).localeCompare(String(a.isoTime)));
    // Slackbot notices are not follow-up items; they would be noise in the inbox.
    const items = all.filter((i) => !i.isBot);
    const botsDropped = all.length - items.length;

    const scored = probes.filter((p) => ['pass', 'partial', 'fail'].includes(p.verdict));
    const failed = scored.filter((p) => p.verdict === 'fail');
    const partial = scored.filter((p) => p.verdict === 'partial');
    // P1 and P2 are the two questions the POC exists to answer. If either was skipped
    // for lack of data, the run has no verdict to give, however green the rest looks.
    const coreSkipped = probes.filter((p) => ['P1', 'P2'].includes(p.id) && p.verdict === 'skipped');

    let conclusion;
    if (aborted) conclusion = 'blocked';
    else if (failed.length) conclusion = 'no';
    else if (coreSkipped.length) conclusion = 'inconclusive';
    else if (partial.length) conclusion = 'qualified-yes';
    else conclusion = 'yes';

    // A run on a workspace without Slack AI Search can only ever be a partial answer:
    // half the query shapes were never available to it.
    const dataCaveat = coreSkipped.length
        ? `No verdict is possible from this run: ${coreSkipped.map((p) => p.id).join(' and ')} had no data to work with. ` +
          'The workspace needs real DMs and at least one channel message containing your @mention before the two central questions can be answered.'
        : null;

    const planCaveat = ctx.aiSearchEnabled === false
        ? 'This workspace does not have Slack AI Search, so semantic and natural-language queries were unavailable and only keyword search was exercised. Treat any result below as a lower bound on what the API can do.'
        : ctx.aiSearchEnabled === null
            ? 'Slack AI Search entitlement could not be determined, so it is unclear whether the semantic query shapes were given a fair test.'
            : null;

    return {
        startedAt,
        finishedAt: new Date().toISOString(),
        conclusion,
        dataCaveat,
        planCaveat,
        botsDropped,
        aiSearchEnabled: ctx.aiSearchEnabled ?? null,
        identity: { userId: ctx.userId, userName: ctx.userName, team: ctx.team, teamId: ctx.teamId, scopes: ctx.scopes },
        lookbackDays: config.lookbackDays,
        probes,
        inboxPreview: items,
        calls: callLog,
    };
}
