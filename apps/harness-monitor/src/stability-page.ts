import { startOfDay } from './belgium';
import { periodDays } from './ci-flakiness';
import type { FragileData, WorkflowData } from './ci-flakiness-report';
import { COPY_STYLE } from './copy-prompt';
import { PERIODS } from './costs';
import { EXPLAIN_SCRIPT, EXPLAIN_STYLE, lead } from './explain';
import { esc, inline, questionOf, sentenceForm } from './look';
import { number, REPOSITORY } from './page';
import { VIOLET } from './palette';
import { reportPage, section } from './report';
import { GROUPS, sortOf, stabilityAddress, SORTS, type StabilityData, type StabilityQuery } from './stability-report';
import { LEAD_MORE } from './stability-explain';
import { FRAGILE_STYLE, fragileTab } from './stability-fragile-page';
import { jobTab } from './stability-job-page';
import { ROWS_STYLE } from './stability-rows';
import { redNowNotice, WORKFLOW_STYLE, workflowTab } from './stability-workflow-page';

const ROW_WORDS: Record<StabilityQuery['group'], string> = { job: 'each job', workflow: 'each workflow', tests: 'each fragile test' };
/** The period as a word of the page's sentence ("over the last 7 days"). */
const PERIOD_WORDS: [string, string][] = [
  ['7d', 'the last 7 days'],
  ['30d', 'the last 30 days'],
  ['90d', 'the last 90 days'],
  ['all', 'everything held'],
];

/** The CI stability page's Job tab, drawn from the stored attempts: main's figures in each row, and the feature branches in the strip it opens to. */
export function renderStability(q: StabilityQuery, data: StabilityData, repository: string | undefined, now: number): string {
  const anomalies = data.unrecognised.length
    ? `<p class="notice" role="status"><strong>Not counted, because the report does not recognise them:</strong> ${data.unrecognised
        .map((a) => `${number(a.count)} run${a.count === 1 ? '' : 's'} or job${a.count === 1 ? '' : 's'} concluded &ldquo;${esc(a.conclusion)}&rdquo;`)
        .join('; ')}.</p>`
    : '';
  return attemptsPage(q, data, repository, now, (days, link) => jobTab(q, data, days, link), '', anomalies);
}

/** The CI stability page's Workflow tab, drawn from the stored attempts on every branch. */
export function renderWorkflowStability(q: StabilityQuery, data: WorkflowData, repository: string | undefined, now: number): string {
  return attemptsPage(q, data, repository, now, (days, link) => workflowTab(q, data, days, link), WORKFLOW_STYLE);
}

/** The CI stability page's Fragile tests tab, drawn from the same stored attempts and the misses Test selection stored. */
export function renderFragileStability(q: StabilityQuery, data: FragileData, repository: string | undefined, now: number): string {
  return attemptsPage(q, data, repository, now, (days) => fragileTab(q, data, days), FRAGILE_STYLE);
}

/** What the tabs drawn from the stored attempts share: the days, the note on how much is stored, the red-now line and the empty page. */
function attemptsPage(q: StabilityQuery, data: WorkflowData, repository: string | undefined, now: number, tab: (days: string[], link: (over: Partial<StabilityQuery>) => string) => string, style: string, notes = ''): string {
  const repo = repository !== undefined && REPOSITORY.test(repository) ? repository : null;
  const days = periodDays(q.period, now, data.oldest);
  const first = startOfDay(days[0]!);
  const named = PERIODS[q.period];
  const partial = data.oldest !== null && named !== null && data.oldest > first ? `<p class="muted small">Only ${number(Math.max(1, Math.round((now - data.oldest) / 86_400_000)))} of the period&rsquo;s ${number(named)} days are stored so far.</p>` : '';
  const content = data.attempts.length === 0
    ? section('nothing', 'CI stability', '', '<p class="well empty">Nothing in this period. No attempt is stored for it.</p>')
    : tab(days, (over) => esc(stabilityAddress(q, over)));
  return stabilityFrame(q, repo, data.workflows, `${partial}${redNowNotice(data.redNow, now)}${notes}`, content, now, ROWS_STYLE + style + COPY_STYLE);
}

