#!/usr/bin/env node
// Runs the probe battery from the terminal and writes report.json.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, assertToken, config } from './config.js';
import { runProbes } from './probes.js';

const VERDICT_MARK = { pass: 'PASS', partial: 'PART', fail: 'FAIL', skipped: 'SKIP', info: 'INFO' };

const CONCLUSION = {
    yes: 'YES — the public Notion API can give Cockpit all four signals.',
    'qualified-yes': 'QUALIFIED YES — every signal is obtainable, but at least one needs a workaround. Read the PART lines.',
    no: 'NO — at least one thing the design depends on did not work. Read the FAIL lines.',
    inconclusive: 'INCONCLUSIVE — the workspace had no data for one of the four signals, so nothing was proved there.',
    blocked: 'BLOCKED — could not authenticate, so nothing was actually tested.',
};

async function main() {
    const includeRateLimit = process.argv.includes('--ratelimit');

    try {
        assertToken();
    } catch (err) {
        console.error(`\n${err.message}\n`);
        process.exit(1);
    }

    console.log('Cockpit — Notion follow-up inbox probe');
    console.log(`API version ${config.version} · plan declared as "${config.plan}" · paced at ~${(1000 / config.requestIntervalMs).toFixed(1)} req/s`);
    console.log(`Crawl budget: ${config.maxPages} page(s), block depth ${config.maxBlockDepth}, inline comments ${config.deepComments ? 'ON' : 'off'}\n`);

    const report = await runProbes({ includeRateLimit, onProgress: (msg) => console.log(msg) });

    console.log('\n' + '─'.repeat(76));
    console.log('\nThe five questions:\n');
    for (const signal of report.signals) {
        console.log(`[${VERDICT_MARK[signal.verdict] ?? signal.verdict}] ${signal.question}`);
        console.log(`       ${signal.headline}`);
    }

    console.log('\n' + '─'.repeat(76));
    for (const probe of report.probes) {
        console.log(`\n[${VERDICT_MARK[probe.verdict] ?? probe.verdict}] ${probe.id}  ${probe.question}`);
        console.log(`       ${probe.headline}`);
        for (const line of probe.detail.split('\n')) console.log(`       ${line}`);
    }

    console.log('\n' + '─'.repeat(76));
    console.log(`\nVerdict: ${CONCLUSION[report.conclusion]}`);
    if (report.dataCaveat) console.log(`\nData caveat: ${report.dataCaveat}`);

    if (report.cost) {
        console.log(`\nSweep cost: ${report.cost.totalRequests} request(s) to read ${report.cost.pages} page(s) / ` +
            `${report.cost.blocks} block(s) / ${report.cost.comments} comment(s) in ${(report.cost.wallMs / 1000).toFixed(1)}s ` +
            `(${report.calls.length} requests in the whole run).`);
    }

    console.log(`\nInbox preview: ${report.inboxPreview.length} item(s) would land in Cockpit.\n`);
    for (const item of report.inboxPreview.slice(0, 12)) {
        console.log(`  · ${item.originLabel.padEnd(9)} ${String(item.from).padEnd(24).slice(0, 24)} ${item.time.padStart(4)}  ${item.action.slice(0, 70)}`);
    }

    const path = resolve(ROOT, 'report.json');
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`\nFull report (every request and raw evidence): ${path}`);
    console.log('Visual version: npm run serve');
    console.log('Handled-afterwards experiment: npm run handled\n');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
