#!/usr/bin/env node
// Runs the probe battery from the terminal and writes report.json.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, assertToken, config } from './config.js';
import { runProbes } from './probes.js';

const VERDICT_MARK = { pass: 'PASS', partial: 'PART', fail: 'FAIL', skipped: 'SKIP', info: 'INFO' };

const CONCLUSION = {
    yes: 'YES — the Real-time Search API can feed the Cockpit follow-up inbox.',
    'qualified-yes': 'QUALIFIED YES — it works, but at least one probe needs a workaround. Read the PART lines.',
    no: 'NO — at least one capability the design depends on did not work. Read the FAIL lines.',
    inconclusive: 'INCONCLUSIVE — the workspace had no data for the central probes, so nothing was proved either way.',
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

    console.log(`Cockpit — Slack Real-time Search API probe`);
    console.log(`Lookback: ${config.lookbackDays} days. Paced at ~1 request / 6.5s to respect the documented limit.\n`);

    const report = await runProbes({ includeRateLimit, onProgress: (msg) => console.log(msg) });

    console.log('\n' + '─'.repeat(72));
    for (const probe of report.probes) {
        console.log(`\n[${VERDICT_MARK[probe.verdict] ?? probe.verdict}] ${probe.id}  ${probe.question}`);
        console.log(`       ${probe.headline}`);
        console.log(`       ${probe.detail}`);
    }
    console.log('\n' + '─'.repeat(72));
    console.log(`\nVerdict: ${CONCLUSION[report.conclusion]}`);
    if (report.dataCaveat) console.log(`\nData caveat: ${report.dataCaveat}`);
    if (report.planCaveat) console.log(`\nPlan caveat: ${report.planCaveat}`);
    console.log(`\nInbox preview: ${report.inboxPreview.length} item(s) would land in Cockpit` +
        (report.botsDropped ? ` (${report.botsDropped} bot message(s) filtered out).` : '.') + '\n');
    for (const item of report.inboxPreview.slice(0, 10)) {
        console.log(`  · ${item.from.padEnd(34).slice(0, 34)} ${item.time.padStart(4)}  ${item.action}`);
    }

    const path = resolve(ROOT, 'report.json');
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(`\nFull report (every request, response shape and raw evidence): ${path}`);
    console.log(`Visual version: npm run serve\n`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