/** What every tab shares: the sentence on the band, the lead, the notices and the content. */
function stabilityFrame(q: StabilityQuery, repo: string | null, workflows: string[], notices: string, content: string, now: number, style = ''): string {
  // The controls as one sentence on the band: the order is a word of it where the rows have more than one.
  const sorts = SORTS[q.group];
  const workflowChoices: [string, string][] = [['', 'All workflows'], ...workflows.map((w): [string, string] => [w, w])];
  if (q.workflow !== null && !workflows.includes(q.workflow)) workflowChoices.push([q.workflow, q.workflow]);
  const sort = sortOf(q);
  const form = sentenceForm(
    '/stability',
    `Show CI for ${inline('group', 'Rows', GROUPS.map((g): [string, string] => [g, ROW_WORDS[g]]), q.group)}
${sorts.length ? inline('sort', 'Order', sorts.map(([v, t]): [string, string] => [v, `${t.toLowerCase()} first`]), sort) : ''}
over ${inline('period', 'Period', PERIOD_WORDS, q.period)}`,
    [inline('workflow', 'Workflow', workflowChoices, q.workflow ?? '', '')],
    repo ? [`<a class="button" href="https://github.com/${repo}/actions" target="_blank" rel="noopener noreferrer">Open in Actions</a>`] : [],
  );
  // The page opens with the question its top tab names and the words a newcomer will not know, under the band, on every tab.
  const pageLead = lead(questionOf('stability'), LEAD_MORE);
  return reportPage({ current: 'stability', controls: form, body: `${pageLead}
${notices}
${content}
${EXPLAIN_SCRIPT}`, style: EXTRA + EXPLAIN_STYLE + style }, now);
}

const EXTRA = `
.rate{font-weight:600;text-decoration:none;color:var(--ink-strong)}.rate.ok{color:var(--good)}.rate.poor{color:var(--over-ink)}
.rate.none{color:var(--ink-faint);font-weight:400}
a.rate:hover{text-decoration:underline}
.of{display:block;font-size:12px;color:var(--ink-faint);font-weight:400}
.tile.name .tile-value{font-size:22px;line-height:1.25;padding:6px 0 5px}.tile.name .tile-value a{color:var(--ink-strong);text-decoration:none}.tile.name .tile-value a:hover{color:var(--accent-deep)}
.changes .verdict{color:inherit;text-decoration:none}.changes .verdict:hover{text-decoration:underline}
code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}
tr.chosen td{background:var(--accent-tint)}
tr.open td{background:color-mix(in srgb,var(--over) 8%,transparent)}
.lasted-cell{width:260px}
.lasted{display:flex;align-items:center;gap:10px}.lasted .track{flex:1;height:8px;border-radius:2px;overflow:hidden;background:color-mix(in srgb,var(--shade) 7%,transparent)}.lasted .fill{display:block;height:100%;background:var(--over)}
.lasted .num{min-width:64px}
.step-cell{color:var(--ink-soft)}
.steps-note{margin:0 16px 14px;padding-top:12px}
.steps{list-style:none;margin:0;padding:6px 0}
.steps li{display:grid;grid-template-columns:minmax(180px,2fr) minmax(120px,3fr) 80px 80px 56px;gap:12px;align-items:center;padding:7px 16px;border-bottom:1px solid color-mix(in srgb,var(--shade) 8%,transparent);font-size:14px;font-variant-numeric:tabular-nums}
.steps li:last-child{border-bottom:0}
.steps li.head{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint)}
.steps li.head i{display:inline-block;width:10px;height:10px;border-radius:3px;margin:0 6px 0 10px;vertical-align:-1px}.steps li.head i:first-child{margin-left:0}
.steps .step-name{color:var(--ink-strong)}
.steps .track{position:relative;height:10px;border-radius:2px;background:color-mix(in srgb,var(--shade) 6%,transparent)}
.steps .track span{position:absolute;left:0;top:0;bottom:0;border-radius:2px}
.steps .median,.steps li.head i.median{background:${VIOLET}}.steps .p90,.steps li.head i.p90{background:color-mix(in srgb,${VIOLET} 30%,transparent)}
@media (max-width:640px){
  .steps li{grid-template-columns:1fr 64px 64px;gap:4px 10px}.steps .track{grid-column:1/-1;order:5}.steps li>span:last-child{display:none}.steps li.head>span:nth-child(2){display:none}
}
`;
