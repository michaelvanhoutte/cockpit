/*
 * Browser code for the generated page.
 *
 * Reads window.__MODEL__ and nothing else. It has no idea how the model was
 * produced, which is the point: replacing the analyzer entirely should not
 * require touching this file, and replacing this file with a treemap should not
 * require touching the analyzer.
 *
 * Inlined into the output by html.js. Written as plain browser JS, no modules
 * and no build step, because a POC that needs a bundler is a POC nobody runs.
 */
(function () {
  'use strict';

  var MODEL = window.__MODEL__;
  var LEVELS = MODEL.levels;
  var RANK = { na: 0, ok: 1, later: 2, thin: 3, gap: 4 };
  var STATE_LABEL = { ok: 'met', thin: 'partial', gap: 'absent', later: 'not yet due', na: 'n/a' };
  var PILL_LABEL = { ok: 'met', thin: 'partial', gap: 'absent', later: 'pending', na: 'n/a' };
  var GLYPH = { ok: '✓', thin: '◧', gap: '×', later: '·', na: '' };

  // ---- index -----------------------------------------------------------
  var BY_ID = {};
  (function index(n) {
    BY_ID[n.id] = n;
    (n.children || []).forEach(index);
  })(MODEL.root);

  function hasGap(n) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (n.cells[LEVELS[i].id].state === 'gap') return true;
    }
    return (n.children || []).some(hasGap);
  }

  // ---- state -----------------------------------------------------------
  var DEFAULT_OPEN = [MODEL.root.id].concat((MODEL.root.children || []).map(function (c) { return c.id; }));
  var open = new Set(DEFAULT_OPEN);
  var gapsOnly = false;
  var selected = pickInitial();

  function pickInitial() {
    // Land on the leaf with the most unmet obligations, so the page opens on
    // something actionable. Projected nodes are skipped: they score highly on a
    // naive rank sum (three pending obligations each) while being, by
    // definition, nothing anyone can act on yet.
    var best = MODEL.root;
    var bestGaps = -1;
    (function visit(n) {
      var isLeaf = !n.children || !n.children.length;
      if (isLeaf && !n.projected) {
        var gaps = LEVELS.reduce(function (s, l) {
          return s + (n.cells[l.id].state === 'gap' ? 1 : 0);
        }, 0);
        if (gaps > bestGaps) { bestGaps = gaps; best = n; }
      }
      (n.children || []).forEach(visit);
    })(MODEL.root);
    return best.id;
  }

  var treeEl = document.getElementById('tree');
  var panelEl = document.getElementById('panel');
  var counterEl = document.getElementById('counter');

  // ---- tree ------------------------------------------------------------
  function render() {
    treeEl.textContent = '';

    var head = el('div', 'colhead');
    head.appendChild(el('span', 'nodecol', 'Node'));
    LEVELS.forEach(function (l) {
      var s = el('span', 'lv' + (l.sep ? ' sep' : ''), l.id);
      s.title = l.name;
      head.appendChild(s);
    });
    treeEl.appendChild(head);

    var shown = 0;

    (function walk(node, depth) {
      if (gapsOnly && !hasGap(node)) return;
      shown++;

      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'row kind-' + node.kind + (node.projected ? ' dim' : '');
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-selected', node.id === selected ? 'true' : 'false');

      var nameCell = el('span', 'nodecell');
      nameCell.style.paddingLeft = depth * 15 + 'px';

      var hasKids = (node.children || []).length > 0;
      var tw = el('span', 'twisty' + (hasKids ? (open.has(node.id) ? ' open' : '') : ' leaf'), '▶');
      nameCell.appendChild(tw);

      var nm = el('span', 'name', node.name);
      nameCell.appendChild(nm);

      if (node.kind === 'connector' || node.kind === 'service' || node.kind === 'pkg' || node.kind === 'tooling') {
        nameCell.appendChild(el('span', 'kindtag', node.kind));
      }
      row.appendChild(nameCell);

      LEVELS.forEach(function (l) {
        var cell = node.cells[l.id];
        var c = el('span', 'cell ' + cell.state + (l.sep ? ' sep' : ''), GLYPH[cell.state]);
        c.title = l.id + ' ' + l.name + ': ' + STATE_LABEL[cell.state] +
          (cell.count ? ' (' + cell.count + ' tests)' : '');
        row.appendChild(c);
      });

      row.addEventListener('click', function (e) {
        if (hasKids && (e.target === tw || e.target === nameCell || e.target === nm)) {
          if (open.has(node.id)) open.delete(node.id); else open.add(node.id);
        }
        selected = node.id;
        render();
        renderPanel();
      });

      treeEl.appendChild(row);

      if (hasKids && open.has(node.id)) {
        node.children.forEach(function (k) { walk(k, depth + 1); });
      }
    })(MODEL.root, 0);

    counterEl.textContent = shown + ' nodes shown';
  }

  // ---- mini pyramid ----------------------------------------------------
  // Three tiers, each split into a backend half and a frontend half. Contract
  // sits outside the pyramid, because it attaches to boundaries rather than to
  // a height in the tree.
  var NS = 'http://www.w3.org/2000/svg';
  var PYR = [
    { y0: 74, y1: 108, hw0: 34, hw1: 62, back: 'L3', front: 'F3' },
    { y0: 111, y1: 145, hw0: 62, hw1: 90, back: 'L2', front: 'F2' },
    { y0: 148, y1: 182, hw0: 90, hw1: 118, back: 'L1', front: 'F1' }
  ];
  var CX = 130;

  function pyramid(node) {
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 260 214');
    svg.setAttribute('class', 'minipyr');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Test level pyramid for ' + node.name);

    [[66, 'BACKEND'], [194, 'FRONTEND']].forEach(function (h) {
      var t = svgText(h[0], 62, 'mp-h', h[1]);
      t.setAttribute('text-anchor', 'middle');
      svg.appendChild(t);
    });

    PYR.forEach(function (tier) {
      [['back', -1], ['front', 1]].forEach(function (side) {
        var lv = tier[side[0]];
        var dir = side[1];
        var st = node.cells[lv].state;
        var o0 = CX + dir * tier.hw0;
        var o1 = CX + dir * tier.hw1;
        var inner = CX + dir * 2;

        var poly = document.createElementNS(NS, 'polygon');
        poly.setAttribute('points',
          o0 + ',' + tier.y0 + ' ' + inner + ',' + tier.y0 + ' ' +
          inner + ',' + tier.y1 + ' ' + o1 + ',' + tier.y1);
        poly.setAttribute('class', 'mp-' + (st === 'na' ? 'empty' : st));
        svg.appendChild(poly);

        // Anchored to the inner edge and running outward: centring the label
        // overflows the narrow tiers, where the text is wider than the tier.
        var count = node.cells[lv].count;
        var label = svgText(CX + dir * 7, tier.y1 - 11, 'mp-t ' + st,
          lv + (st === 'na' ? '' : ' · ' + (count ? count : STATE_LABEL[st])));
        label.setAttribute('text-anchor', dir < 0 ? 'end' : 'start');
        svg.appendChild(label);
      });
    });

    var cst = node.cells.C.state;
    var rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', 12); rect.setAttribute('y', 190);
    rect.setAttribute('width', 236); rect.setAttribute('height', 20); rect.setAttribute('rx', 4);
    rect.setAttribute('class', 'mp-' + (cst === 'na' ? 'empty' : cst));
    svg.appendChild(rect);
    var ct = svgText(130, 204, 'mp-t ' + cst, 'CONTRACT · ' + STATE_LABEL[cst]);
    ct.setAttribute('text-anchor', 'middle');
    svg.appendChild(ct);

    return svg;
  }

  function svgText(x, y, cls, text) {
    var t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('class', cls);
    t.textContent = text;
    return t;
  }

  // ---- detail panel ----------------------------------------------------
  function renderPanel() {
    var node = BY_ID[selected];
    panelEl.textContent = '';

    var head = el('div', 'panelhead');
    head.appendChild(el('div', 'p-name', node.name));
    head.appendChild(el('div', 'p-path', node.path));
    if (node.note) head.appendChild(el('div', 'p-note', node.note));
    panelEl.appendChild(head);

    if (node.signals) {
      var s = node.signals;
      var sig = el('div', 'sigrow');
      sig.appendChild(sigChip('branches', String(s.branches)));
      sig.appendChild(sigChip('pure', s.pure ? 'yes' : 'no (' + s.impureReason + ')'));
      sig.appendChild(sigChip('fan-in', String(s.fanIn)));
      sig.appendChild(sigChip('consequence', s.consequence));
      if (s.exports.length) sig.appendChild(sigChip('exports reached', s.reached.length + '/' + s.exports.length));
      panelEl.appendChild(sig);
    }

    panelEl.appendChild(pyramid(node));

    var hasKids = (node.children || []).length > 0;
    var cap = el('div', null, hasKids
      ? 'Rolled up over this node and everything beneath it. A tier shows the worst state any descendant reports.'
      : 'This node only. Levels shown grey do not apply to a node of this kind.');
    cap.style.cssText = 'font-size:12px;color:var(--ink-3);line-height:1.45;';
    panelEl.appendChild(cap);

    var ob = el('div', 'oblig');
    var any = false;
    LEVELS.forEach(function (l) {
      var cell = node.cells[l.id];
      if (cell.state === 'na') return;
      any = true;
      var row = el('div', 'o');
      row.appendChild(el('span', 'o-lv', l.id));
      row.appendChild(el('span', 'pill ' + cell.state, cell.count ? cell.count + ' tests' : PILL_LABEL[cell.state]));
      var why = el('span', 'o-why');
      if (cell.source === 'annotated') why.appendChild(el('span', 'tag', 'human call'));
      why.appendChild(document.createTextNode(cell.why ||
        ('Rolled up from descendants. ' + l.name + ' obligations below this node are ' + STATE_LABEL[cell.state] + '.')));
      row.appendChild(why);
      ob.appendChild(row);
    });
    if (!any) {
      var row2 = el('div', 'o');
      row2.style.gridTemplateColumns = '1fr';
      row2.appendChild(el('span', 'o-why',
        'No obligations at any level. Zero branches means there is nothing a test could discover here, so grey is ' +
        'the honest answer rather than a coverage failure.'));
      ob.appendChild(row2);
    }
    panelEl.appendChild(ob);
  }

  function sigChip(k, v) {
    var s = document.createElement('span');
    s.appendChild(el('b', null, k + ' '));
    s.appendChild(document.createTextNode(v));
    return s;
  }

  // ---- capability matrix -----------------------------------------------
  function renderCapabilities() {
    var body = document.getElementById('caps');
    if (!body) return;
    MODEL.capabilities.forEach(function (capability) {
      var tr = document.createElement('tr');
      var c1 = el('td', 'mono');
      c1.appendChild(el('strong', null, capability.name));
      tr.appendChild(c1);
      tr.appendChild(el('td', 'mono', capability.handler));
      ['L1', 'schema', 'F2', 'F3'].forEach(function (key) {
        var td = el('td', 'c');
        var state = capability.cells[key];
        td.appendChild(el('span', 'pill ' + state, state === 'ok' ? 'tested' : 'none'));
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
  }

  // ---- controls --------------------------------------------------------
  document.getElementById('btn-expand').addEventListener('click', function () {
    Object.keys(BY_ID).forEach(function (id) {
      if ((BY_ID[id].children || []).length) open.add(id);
    });
    render();
  });

  document.getElementById('btn-collapse').addEventListener('click', function () {
    open = new Set(DEFAULT_OPEN);
    render();
  });

  var gapsBtn = document.getElementById('btn-gaps');
  gapsBtn.addEventListener('click', function () {
    gapsOnly = !gapsOnly;
    gapsBtn.setAttribute('aria-pressed', String(gapsOnly));
    if (gapsOnly) {
      Object.keys(BY_ID).forEach(function (id) {
        if ((BY_ID[id].children || []).length) open.add(id);
      });
    }
    render();
  });

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  render();
  renderPanel();
  renderCapabilities();
})();
