const SRC = {
    mail: { label: 'Mail', link: 'Open in Gmail ↗', bg: '#e7e5fe', fg: '#5c5783', ring: '#c3bdea' },
    slack: { label: 'Slack', link: 'Open in Slack ↗', bg: '#e2e0fb', fg: '#5d5294', ring: '#b5abfc' },
    notion: { label: 'Notion', link: 'Open in Notion ↗', bg: '#e2e5ef', fg: '#595d6c', ring: '#c3c7d6' },
    whatsapp: { label: 'WhatsApp', link: 'Open in WhatsApp ↗', bg: '#e5ebe8', fg: '#4d5f57', ring: '#c2cfc9' },
    internal: { label: 'Own', link: 'Edit here', bg: 'transparent', fg: '#5d5294', ring: '#b5abfc' },
};

const DUE = {
    none: { color: 'transparent', text: 'color-mix(in srgb, var(--color-text) 52%, transparent)', edge: 'transparent', tint: 0 },
    soon: { color: '#b5abfc', text: 'color-mix(in srgb, var(--color-text) 60%, transparent)', edge: 'transparent', tint: 0 },
    due: { color: '#c98a4b', text: '#8f5b23', edge: 'color-mix(in srgb, #c98a4b 45%, transparent)', tint: 16, hue: '#e0a462' },
    over: { color: '#bf5d55', text: '#94322b', edge: 'color-mix(in srgb, #bf5d55 50%, transparent)', tint: 18, hue: '#d97a72' },
};

const WS = [
    { name: 'Work', tint: '#6f62b5', sources: 'work Gmail, company Slack, work Notion' },
    { name: 'Atlas Copco', tint: '#4c5397', sources: 'Slack Connect, project Notion, WhatsApp' },
    { name: 'Personal', tint: '#75798c', sources: 'personal Gmail, WhatsApp' },
];

const PAGES = ['Today', 'Dormant projects', 'Reading'];

const PANELS = [
    { key: 'atlas', title: 'Atlas Copco rollout', rule: 'live · #cust-atlascopco', span: 1, sources: 'Slack channel rule + mail thread' },
    { key: 'debt', title: 'Technical debt', rule: 'topic · manual', span: 1, sources: 'Own actions + Slack #eng' },
    { key: 'spec', title: 'Inbox spec v0.3', rule: 'notion page + mentions', span: 1, sources: 'Notion + own actions' },
    { key: 'hiring', title: 'Hiring — ops engineer', rule: 'label: recruitment', span: 1, sources: 'Mail label + WhatsApp' },
    { key: 'team', title: 'Team & 1:1s', rule: 'assoc: person', span: 1, sources: 'Own actions + Slack DMs' },
    { key: 'board', title: 'Board & investors', rule: 'label: board', span: 1, sources: 'Mail + Notion' },
];

