const $ = (id) => document.getElementById(id);

const CONCLUSION_TEXT = {
    yes: 'Yes — the public Notion API can give Cockpit all four signals.',
    'qualified-yes': 'Qualified yes — every signal is obtainable, but at least one needs a workaround.',
    no: 'No — a capability the design depends on did not work.',
    inconclusive: 'Inconclusive — the workspace had no data for one of the four signals.',
    blocked: 'Blocked — could not authenticate, so nothing was tested.',
};

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

async function loadStatus() {
    const status = await (await fetch('/api/status')).json();
    if (status.configured) return;

    $('setup').classList.remove('hidden');
    $('setup-msg').textContent = status.tokenKind === 'missing'
        ? 'No Notion integration token is configured, so there is nothing to probe yet.'
        : status.tokenKind === 'unknown'
            ? 'NOTION_TOKEN does not look like an integration secret. Take it from the integration\'s Configuration tab, not the OAuth section.'
            : 'A token is set, but neither NOTION_PERSON_EMAIL nor NOTION_PERSON_USER_ID is. Three of the four signals are defined as "involving me", so the harness needs to know which user id that is — and it is not the token\'s bot id.';
    $('run').disabled = true;
}

function renderVerdict(report) {
    $('verdict').classList.remove('hidden');
    const badge = $('verdict-badge');
    badge.className = `badge ${report.conclusion}`;
    badge.textContent = report.conclusion.replace('-', ' ');
    $('verdict-text').textContent = CONCLUSION_TEXT[report.conclusion] || report.conclusion;

    const id = report.identity || {};
    const parts = [];
    if (id.personName || id.personUserId) parts.push(`${id.personName || 'you'} (${id.personUserId})`);
    if (id.workspace) parts.push(`workspace ${id.workspace}`);
    if (report.reach) parts.push(`${report.reach.pages} page(s), ${report.reach.dataSources} data source(s) reachable`);
    parts.push(`plan declared "${report.plan}"`);
    parts.push(`API ${report.apiVersion}`);
    parts.push(`${report.calls.length} API calls`);
    $('verdict-identity').textContent = parts.join(' · ');

    const caveat = $('verdict-data-caveat');
    caveat.classList.toggle('hidden', !report.dataCaveat);
    caveat.textContent = report.dataCaveat || '';
}

function renderSignals(report) {
    $('signals').classList.remove('hidden');
    const host = $('signal-rows');
    host.replaceChildren();
    for (const signal of report.signals) {
        const row = el('div', 'signal');
        row.append(el('span', `badge ${signal.verdict}`, signal.verdict));
        const body = el('div');
        body.append(el('div', 'q', signal.question));
        body.append(el('p', 'detail', signal.headline));
        row.append(body);
        host.append(row);
    }
}

function renderProbes(report) {
    const host = $('probes');
    host.replaceChildren();
    for (const probe of report.probes) {
        const card = el('section', 'card');
        const grid = el('div', 'probe');
        grid.append(el('span', `badge ${probe.verdict}`, probe.verdict));

        const body = el('div');
        body.append(el('div', 'q', `${probe.id} · ${probe.question}`));
        body.append(el('p', 'headline', probe.headline));
        // Some details are multi-paragraph, so keep the breaks the probe wrote.
        for (const para of probe.detail.split('\n\n')) {
            if (para.trim()) body.append(el('p', 'detail', para.replace(/\n/g, ' ')));
        }

        if (probe.evidence && Object.keys(probe.evidence).length) {
            const details = el('details');
            details.append(el('summary', null, 'Evidence'));
            details.append(el('pre', null, JSON.stringify(probe.evidence, null, 2)));
            body.append(details);
        }
        grid.append(body);
        card.append(grid);
        host.append(card);
    }
}

function renderPreview(report) {
    $('preview').classList.remove('hidden');
    const rows = $('rows');
    rows.replaceChildren();

    if (!report.inboxPreview.length) {
        rows.append(el('p', 'empty', 'Nothing came back, so the inbox would be empty.'));
        return;
    }

    for (const item of report.inboxPreview) {
        const row = el('div', 'row');
        row.append(el('span', `tag tag-${item.origin}`, item.originLabel));

        const middle = el('div');
        middle.append(el('div', null, item.action));
        middle.append(el('span', 'who', item.from));
        row.append(middle);

        const right = el('div', 'time');
        if (item.url) {
            const link = el('a', item.urlIsExact ? null : 'approx', item.time);
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noopener';
            if (!item.urlIsExact) link.title = 'Links to the page, not the comment: Notion gives comments no permalink.';
            right.append(link);
        } else {
            right.textContent = item.time;
        }
        row.append(right);
        rows.append(row);
    }
}

function renderCalls(report) {
    $('calls').classList.remove('hidden');
    const body = $('calls-body');
    body.replaceChildren();
    for (const call of report.calls) {
        const tr = el('tr');
        tr.append(el('td', null, call.method));
        tr.append(el('td', 'req', call.path));
        tr.append(el('td', call.ok ? 'status-ok' : 'status-bad', String(call.status)));
        tr.append(el('td', null, call.error || '—'));
        tr.append(el('td', null, String(call.ms)));
        body.append(tr);
    }
}

$('run').addEventListener('click', async () => {
    $('busy').classList.remove('hidden');
    $('run').disabled = true;
    const started = Date.now();
    const ticker = setInterval(() => {
        $('busy-progress').textContent = `${Math.round((Date.now() - started) / 1000)}s elapsed`;
    }, 1000);

    try {
        const qs = $('ratelimit').checked ? '?ratelimit=1' : '';
        const res = await fetch(`/api/probe${qs}`, { method: 'POST' });
        const report = await res.json();
        if (!res.ok) {
            alert(report.message || 'Probe failed');
            return;
        }
        renderVerdict(report);
        renderSignals(report);
        renderProbes(report);
        renderPreview(report);
        renderCalls(report);
    } catch (err) {
        alert(`Probe failed: ${err.message}`);
    } finally {
        clearInterval(ticker);
        $('busy').classList.add('hidden');
        $('run').disabled = false;
    }
});

loadStatus();
