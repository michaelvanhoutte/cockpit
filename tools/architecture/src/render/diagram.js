/**
 * The Deployment diagram, computed from the model: GitHub on the left (its
 * workflows, the ones that deploy highlighted with an arrow into the
 * environment they deploy, GitHub Pages below, and local development under
 * that), the Cloudflare account on the right with one column per deployed
 * environment. Every size is derived from what the model holds, so a third
 * environment adds a column and a new binding kind adds a row; nothing is laid
 * out by hand.
 *
 * Text widths are estimated from the character count, since there is no font
 * to measure at build time. The estimate errs wide.
 */

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const PAD = 16;
const GAP = 16;
const SANS = 6.3;
const MONO = 7.9;
const WORKFLOW_ROW = 26;
const RESOURCE_ROW = 24;
const LOCAL_ROW = 20;

const longest = (strings) => strings.reduce((max, each) => Math.max(max, each.length), 0);

/** What a workflow row says: its file and what starts it, kept to the first start and a count so a busy workflow stays one line. */
function startsLabel(workflow) {
  const texts = workflow.starts.map((start) => start.text);
  return texts.length > 1 ? `${texts[0]} +${texts.length - 1}` : (texts[0] ?? '');
}

const valueOf = (resource) => resource.name ?? resource.binding ?? '';