const ITEMS = [
    { id: 'i1', src: 'mail', from: 'Dave Kerrigan · Atlas Copco', subject: 'Re: Part 11 compatibility of the audit trail', time: '08:12', action: "Reply to Dave's question on Part 11 compatibility", summary: 'Dave asks whether the audit-trail export satisfies 21 CFR Part 11 for their validated line. Five of six questions are answered in the validation pack; the open one is e-signature retention.', suggest: 'Atlas Copco rollout', due: 'due', dueLabel: 'Due today', status: 'inbox', unseen: false },
    { id: 'i2', src: 'slack', from: '#cust-atlascopco · Lieve Maes', subject: 'seats for the second line', time: '08:40', action: 'Answer the pricing question on 12 extra editor seats', summary: 'Lieve needs a price before their Thursday budget review. The thread already holds the current contract tier.', suggest: 'Atlas Copco rollout', due: 'soon', dueLabel: 'Thu', status: 'inbox', unseen: true },
    { id: 'i3', src: 'notion', from: 'Ilse Vermeulen', subject: 'Inbox spec v0.3 — comments', time: 'Yesterday', action: "Resolve Ilse's three comments on the item model", summary: 'All three sit in §3.2: whether a task is a status or its own object, and two naming nits.', suggest: 'Inbox spec v0.3', due: 'none', dueLabel: 'No date', status: 'inbox', unseen: false },
    { id: 'i4', src: 'mail', from: 'Recruitment agency', subject: 'Second interview — ops engineer', time: 'Mon', action: 'Confirm the second interview slots for two candidates', summary: 'The agency needs a yes/no by Friday to hold both slots.', suggest: 'Hiring — ops engineer', due: 'over', dueLabel: '2 days late', status: 'inbox', unseen: false },
    { id: 'i5', src: 'whatsapp', from: 'Bram Peeters', subject: 'quick one about the Ghent line', time: '07:20', action: 'Send Bram the Ghent line timeline he asked for', summary: 'Voice note, 40 seconds. He wants the pilot dates before he talks to his plant manager.', suggest: 'Atlas Copco rollout', due: 'soon', dueLabel: 'Tomorrow', status: 'inbox', unseen: true },
    { id: 'i6', src: 'internal', from: 'You', subject: 'own action', time: 'Mon', action: 'Write the Q3 goals for the team', summary: 'Created here — opens in the app rather than deep-linking out.', suggest: 'Team & 1:1s', due: 'soon', dueLabel: 'This week', status: 'inbox', unseen: false },

    { id: 'a1', src: 'mail', from: 'Dave Kerrigan', subject: 'Part 11 audit trail', time: 'Tue', action: "Follow up: awaiting Dave's answer on e-signature retention", due: 'soon', dueLabel: 'Fri', status: 'waiting', panel: 'atlas' },
    { id: 'a2', src: 'slack', from: '#cust-atlascopco', subject: 'seat pricing', time: 'Tue', action: 'Send the updated seat pricing sheet', due: 'due', dueLabel: 'Today', status: 'task', panel: 'atlas' },
    { id: 'a3', src: 'slack', from: '#cust-atlascopco · Wim', subject: 'line 3 downtime', time: '07:55', action: 'Check the downtime figures Wim posted', due: 'none', dueLabel: 'Auto-routed', status: 'task', panel: 'atlas', unseen: true },
    { id: 'a4', src: 'internal', from: 'You', subject: 'own action', time: '—', action: 'Draft the go-live checklist for the second line', due: 'soon', dueLabel: 'Next week', status: 'task', panel: 'atlas' },
    { id: 'a5', src: 'notion', from: 'Q3 rollout plan', subject: 'schedule', time: 'Mon', action: 'Confirm the pilot week moved from 34 to 36', due: 'none', dueLabel: 'No date', status: 'task', panel: 'atlas' },

    { id: 'd1', src: 'slack', from: '#eng · Michael', subject: 'sync queue retries', time: 'Mon', action: 'Decide the retry policy for the offline sync queue', due: 'due', dueLabel: 'Today', status: 'task', panel: 'debt' },
    { id: 'd2', src: 'internal', from: 'You', subject: 'own action', time: '—', action: 'Split the connector layer out of the Gmail poller', due: 'none', dueLabel: 'No date', status: 'task', panel: 'debt' },
    { id: 'd3', src: 'notion', from: 'Tech debt register', subject: 'token storage', time: '—', action: 'Rotate and re-encrypt stored source tokens', due: 'soon', dueLabel: 'This month', status: 'task', panel: 'debt' },
    { id: 'd4', src: 'slack', from: '#eng', subject: 'flaky tests', time: 'Fri', action: 'Quarantine the three flaky connector tests', due: 'over', dueLabel: '4 days late', status: 'task', panel: 'debt' },

    { id: 's1', src: 'internal', from: 'You', subject: 'own action', time: '—', action: 'Close open decision 1 — one-way vs two-way sync', due: 'due', dueLabel: 'Today', status: 'task', panel: 'spec' },
    { id: 's2', src: 'notion', from: 'Ilse Vermeulen', subject: 'v0.3 review', time: 'Yesterday', action: 'Rewrite §4.1 with the hybrid routing decision', due: 'soon', dueLabel: 'This week', status: 'task', panel: 'spec' },
    { id: 's3', src: 'slack', from: '#product', subject: 'swipe-right', time: 'Mon', action: 'Test swipe-right on the phone before locking it in', due: 'none', dueLabel: 'No date', status: 'task', panel: 'spec' },

    { id: 'h1', src: 'mail', from: 'Recruitment agency', subject: 'availability', time: 'Mon', action: 'Send my availability for next week', due: 'over', dueLabel: '2 days late', status: 'task', panel: 'hiring' },
    { id: 'h2', src: 'whatsapp', from: 'Sofie De Ridder', subject: 'referral', time: 'Sun', action: "Reply to Sofie's referral for the ops role", due: 'soon', dueLabel: 'Tomorrow', status: 'task', panel: 'hiring' },
    { id: 'h3', src: 'internal', from: 'You', subject: 'own action', time: '—', action: 'Write the take-home exercise brief', due: 'soon', dueLabel: 'This week', status: 'task', panel: 'hiring' },

    { id: 't1', src: 'internal', from: 'You', subject: 'own action', time: '—', action: 'Ilse — discuss rollout ownership in the next 1:1', due: 'soon', dueLabel: 'Thu 1:1', status: 'task', panel: 'team' },
    { id: 't2', src: 'slack', from: 'DM · Michael', subject: 'Linear connector', time: 'Tue', action: 'Agree the Linear connector scope with Michael', due: 'none', dueLabel: 'No date', status: 'task', panel: 'team' },
    { id: 't3', src: 'internal', from: 'You', subject: 'own action', time: '—', action: 'Give Wim feedback on the downtime report', due: 'due', dueLabel: 'Today', status: 'task', panel: 'team' },
    { id: 't4', src: 'mail', from: 'HR', subject: 'review cycle', time: 'Mon', action: 'Submit the two mid-year review forms', due: 'over', dueLabel: '1 day late', status: 'task', panel: 'team' },

    { id: 'b1', src: 'mail', from: 'Katrien (chair)', subject: 'September board pack', time: 'Fri', action: 'Send the September board pack outline', due: 'soon', dueLabel: 'Next week', status: 'task', panel: 'board' },
    { id: 'b2', src: 'notion', from: 'Board notes', subject: 'action items', time: '—', action: 'Answer the two open questions from the June minutes', due: 'none', dueLabel: 'No date', status: 'waiting', panel: 'board' },

    { id: 'r1', src: 'notion', from: 'Saved', subject: 'CRDT primer', time: '—', action: 'Read the local-first CRDT primer and note what applies', due: 'none', dueLabel: 'No date', status: 'task', panel: 'reading' },
    { id: 'r2', src: 'slack', from: '#eng · shared link', subject: 'sync patterns', time: '—', action: 'Skim the offline-sync write-up Michael shared', due: 'none', dueLabel: 'No date', status: 'task', panel: 'reading' },
    { id: 'r3', src: 'whatsapp', from: 'Bram Peeters', subject: 'article', time: '—', action: 'Read the MES integration article Bram sent', due: 'none', dueLabel: 'No date', status: 'task', panel: 'reading' },
    { id: 'o1', src: 'mail', from: 'Bram Peeters', subject: 'pilot on hold', time: '—', action: 'Revisit the Ghent pilot in September', due: 'none', dueLabel: 'Sept', status: 'snoozed', panel: 'onhold' },
    { id: 'o2', src: 'internal', from: 'You', subject: 'own action', time: '—', action: 'Reopen the WhatsApp connector spike after v1', due: 'none', dueLabel: 'Q4', status: 'snoozed', panel: 'onhold' },
];

