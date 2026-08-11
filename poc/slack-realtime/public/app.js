const $ = (id) => document.getElementById(id);

const CONCLUSION_TEXT = {
    yes: 'Yes — Real-time Search can feed the Cockpit follow-up inbox.',
    'qualified-yes': 'Qualified yes — it works, but at least one probe needs a workaround.',
    no: 'No — a capability the design depends on did not work.',
    inconclusive: 'Inconclusive — the workspace had no data for the central probes.',
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
    if (!status.configured) {
        $('setup').classList.remove('hidden');
        $('setup-msg').textContent = status.tokenKind === 'bot'
            ? 'SLACK_USER_TOKEN holds a bot token (xoxb-). assistant.search.context needs a user token unless you also pass an action_token from a Slack event payload.'
            : 'No Slack user token is configured, so there is nothing to probe yet.';
        $('run').disabled = true;
    }
}

function renderVerdict(report) {
    const section = $('verdict');
    section.classList.remove('hidden');
    const badge = $('verdict-badge');
    badge.className = `badge ${report.conclusion}`;
    badge.textContent = report.conclusion.replace('-', ' ');
    $('verdict-text').textContent = CONCLUSION_TEXT[report.conclusion] || report.conclusion;
    const id = report.identity || {};
    $('verdict-identity').textContent = id.userId
        ? `${id.userName} (${id.userId}) in ${id.team} · lookback ${report.lookbackDays} days · ${report.calls.length} API calls`
        : `${report.calls.length} API calls`;

    const dataCaveat = $('verdict-data-caveat');
    dataCaveat.classList.toggle('hidden', !report.dataCaveat);
    dataCaveat.textContent = report.dataCaveat || '';

    const caveat = $('verdict-caveat');
    caveat.classList.toggle('hidden', !report.planCaveat);
    caveat.textContent = report.planCaveat || '';
}

function renderProbes(report) {
    const host = $('probes');
    host.replaceChildren();
    for (const probe of report.probes) {
        const card = el('section', 'card');
        const grid = el('div', 'probe');

        const badge = el('span', `badge ${probe.verdict}`, probe.verdict);
        grid.append(badge);

        const body = el('div');
        body.append(el('div', 'q', `${probe.id} · ${probe.question}`));
        body.append(el('p', 'headline', probe.headline));
        body.append(el('p', 'detail', probe.detail));

        if (probe.evidence && Object.keys(probe.evidence).length) {
            const details = el('details');
            details.append(el('summary', null, 'Evidence'));
            const pre = el('pre', null, JSON.stringify(probe.evidence, null, 2));
            details.append(pre);
            body.append(details);
        }
        grid.append(body);
        card.append(grid);
        host.append(card);
    }
}

function renderPreview(report) {
    const section = $('preview');
    section.classList.remove('hidden');
    const rows = $('rows');
    rows.replaceChildren();

    if (!report.inboxPreview.length) {
        rows.append(el('p', 'empty', 'Nothing came back, so the inbox would be empty.'));
        return;
    }
    for (const item of report.inboxPreview) {
        const row = el('div', 'row');
        row.append(el('span', 'tag', item.origin === 'dm' ? 'DM' : 'Mention'));

        const middle = el('div');
        const action = el('div', null, item.action);
        middle.append(action);
        middle.append(el('span', 'who', item.from));
        row.append(middle);

        const right = el('div', 'time');
        if (item.url) {
            const link = el('a', null, item.time);
            link.href = item.url;
            link.target = '_blank';
            link.rel = 'noopener';
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
        const status = el('td', call.ok ? 'status-ok' : 'status-bad', String(call.status));
        tr.append(status);
        tr.append(el('td', null, call.error || '—'));
        tr.append(el('td', null, String(call.ms)));
        tr.append(el('td', 'req', JSON.stringify(call.request)));
        body.append(tr);
    }
}

$('run').addEventListener('click', async () => {
    $('busy').classList.remove('hidden');
    $('run').disabled = true;
    try {
        const qs = $('ratelimit').checked ? '?ratelimit=1' : '';
        const res = await fetch(`/api/probe${qs}`, { method: 'POST' });
        const report = await res.json();
        if (!res.ok) {
            alert(report.message || 'Probe failed');
            return;
        }
        renderVerdict(report);
        renderProbes(report);
        renderPreview(report);
        renderCalls(report);
    } catch (err) {
        alert(`Probe failed: ${err.message}`);
    } finally {
        $('busy').classList.add('hidden');
        $('run').disabled = false;
    }
});

loadStatus();