export function renderDiagram(model) {
  const { environments, workflows } = model.deployment;
  const deployed = environments.filter((each) => each.kind !== 'local development');
  const local = environments.find((each) => each.kind === 'local development');
  const arrows = workflows.flatMap((workflow) =>
    workflow.deploys
      .map((deploy) => ({ workflow, column: deployed.findIndex((each) => each.name === deploy.environment) }))
      .filter((each) => each.column >= 0),
  );
  const pages = model.deployment.pages;

  // ---- the left column, whose width the longest workflow row sets
  const rowText = workflows.map((workflow) => `${workflow.file} · ${startsLabel(workflow)}`);
  const leftWidth = Math.max(330, 28 + longest(rowText) * SANS + 16, 28 + longest((pages?.reports ?? []).map((each) => `${each.path} ${each.artifact}`)) * SANS);
  const innerLeft = PAD * 2;
  const innerWidth = leftWidth - PAD * 2;

  const parts = [];
  const hasRepo = Boolean(model.drawnFrom.repo);

  const actionsTop = 60;
  const actionsHeight = 44 + workflows.length * WORKFLOW_ROW;
  parts.push(
    `<rect class="soft" x="${PAD}" y="${PAD}" width="${leftWidth}" height="${actionsTop - PAD + actionsHeight + 16}" rx="6"/>`,
    `<text class="t-h" x="${innerLeft}" y="42">GitHub</text>`,
    hasRepo ? `<text class="t-m" x="${innerLeft + 62}" y="42">${esc(model.drawnFrom.repo)}</text>` : '',
    `<rect class="box" x="${innerLeft}" y="${actionsTop}" width="${innerWidth}" height="${actionsHeight}" rx="4"/>`,
    `<text class="t-h" x="${innerLeft + 12}" y="${actionsTop + 26}">Actions</text>`,
  );
  const rowY = new Map();
  workflows.forEach((workflow, index) => {
    const y = actionsTop + 54 + index * WORKFLOW_ROW;
    rowY.set(workflow.file, y - 4);
    const deploys = workflow.deploys.length > 0;
    parts.push(`<text class="${deploys ? 't-hl' : 't-i'}" x="${innerLeft + 12}" y="${y}">${esc(workflow.file)} <tspan class="t-m${deploys ? ' t-hl-m' : ''}">· ${esc(startsLabel(workflow))}</tspan></text>`);
  });
  let leftBottom = actionsTop + actionsHeight + 16;

  if (pages) {
    const top = leftBottom + 4;
    const height = 44 + Math.max(pages.reports.length, 1) * 20;
    const labelWidth = longest(pages.reports.map((each) => each.path)) * MONO + 12;
    parts.push(
      `<rect class="soft" x="${PAD}" y="${top - 4}" width="${leftWidth}" height="${height + 16}" rx="6"/>`,
      `<rect class="box" x="${innerLeft}" y="${top + 12}" width="${innerWidth}" height="${height - 8}" rx="4"/>`,
      `<text class="t-h" x="${innerLeft + 12}" y="${top + 36}">GitHub Pages <tspan class="t-m">published by ${esc(pages.workflow)}</tspan></text>`,
      pages.reports.length === 0 ? `<text class="t-m" x="${innerLeft + 12}" y="${top + 60}">no report downloaded</text>` : '',
      ...pages.reports.map((report, index) => `<text class="t-h" x="${innerLeft + 12}" y="${top + 60 + index * 20}">${esc(report.path)}</text><text class="t-i" x="${innerLeft + 12 + labelWidth}" y="${top + 60 + index * 20}">${esc(report.artifact)}</text>`),
    );
    leftBottom = top - 4 + height + 16 + 16;
  }

  if (local) {
    const top = leftBottom + 4;
    const rows = local.resources;
    const labelWidth = longest(rows.map((each) => each.kind)) * MONO + 12;
    const height = 70 + Math.max(rows.length, 1) * LOCAL_ROW;
    parts.push(
      `<rect class="soft" x="${PAD}" y="${top}" width="${leftWidth}" height="${height}" rx="6"/>`,
      `<text class="t-h" x="${innerLeft}" y="${top + 26}">Local development</text>`,
      `<text class="t-m" x="${innerLeft}" y="${top + 46}">Wrangler environment <tspan class="t-mono">${esc(local.name)}</tspan>${local.worker ? `, Worker ${esc(local.worker)}` : ''}</text>`,
      rows.length === 0 ? `<text class="t-m" x="${innerLeft}" y="${top + 70}">binds nothing</text>` : '',
      ...rows.map(
        (each, index) =>
          `<text class="t-h" x="${innerLeft}" y="${top + 70 + index * LOCAL_ROW}">${esc(each.kind)}</text><text class="t-i" x="${innerLeft + labelWidth}" y="${top + 70 + index * LOCAL_ROW}">${esc(valueOf(each))}${each.inherited ? ' <tspan class="t-m">inherited</tspan>' : ''}</text>`,
      ),
    );
    leftBottom = top + height + 16;
  }

  // ---- the Cloudflare account: one column per deployed environment
  const lanes = arrows.length;
  const cfLeft = PAD + leftWidth + 24 + 8 * lanes;
  const columnsTop = PAD + 58 + 6 * lanes;
  const kindWidth = longest(deployed.flatMap((each) => each.resources.map((resource) => resource.kind))) * MONO + 14;
  const columns = deployed.map((environment) => {
    const longestValue = longest(environment.resources.map((each) => valueOf(each) + (each.inherited ? ' inherited' : '')));
    const deployer = workflows.find((workflow) => environment.deployedBy.includes(workflow.file));
    return {
      environment,
      deployer,
      width: Math.max(290, 32 + kindWidth + longestValue * SANS + 8, 32 + longest([environment.worker ?? '']) * SANS),
    };
  });
  const columnHeight = 104 + Math.max(0, ...deployed.map((each) => each.resources.length)) * RESOURCE_ROW + 12;
  let x = cfLeft + PAD;
  for (const column of columns) {
    column.x = x;
    x += column.width + GAP;
  }
  const cfWidth = x - GAP + PAD - cfLeft;

  parts.push(
    `<rect class="soft" x="${cfLeft}" y="${PAD}" width="${cfWidth}" height="${columnsTop - PAD + columnHeight + 16}" rx="6"/>`,
    `<text class="t-h" x="${cfLeft + PAD}" y="42">Cloudflare account</text>`,
  );
  for (const { environment, deployer, width, x: left } of columns) {
    const deployedBy = deployer ? `deployed ${deployer.starts.map((start) => start.text).join(' and ')}` : 'no workflow deploys it';
    const others = environment.deployedBy.length - 1;
    parts.push(
      `<rect class="worker" x="${left}" y="${columnsTop}" width="${width}" height="${columnHeight}" rx="5"/>`,
      `<text class="t-w" x="${left + 16}" y="${columnsTop + 28}">${esc(environment.name)}</text>`,
      `<text class="t-m" x="${left + 16}" y="${columnsTop + 50}">${esc(deployedBy)}${deployer ? ` (${esc(deployer.file)}${others > 0 ? ` +${others}` : ''})` : ''}</text>`,
      environment.worker ? `<text class="t-m" x="${left + 16}" y="${columnsTop + 70}">Worker ${esc(environment.worker)}</text>` : '',
      ...environment.resources.map((resource, index) => {
        const y = columnsTop + 104 + index * RESOURCE_ROW;
        return `<text class="t-h" x="${left + 16}" y="${y}">${esc(resource.kind)}</text><text class="t-i" x="${left + 16 + kindWidth}" y="${y}">${esc(valueOf(resource))}${resource.inherited ? ' <tspan class="t-m">inherited</tspan>' : ''}</text>`;
      }),
    );
  }

  // ---- the arrows, last so they sit over the panels: out of the workflow's
  // row, through a lane of its own in the gap, along a channel above the
  // columns, and down into the environment it deploys
  const sourceX = PAD + leftWidth - PAD;
  arrows.forEach(({ workflow, column }, index) => {
    const target = columns[column];
    const lane = PAD + leftWidth + 10 + index * 8;
    const channel = PAD + 40 + index * 6;
    const centre = target.x + target.width / 2;
    parts.push(`<path class="wline" d="M${sourceX},${rowY.get(workflow.file)} H${lane} V${channel + 12} H${centre} V${columnsTop - 2}" marker-end="url(#arrow)"/>`);
  });

  const width = Math.ceil(cfLeft + cfWidth + PAD);
  const height = Math.ceil(Math.max(leftBottom, columnsTop + columnHeight + 16 + 16) + PAD);
  const label = `Deployment diagram: GitHub workflows deploying ${deployed.map((each) => each.name).join(' and ')} on Cloudflare${local ? ', and local development' : ''}.`;
  return `<svg viewBox="0 0 ${width} ${height}" style="min-width:${Math.round(width * 0.8)}px" role="img" aria-label="${esc(label)}">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="arrowhead" d="M0,0 L10,5 L0,10 z"/></marker></defs>
  ${parts.filter(Boolean).join('\n  ')}
</svg>`;
}