const NOTES = [
    { tag: 'Assumption · §3.1', text: 'Workspace → Page → Panel is the whole hierarchy — no separate "views". A workspace scopes which sources are connected; its color is a line at the top edge, not a wash.' },
    { tag: 'Assumption · §5.1', text: 'Every panel is one thing: a list of actions on a topic — a project, the board, technical debt, a person. Each row is a next action with the source it came from, never a message preview.' },
    { tag: 'Sources', text: 'Actions arrive from Mail, Slack, Notion, WhatsApp, or are created here. The icon and its tint carry the source; the row carries the action.' },
    { tag: 'Assumption · §4.1', text: 'Hybrid routing: the inbox is the default, channel rules route obvious items straight into a panel with an unseen dot (see the auto-routed Atlas Copco row).' },
    { tag: 'Open · §11.3', text: 'Swipe-right is modelled as "file into a panel" with the attach-and-monitor scope prompt (thread / conversation / channel). Try it on a narrow window or your phone.' },
    { tag: 'Open · §11.10', text: 'Round-trip is prompt-on-return: opening the source raises "Handled?" → Done / Waiting / Still to do, and Waiting rewrites the next-action line.' },
    { tag: 'Open · §11.1', text: 'Read-only sync assumed — nothing here mutates Gmail, Slack or WhatsApp.' },
];

const state = {
    screen: 'dash',
    ws: 0,
    page: 0,
    sel: null,
    items: ITEMS.map((i) => ({ ...i })),
    toast: null,
    sheet: null,
    notesOpen: false,
    menu: null,
    removed: {},
    extra: [],
    draft: '',
    focus: {},
    assoc: {},
};

let toastTimer = null;
let sheetActions = [];

const app = document.getElementById('app');

function isMobile() {
    return window.innerWidth < 720;
}

function isTablet() {
    return window.innerWidth >= 720 && window.innerWidth < 1080;
}

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function muted(pct) {
    return `color-mix(in srgb, var(--color-text) ${pct}%, transparent)`;
}

function setState(patch) {
    Object.assign(state, patch);
    render();
}

function flash(t) {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setState({ toast: null }), 2200);
    setState({ toast: t });
}

function inboxItems() {
    return state.items.filter((i) => i.status === 'inbox');
}

function selected() {
    return state.items.find((i) => i.id === state.sel) || null;
}

function openItem(id) {
    const it = state.items.find((i) => i.id === id);
    setState({ sel: id, draft: it ? it.action : '' });
}

function step(d) {
    const list = inboxItems();
    if (!list.length) {
        return;
    }

    const i = list.findIndex((x) => x.id === state.sel);
    openItem(list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))].id);
}

function process(status, id) {
    const target = id || state.sel || (inboxItems()[0] || {}).id;
    if (!target) {
        return;
    }

    const labels = {
        done: 'Done — leaves the queue, stays in its panels',
        waiting: 'Waiting — next action rewritten to a follow-up',
        snoozed: 'Snoozed until Monday',
        dismissed: 'Dismissed here only (source untouched)',
        task: 'Filed as an action with a due date',
    };

    state.items = state.items.map((i) => {
        if (i.id !== target) {
            return i;
        }

        const base = i.id === state.sel && state.draft ? state.draft : i.action;
        return {
            ...i,
            status,
            panel: i.panel || (PANELS.find((p) => p.title === i.suggest) || { key: 'atlas' }).key,
            action: status === 'waiting' ? `Follow up: ${base}` : base,
        };
    });
    setState({ sel: null });
    flash(labels[status] || 'Processed');
}

function fileSheet(id) {
    const it = state.items.find((i) => i.id === id) || {};
    const options = [
        { name: 'This thread only', note: 'Just this message and its replies' },
        { name: 'This conversation / DM', note: 'The whole 1:1 or group chat' },
        { name: 'This channel — #cust-atlascopco', note: 'Becomes the panel’s live rule; future messages appear automatically' },
    ];

    sheetActions = options.map((o) => () => {
        state.sheet = null;
        process('task', id);
        flash(`Filed into “${it.suggest || 'panel'}” · scope: ${o.name}`);
    });
    setState({
        sheet: {
            title: 'File into a panel',
            body: `Attach-and-monitor scope — how much should keep flowing into ${it.suggest || 'this panel'}?`,
            options,
        },
    });
}

function returnSheet() {
    const id = state.sel;
    const options = [
        { name: 'Done', note: 'Row leaves the panel', k: 'done' },
        { name: 'Waiting on them', note: 'Stays, next action rewrites to a follow-up', k: 'waiting' },
        { name: 'Still to do', note: 'Unchanged', k: null },
    ];

    sheetActions = options.map((o) => () => {
        state.sheet = null;
        if (o.k) {
            process(o.k, id);
        } else {
            flash('Left as it was');
        }
    });
    setState({
        sheet: {
            title: 'Handled?',
            body: 'You opened the source app. What happened to this action?',
            options,
        },
    });
}

function seg(active, tint) {
    return active
        ? { bg: tint || 'color-mix(in srgb, var(--color-accent) 14%, transparent)', fg: 'var(--color-accent-300)', border: 'var(--color-accent)' }
        : { bg: 'transparent', fg: muted(66), border: 'var(--color-divider)' };
}

function inboxDef() {
    return { key: 'inbox', title: 'Inbox', rule: 'status: to process', span: 1, sources: 'Mail · Slack · Notion · WhatsApp · own' };
}

function panelDefs() {
    const page = PAGES[state.page];
    if (page === 'Reading') {
        return [{ key: 'reading', title: 'Reading list', rule: 'topic · saved links', span: 2, sources: 'Notion · Slack · WhatsApp' }];
    }

    if (page === 'Dormant projects') {
        return [{ key: 'onhold', title: 'On hold', rule: 'status: snoozed', span: 2, sources: 'Mail · own actions' }];
    }

    return PANELS.concat(state.extra);
}

function cardData(i) {
    const src = SRC[i.src];
    const due = DUE[i.due];
    const selectedRow = state.sel === i.id;
    const tintBg = (ground) => (due.tint ? `color-mix(in srgb, ${due.hue} ${due.tint}%, ${ground})` : ground);

    return {
        ...i,
        srcLabel: src.label,
        deepLink: src.link,
        srcBg: src.bg,
        srcFg: src.fg,
        srcRing: src.ring,
        dueColor: due.color,
        dueText: due.text,
        edge: due.edge,
        waiting: i.status === 'waiting',
        bg: selectedRow ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-bg))' : tintBg('var(--color-bg)'),
        rowBg: selectedRow ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-surface))' : tintBg('var(--color-surface)'),
        rowEdge: selectedRow ? 'var(--color-accent)' : due.edge,
        suggestPanel: i.suggest || '',
        showSuggest: !!i.suggest && !isMobile() && !isTablet(),
    };
}

