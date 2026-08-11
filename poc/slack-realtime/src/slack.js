// Thin Slack Web API client. Records every call so the probe report can show
// exactly what was sent, what came back, how long it took, and which rate-limit
// headers Slack attached.
import { config } from './config.js';

const BASE = 'https://slack.com/api';

// Headers worth keeping: rate limiting is one of the open questions this POC exists to answer.
const INTERESTING_HEADERS = ['retry-after', 'x-rate-limit-reason', 'x-oauth-scopes', 'x-slack-req-id'];

export const callLog = [];

export function resetCallLog() {
    callLog.length = 0;
}

export async function slackCall(method, body = {}, { token = config.token } = {}) {
    const startedAt = Date.now();
    let res;
    let json;
    let transportError = null;

    try {
        res = await fetch(`${BASE}/${method}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json; charset=utf-8',
            },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        try {
            json = JSON.parse(text);
        } catch {
            json = { ok: false, error: 'non_json_response', raw: text.slice(0, 2000) };
        }
    } catch (err) {
        transportError = err.message;
        json = { ok: false, error: 'transport_error', detail: err.message };
    }

    const headers = {};
    if (res) {
        for (const name of INTERESTING_HEADERS) {
            const value = res.headers.get(name);
            if (value !== null) headers[name] = value;
        }
    }

    const entry = {
        method,
        request: redactRequest(body),
        status: res ? res.status : 0,
        ok: Boolean(json?.ok),
        error: json?.ok ? null : (json?.error ?? transportError ?? 'unknown_error'),
        needed: json?.needed ?? null,
        provided: json?.provided ?? null,
        headers,
        ms: Date.now() - startedAt,
    };
    callLog.push(entry);

    return { json, call: entry };
}

function redactRequest(body) {
    const copy = { ...body };
    if (copy.token) copy.token = '<redacted>';
    return copy;
}

/**
 * assistant.search.context — the Real-time Search API method.
 * User tokens do not need an action_token; bot tokens do.
 */
export function searchContext(args) {
    return slackCall('assistant.search.context', args);
}

export function authTest() {
    return slackCall('auth.test', {});
}

/**
 * assistant.search.info — reports whether this workspace's plan includes Slack AI
 * Search. Semantic search only works when is_ai_search_enabled is true, which
 * separates "the API cannot do this" from "this plan cannot do this".
 */
export function searchInfo() {
    return slackCall('assistant.search.info', {});
}

/** Slack message ts ("1781275070.921579") -> Date */
export function tsToDate(ts) {
    if (!ts) return null;
    return new Date(Math.floor(Number(String(ts).split('.')[0])) * 1000);
}

/** Permalink ".../p1781275070921579" -> "1781275070.921579" */
export function permalinkToTs(permalink) {
    const m = /\/p(\d{10})(\d{6})/.exec(permalink || '');
    return m ? `${m[1]}.${m[2]}` : null;
}