function mkPanel(p) {
    const cards = (p.key === 'inbox'
        ? inboxItems()
        : state.items.filter((i) => i.panel === p.key && i.status !== 'done' && i.status !== 'dismissed' && i.status !== 'inbox')
    ).map(cardData);

    return {
        ...p,
        count: cards.length,
        cards,
        flex: p.key === 'inbox' ? '1 1 auto' : '0 0 auto',
        minH: p.key === 'inbox' ? '0' : 'auto',
        overflow: p.key === 'inbox' ? 'auto' : 'visible',
        isEmpty: cards.length === 0,
        span: isMobile() ? 1 : Math.min(p.span, isTablet() ? 2 : 3),
        edge: p.key === 'inbox' ? 'color-mix(in srgb, var(--color-accent) 45%, transparent)' : 'transparent',
        menuOpen: state.menu === p.key,
    };
}

function srcPillHtml(c, fontSize) {
    return `<span style="flex:none;font:600 ${fontSize} var(--font-heading);letter-spacing:0.05em;text-transform:uppercase;padding:3px 7px;border-radius:5px;background:${c.srcBg};color:${c.srcFg};box-shadow:inset 0 0 0 1px ${c.srcRing}">${esc(c.srcLabel)}</span>`;
}

function headerHtml() {
    const ws = WS[state.ws];
    const panels = panelDefs().filter((p) => !state.removed[p.key]);
    const wsArea = isMobile()
        ? `<div style="display:flex;align-items:center;gap:8px">
            <span style="width:7px;height:7px;border-radius:50%;background:${ws.tint}"></span>
            <span style="font-family:var(--font-heading);font-weight:500;font-size:14px">${esc(ws.name)}</span>
            <button class="btn btn-ghost" data-act="ws:next" style="font-size:11.5px">Switch</button>
        </div>`
        : `<div style="display:flex;gap:4px">${WS.map((w, n) => {
            const st = seg(n === state.ws, `color-mix(in srgb, ${w.tint} 14%, transparent)`);
            return `<button data-act="ws:pick" data-i="${n}" style="display:flex;align-items:center;gap:7px;padding:5px 12px;border-radius:99px;cursor:pointer;font:500 12.5px var(--font-heading);border:1px solid ${st.border};background:${st.bg};color:${st.fg}"><span style="width:7px;height:7px;border-radius:50%;background:${w.tint}"></span>${esc(w.name)}</button>`;
        }).join('')}</div>`;

    const pageButtons = PAGES.map((p, n) => {
        const st = seg(n === state.page);
        const count = n === state.page ? panels.length : (n === 0 ? PANELS.length : 1);
        return `<button data-act="page:pick" data-i="${n}" style="padding:5px 11px;border-radius:var(--radius-md);cursor:pointer;font:500 12.5px var(--font-heading);border:1px solid ${st.border};background:${st.bg};color:${st.fg}">${esc(p)}<span style="opacity:.5;margin-left:6px;font-size:11px">${count}</span></button>`;
    }).join('');

    return `
    <div style="flex:none;padding:${isMobile() ? '12px 14px' : '12px 16px'};background:var(--color-surface);box-shadow:inset 0 2px 0 ${ws.tint};border-bottom:1px solid var(--color-divider)">
        <div style="display:flex;align-items:center;gap:10px">
            ${wsArea}
            <div style="flex:1"></div>
            <span style="font-size:11.5px;color:${muted(62)}">Synced 2 min ago · 3 queued offline</span>
            <button class="btn btn-secondary" data-act="triage:go" style="font-size:12px">Triage<span style="margin-left:6px;color:var(--color-accent)">${inboxItems().length}</span></button>
            ${isMobile() ? '' : '<button class="btn btn-secondary" data-act="notes:toggle" style="font-size:12px">Design notes</button>'}
        </div>
        <div style="display:flex;align-items:center;gap:5px;margin-top:10px;flex-wrap:wrap">
            ${pageButtons}
            <button class="btn btn-ghost" data-act="noop" style="font-size:12px">+ Page</button>
        </div>
    </div>`;
}

function triageRowHtml(c) {
    return `
    <div data-act="item:open" data-id="${c.id}" style="display:flex;gap:11px;align-items:flex-start;padding:10px 12px;border-radius:var(--radius-md);cursor:pointer;background:${c.rowBg};box-shadow:inset 0 0 0 1px ${c.rowEdge};border-left:4px solid ${c.dueColor}">
        ${srcPillHtml(c, '10px')}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
            <div style="display:flex;align-items:baseline;gap:7px;min-width:0">
                <span style="font-family:var(--font-heading);font-weight:500;font-size:14px;line-height:1.35;text-wrap:pretty">${esc(c.action)}</span>
                ${c.unseen ? '<span style="width:6px;height:6px;border-radius:50%;flex:none;background:var(--color-accent)"></span>' : ''}
            </div>
            <span style="font-size:11.5px;color:${muted(58)};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.from)} · ${esc(c.subject)}</span>
        </div>
        ${c.showSuggest ? `
        <div style="display:flex;align-items:center;gap:6px;flex:none">
            <span class="tag tag-outline">${esc(c.suggestPanel)}</span>
            <button class="btn btn-ghost" data-act="item:accept" data-id="${c.id}" style="font-size:11.5px">Accept</button>
        </div>` : ''}
        <span style="flex:none;font-size:11px;min-width:62px;padding-top:2px;text-align:right;color:${c.dueText}">${esc(c.dueLabel)}</span>
        <div style="display:flex;align-items:center;gap:6px;flex:none">
            <button class="btn btn-secondary" data-act="item:file" data-id="${c.id}" style="font-size:11.5px;padding:4px 9px">File…</button>
            <button class="btn btn-secondary" data-act="item:done" data-id="${c.id}" style="font-size:11.5px;padding:4px 9px">Done</button>
            <button class="btn btn-secondary" data-act="item:dismiss" data-id="${c.id}" style="font-size:11.5px;padding:4px 9px">✕</button>
        </div>
    </div>`;
}

function triageHtml() {
    const inbox = inboxItems().map(cardData);
    return `
    <div style="flex:1;min-height:0;overflow:auto;padding:${isMobile() ? '12px' : '16px'};display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:baseline;gap:12px">
            <h4>To Process</h4>
            <span class="tag tag-neutral">${inbox.length} items</span>
            <div style="flex:1"></div>
            <span style="font-size:11px;color:${muted(55)}">j/k move · e done · w waiting · s snooze</span>
        </div>
        ${inbox.map(triageRowHtml).join('')}
        ${inbox.length === 0 ? `<div style="padding:34px;text-align:center;border-radius:var(--radius-md);background:var(--color-surface);color:${muted(58)};font-size:13px">Queue clear. Processed items stay in the panels they were filed into.</div>` : ''}
    </div>`;
}

function swipeHtml() {
    const inbox = inboxItems();
    const stack = inbox.slice(0, 3).map(cardData);
    const cards = stack.map((c, n) => {
        const active = n === 0;
        return `
        <div ${active ? 'data-swipe-card' : ''} style="position:absolute;left:${n * 7}px;right:${n * 7}px;top:${n * 10}px;bottom:${12 - n * 10}px;overflow:hidden;padding:15px;border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-md),inset 0 0 0 1px ${c.edge};z-index:${10 - n};display:flex;flex-direction:column;gap:9px;border-left:4px solid ${c.dueColor}">
            <div style="display:flex;align-items:center;gap:8px">
                ${srcPillHtml(c, '10px')}
                <span style="flex:1;min-width:0;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${muted(62)}">${esc(c.from)}</span>
                <span style="flex:none;font-size:11px;color:${c.dueText}">${esc(c.dueLabel)}</span>
            </div>
            <span style="font-family:var(--font-heading);font-weight:500;font-size:18px;line-height:1.25">${esc(c.action)}</span>
            <span style="flex:1;min-height:0;overflow:hidden;font-size:12.5px;line-height:1.5;color:${muted(62)}">${esc(c.summary || '')}</span>
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                ${c.suggestPanel ? `<span class="tag tag-outline">${esc(c.suggestPanel)}</span>` : ''}
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:${muted(45)}">
                <span data-swipe-hint-left style="color:${muted(45)}">◀ dismiss</span>
                <button class="btn btn-ghost" data-act="item:open" data-id="${c.id}" style="font-size:11.5px">Open</button>
                <span data-swipe-hint-right style="color:${muted(45)}">file ▶</span>
            </div>
            ${active ? `<div data-swipe-layer data-id="${c.id}" style="position:absolute;inset:0;border-radius:var(--radius-lg);cursor:grab;touch-action:pan-y"></div>` : ''}
        </div>`;
    }).join('');

    return `
    <div style="flex:1;min-height:0;display:flex;flex-direction:column;padding:14px;gap:12px;overflow:auto">
        <div style="display:flex;align-items:center;gap:10px;flex:none">
            <h5>To Process</h5>
            <span class="tag tag-neutral">${inbox.length}</span>
        </div>
        <div style="flex:1;min-height:300px;position:relative;z-index:0">
            ${cards}
            ${inbox.length === 0 ? `<div style="padding:34px;text-align:center;border-radius:var(--radius-md);background:var(--color-surface);color:${muted(58)};font-size:13px">Queue clear. Processed items stay in the panels they were filed into.</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;position:relative;z-index:2;flex:none">
            <button class="btn btn-secondary" data-act="swipe:dismiss" style="flex:1">Dismiss</button>
            <button class="btn btn-secondary" data-act="swipe:snooze" style="flex:1">Snooze</button>
            <button class="btn btn-primary" data-act="swipe:file" style="flex:1">File…</button>
        </div>
    </div>`;
}

function panelCardHtml(c) {
    return `
    <div data-act="item:open" data-id="${c.id}" style="display:flex;gap:9px;align-items:flex-start;padding:8px 9px;border-radius:var(--radius-sm);cursor:pointer;background:${c.bg};box-shadow:inset 0 0 0 1px ${c.edge};border-left:4px solid ${c.dueColor}">
        ${srcPillHtml(c, '9px')}
        <span style="flex:1;min-width:0;font-size:12.5px;line-height:1.35;text-wrap:pretty">${esc(c.action)}</span>
        ${c.waiting ? '<span class="tag tag-accent" style="flex:none;font-size:9.5px;padding:1px 6px">Waiting</span>' : ''}
        ${c.unseen ? '<span style="width:6px;height:6px;flex:none;border-radius:50%;background:var(--color-accent)"></span>' : ''}
        <span style="flex:none;font-size:10.5px;padding-top:1px;color:${c.dueText}">${esc(c.dueLabel)}</span>
    </div>`;
}

function panelHtml(pn) {
    return `
    <div style="grid-column:span ${pn.span};flex:${pn.flex};min-height:${pn.minH};overflow:${pn.overflow};display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:var(--radius-md);background:var(--color-surface);box-shadow:inset 0 0 0 1px ${pn.edge},var(--shadow-sm)">
        <div style="display:flex;align-items:center;gap:8px">
            <span style="font-family:var(--font-heading);font-weight:500;font-size:13.5px">${esc(pn.title)}</span>
            <span style="font-size:10.5px;padding:2px 7px;border-radius:5px;background:var(--color-neutral-800);color:var(--color-neutral-200)">${pn.count}</span>
            <div style="flex:1"></div>
            <span style="font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${muted(45)}">${esc(pn.rule)}</span>
            <button class="btn btn-ghost" data-act="panel:menu" data-key="${pn.key}" style="font-size:14px;padding:0 4px">···</button>
        </div>
        ${pn.menuOpen ? `
        <div style="display:flex;gap:6px;padding:8px;border-radius:var(--radius-sm);background:var(--color-bg)">
            <button class="btn btn-secondary" data-act="panel:configure" data-key="${pn.key}" style="font-size:11.5px;padding:4px 9px">Configure rule</button>
            <button class="btn btn-secondary" data-act="panel:group" data-key="${pn.key}" style="font-size:11.5px;padding:4px 9px">Group by…</button>
            <button class="btn btn-secondary" data-act="panel:remove" data-key="${pn.key}" style="font-size:11.5px;padding:4px 9px">Remove</button>
        </div>` : ''}
        ${pn.cards.map(panelCardHtml).join('')}
        ${pn.isEmpty ? `<div style="padding:14px;text-align:center;font-size:12px;border-radius:var(--radius-sm);background:var(--color-bg);color:${muted(50)}">Nothing matches this panel's rule yet</div>` : ''}
        <div style="display:flex;align-items:center;gap:8px">
            <button class="btn btn-ghost" data-act="panel:addaction" data-key="${pn.key}" style="font-size:11.5px">+ Action</button>
            <span style="font-size:10.5px;color:${muted(40)}">${esc(pn.sources)}</span>
        </div>
    </div>`;
}

function dashHtml() {
    const mobile = isMobile();
    const panels = panelDefs().filter((p) => !state.removed[p.key]).map(mkPanel);
    const inboxPanel = mkPanel(inboxDef());
    const gridCols = mobile ? '1fr' : (isTablet() ? 'repeat(auto-fill, minmax(260px,1fr))' : 'repeat(auto-fill, minmax(290px,1fr))');

    return `
    <div style="flex:1;min-height:0;padding:${mobile ? '12px' : '16px'};display:flex;flex-direction:column;gap:12px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:10px;flex:none">
            <h4>${esc(PAGES[state.page])}</h4>
            <span style="font-size:11.5px;color:${muted(58)}">${panels.length + 1} panels · drag to move, corner to resize</span>
            <div style="flex:1"></div>
            <button class="btn btn-secondary" data-act="noop" style="font-size:12px">Arrange</button>
            <button class="btn btn-primary" data-act="dash:addpanel" style="font-size:12px">+ Panel</button>
        </div>
        <div style="flex:1;min-height:0;display:flex;flex-direction:${mobile ? 'column' : 'row'};gap:12px;align-items:stretch;overflow:${mobile ? 'auto' : 'hidden'}">
            <div style="flex:none;width:${mobile ? '100%' : (isTablet() ? '300px' : '350px')};min-height:0;display:flex;flex-direction:column;overflow:${mobile ? 'visible' : 'auto'}">
                ${panelHtml(inboxPanel)}
            </div>
            <div style="flex:1;min-width:0;min-height:0;overflow:${mobile ? 'visible' : 'auto'};display:grid;grid-template-columns:${gridCols};gap:12px;align-content:start;align-items:start">
                ${panels.map(panelHtml).join('')}
            </div>
        </div>
    </div>`;
}

function bottomTabsHtml() {
    const isDash = state.screen === 'dash';
    return `
    <div style="flex:none;display:flex;border-top:1px solid var(--color-divider);background:var(--color-surface)">
        ${[['inbox', 'Triage'], ['dash', 'Pages']].map(([k, n]) => {
            const a = (k === 'dash') === isDash;
            return `<button data-act="tab:pick" data-k="${k}" style="flex:1;padding:11px 0 13px;border:0;cursor:pointer;background:transparent;color:${a ? 'var(--color-accent)' : muted(55)};font:500 11.5px var(--font-heading);display:flex;flex-direction:column;align-items:center;gap:4px">
                <span style="width:16px;height:2px;border-radius:2px;background:${a ? 'var(--color-accent)' : 'transparent'}"></span>${n}
            </button>`;
        }).join('')}
    </div>`;
}

function detailHtml() {
    const sel = selected();
    if (!sel) {
        return '';
    }

    const c = cardData(sel);
    const mobile = isMobile();

    const assocChips = PANELS.filter((p) => p.key !== 'inbox').concat([{ key: 'new', title: '+ New panel' }]).map((p) => {
        const on = !!state.assoc[sel.id + p.key] || sel.suggest === p.title || sel.panel === p.key;
        return `<button data-act="assoc:toggle" data-key="${p.key}" style="cursor:pointer;font:400 11px var(--font-body);padding:4px 10px;border-radius:6px;background:${on ? 'color-mix(in srgb, var(--color-accent) 14%, transparent)' : 'transparent'};color:${on ? 'var(--color-accent-300)' : muted(66)};border:1px solid ${on ? 'var(--color-accent)' : 'var(--color-divider)'}">${esc(p.title)}</button>`;
    }).join('');

    const horizonChips = ['Today', 'This Week', 'This Month', 'This Quarter'].map((h) => {
        const st = seg(state.focus[sel.id] === h);
        return `<button data-act="focus:pick" data-h="${esc(h)}" style="cursor:pointer;font:500 12px var(--font-heading);padding:5px 11px;border-radius:var(--radius-md);background:${st.bg};color:${st.fg};border:1px solid ${st.border}">${esc(h)}</button>`;
    }).join('');

    const statusButtons = [['done', 'Done', 'E'], ['waiting', 'Waiting on someone', 'W'], ['snoozed', 'Snooze until…', 'S'], ['task', 'Keep as action', 'T']].map(([k, n, key]) =>
        `<button class="btn btn-secondary" data-act="status:pick" data-k="${k}" style="font-size:12px;justify-content:flex-start">${n}<span style="margin-left:auto;opacity:.45;font-size:10.5px">${key}</span></button>`
    ).join('');

    return `
    <div data-act="detail:close" style="position:fixed;inset:0;z-index:8;display:flex;align-items:${mobile ? 'flex-end' : 'center'};justify-content:center;padding:${mobile ? '0' : '24px'};background:var(--scrim)">
        <div data-act="stop" style="width:${mobile ? '100%' : '520px'};max-width:100%;height:${mobile ? '88%' : 'min(100%, 660px)'};display:flex;flex-direction:column;background:var(--color-surface);box-shadow:var(--shadow-lg);border-radius:${mobile ? 'var(--radius-lg) var(--radius-lg) 0 0' : 'var(--radius-lg)'};overflow:auto;animation:riseIn .18s ease-out">
            <div style="display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--color-divider)">
                ${srcPillHtml(c, '11px')}
                <span style="font-size:12px;color:${muted(55)}">${esc(c.time)}</span>
                <div style="flex:1"></div>
                <button class="btn btn-primary" data-act="detail:opensource" style="font-size:12px">${esc(c.deepLink)}</button>
                <button class="btn btn-secondary" data-act="detail:close" style="font-size:12px;padding:4px 9px">✕</button>
            </div>
            <div style="padding:14px;display:flex;flex-direction:column;gap:14px">
                <div style="display:flex;flex-direction:column;gap:5px">
                    <span style="font-size:11.5px;color:${muted(58)}">${esc(c.from)}</span>
                    <span style="font-family:var(--font-heading);font-weight:500;font-size:18px;line-height:1.25">${esc(c.subject)}</span>
                </div>
                <div style="padding:11px 12px;border-radius:var(--radius-md);background:var(--color-bg);border-left:2px solid var(--color-accent);display:flex;flex-direction:column;gap:5px">
                    <span style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--color-accent-300)">Executive summary</span>
                    <span style="font-size:12.5px;line-height:1.55">${esc(c.summary || '—')}</span>
                </div>
                <div class="field">
                    <label>Next action — AI drafted, always editable</label>
                    <input class="input" id="action-draft" value="${esc(state.draft)}">
                </div>
                <div style="display:flex;flex-direction:column;gap:7px">
                    <span style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${muted(50)}">Panels this action belongs to</span>
                    <div style="display:flex;flex-wrap:wrap;gap:6px">${assocChips}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:7px">
                    <span style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${muted(50)}">Focus horizon</span>
                    <div style="display:flex;gap:6px;flex-wrap:wrap">${horizonChips}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:7px">
                    <span style="font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:${muted(50)}">Status</span>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">${statusButtons}</div>
                </div>
                <span style="font-size:11px;line-height:1.5;color:${muted(50)}">Read-only sync in v1 — status changes stay in this app. Opening the source prompts on return.</span>
            </div>
        </div>
    </div>`;
}

function sheetHtml() {
    if (!state.sheet) {
        return '';
    }

    const options = state.sheet.options.map((o, i) => `
        <button data-act="sheet:pick" data-i="${i}" style="display:flex;flex-direction:column;gap:2px;text-align:left;cursor:pointer;padding:9px 11px;border-radius:var(--radius-md);background:var(--color-bg);border:1px solid var(--color-divider);color:var(--color-text)">
            <span style="font:500 13px var(--font-heading)">${esc(o.name)}</span>
            <span style="font-size:11px;color:${muted(55)}">${esc(o.note)}</span>
        </button>`).join('');

    return `
    <div style="position:fixed;inset:0;z-index:9;display:flex;align-items:${isMobile() ? 'flex-end' : 'center'};justify-content:center;padding:16px;background:var(--scrim)">
        <div style="width:min(420px,100%);display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-lg);animation:riseIn .16s ease-out">
            <span style="font-family:var(--font-heading);font-weight:500;font-size:16px">${esc(state.sheet.title)}</span>
            <span style="font-size:12.5px;line-height:1.5;color:${muted(62)}">${esc(state.sheet.body)}</span>
            <div style="display:flex;flex-direction:column;gap:6px;margin-top:2px">${options}</div>
            <button class="btn btn-secondary" data-act="sheet:close" style="align-self:flex-end;font-size:12px">Cancel</button>
        </div>
    </div>`;
}

function notesHtml() {
    if (!state.notesOpen) {
        return '';
    }

    return `
    <div style="position:fixed;top:60px;right:14px;bottom:14px;z-index:7;width:300px;padding:14px;border-radius:var(--radius-md);background:var(--color-surface);box-shadow:var(--shadow-lg);overflow:auto;display:flex;flex-direction:column;gap:12px;animation:riseIn .16s ease-out">
        <div style="display:flex;align-items:center">
            <span style="font-family:var(--font-heading);font-weight:500;font-size:14px">Design notes</span>
            <div style="flex:1"></div>
            <button class="btn btn-secondary" data-act="notes:toggle" style="font-size:12px;padding:4px 9px">✕</button>
        </div>
        ${NOTES.map((n) => `
        <div style="display:flex;flex-direction:column;gap:3px">
            <span style="font-size:10px;letter-spacing:0.09em;text-transform:uppercase;color:var(--color-accent-300)">${esc(n.tag)}</span>
            <span style="font-size:12px;line-height:1.5;color:${muted(78)}">${esc(n.text)}</span>
        </div>`).join('')}
    </div>`;
}

function toastHtml() {
    if (!state.toast) {
        return '';
    }

    return `<div style="position:fixed;left:50%;bottom:${isMobile() ? '64px' : '18px'};transform:translateX(-50%);z-index:12;padding:8px 14px;border-radius:99px;background:var(--color-surface);box-shadow:var(--shadow-md);font-size:12.5px;animation:riseIn .16s ease-out">${esc(state.toast)}</div>`;
}

function render() {
    const mobile = isMobile();
    const isDash = state.screen === 'dash';
    let body;
    if (isDash) {
        body = dashHtml();
    } else {
        body = mobile ? swipeHtml() : triageHtml();
    }

    app.innerHTML = `
    <div style="height:100%;display:flex;flex-direction:column;background:var(--color-bg)">
        ${headerHtml()}
        <div style="flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden">${body}</div>
        ${mobile ? bottomTabsHtml() : ''}
    </div>
    ${detailHtml()}
    ${sheetHtml()}
    ${notesHtml()}
    ${toastHtml()}`;

    bindDraftInput();
    bindSwipe();
}

function bindDraftInput() {
    const input = document.getElementById('action-draft');
    if (!input) {
        return;
    }

    input.addEventListener('input', (e) => {
        state.draft = e.target.value;
    });
}

function bindSwipe() {
    const layer = document.querySelector('[data-swipe-layer]');
    if (!layer) {
        return;
    }

    const cardEl = document.querySelector('[data-swipe-card]');
    const hintLeft = cardEl.querySelector('[data-swipe-hint-left]');
    const hintRight = cardEl.querySelector('[data-swipe-hint-right]');
    const id = layer.dataset.id;
    let x0 = 0;
    let drag = 0;
    let dragging = false;

    layer.addEventListener('pointerdown', (e) => {
        x0 = e.clientX;
        dragging = true;
        layer.setPointerCapture(e.pointerId);
    });

    layer.addEventListener('pointermove', (e) => {
        if (!dragging) {
            return;
        }

        drag = e.clientX - x0;
        cardEl.style.transform = `translateX(${drag}px) rotate(${drag / 26}deg)`;
        hintLeft.style.color = drag < -40 ? '#94322b' : muted(45);
        hintRight.style.color = drag > 40 ? 'var(--color-accent)' : muted(45);
    });

    layer.addEventListener('pointerup', () => {
        dragging = false;
        if (drag < -70) {
            process('dismissed', id);
        } else if (drag > 70) {
            cardEl.style.transform = '';
            fileSheet(id);
        } else if (Math.abs(drag) < 6) {
            // The drag layer sits above the whole card, so a plain tap opens the item.
            openItem(id);
        } else {
            cardEl.style.transform = '';
            hintLeft.style.color = muted(45);
            hintRight.style.color = muted(45);
        }

        drag = 0;
    });
}

app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) {
        return;
    }

    const act = el.dataset.act;
    const id = el.dataset.id;
    const key = el.dataset.key;
    const defs = [inboxDef()].concat(panelDefs(), state.extra);
    const def = defs.find((p) => p.key === key);

    switch (act) {
        case 'stop':
            break;
        case 'noop':
            flash('Not wired in this prototype');
            break;
        case 'ws:pick':
            setState({ ws: Number(el.dataset.i), sel: null });
            break;
        case 'ws:next':
            setState({ ws: (state.ws + 1) % WS.length, sel: null });
            break;
        case 'page:pick':
            setState({ page: Number(el.dataset.i), screen: 'dash', menu: null });
            break;
        case 'triage:go':
            setState({ screen: 'inbox', sel: null });
            break;
        case 'tab:pick':
            setState({ screen: el.dataset.k, sel: null });
            break;
        case 'item:open':
            openItem(id);
            break;
        case 'item:accept': {
            const it = state.items.find((i) => i.id === id) || {};
            process('task', id);
            flash(`Filed into “${it.suggest}”`);
            break;
        }
        case 'item:file':
            fileSheet(id);
            break;
        case 'item:done':
            process('done', id);
            break;
        case 'item:dismiss':
            process('dismissed', id);
            break;
        case 'panel:menu':
            setState({ menu: state.menu === key ? null : key });
            break;
        case 'panel:configure':
            flash(`Panel rule: ${def ? def.rule : ''}`);
            break;
        case 'panel:group':
            flash('Grouped by source');
            break;
        case 'panel:remove':
            setState({ menu: null, removed: { ...state.removed, [key]: true } });
            break;
        case 'panel:addaction':
            flash(`New action added to ${def ? def.title : 'panel'}`);
            break;
        case 'dash:addpanel':
            setState({ extra: state.extra.concat([{ key: `new${state.extra.length}`, title: 'New panel', rule: 'no rule yet', span: 1, sources: 'pick sources' }]) });
            break;
        case 'notes:toggle':
            setState({ notesOpen: !state.notesOpen });
            break;
        case 'detail:close':
            setState({ sel: null });
            break;
        case 'detail:opensource':
            returnSheet();
            break;
        case 'assoc:toggle': {
            const sel = selected();
            if (sel) {
                const p = PANELS.concat([{ key: 'new', title: '+ New panel' }]).find((x) => x.key === key);
                const on = !!state.assoc[sel.id + key] || sel.suggest === (p && p.title) || sel.panel === key;
                setState({ assoc: { ...state.assoc, [sel.id + key]: !on } });
            }
            break;
        }
        case 'focus:pick': {
            const sel = selected();
            if (sel) {
                setState({ focus: { ...state.focus, [sel.id]: el.dataset.h } });
            }
            break;
        }
        case 'status:pick':
            process(el.dataset.k);
            break;
        case 'sheet:pick': {
            const pick = sheetActions[Number(el.dataset.i)];
            if (pick) {
                pick();
            }
            break;
        }
        case 'sheet:close':
            setState({ sheet: null });
            break;
        case 'swipe:dismiss':
            process('dismissed', (inboxItems()[0] || {}).id);
            break;
        case 'swipe:snooze':
            process('snoozed', (inboxItems()[0] || {}).id);
            break;
        case 'swipe:file': {
            const first = inboxItems()[0];
            if (first) {
                fileSheet(first.id);
            }
            break;
        }
    }
});

window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') {
        return;
    }

    const k = e.key.toLowerCase();
    if (k === 'e') {
        process('done');
    } else if (k === 'w') {
        process('waiting');
    } else if (k === 's') {
        process('snoozed');
    } else if (k === 'j' || k === 'k') {
        step(k === 'j' ? 1 : -1);
    } else if (k === 'escape' && (state.sel || state.sheet)) {
        setState(state.sheet ? { sheet: null } : { sel: null });
    }
});

let lastBucket = null;

function bucket() {
    return isMobile() ? 'mobile' : (isTablet() ? 'tablet' : 'desktop');
}

window.addEventListener('resize', () => {
    const b = bucket();
    if (b !== lastBucket) {
        lastBucket = b;
        render();
    }
});

lastBucket = bucket();
render();
