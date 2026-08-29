/*
 * Browser code for the generated page. Reads window.__MODEL__ and nothing
 * else. Plain browser JS, no modules, no build step — a report that needs a
 * bundler to view is a report nobody opens.
 */
(function () {
  'use strict';

  var MODEL = window.__MODEL__;
  var LEVELS = MODEL.levels;
  var REPO_REL = MODEL.repoRelPrefix.replace(/\/$/, '');

  // ---- index every node by key, remember parent/depth for the tree walk ----
  var BY_KEY = {};
  var PARENT_OF = {};
  (function index(nodes, depth) {
    nodes.forEach(function (n) {
      BY_KEY[n.key] = n;
      n.__depth = depth;
      index(n.children, depth + 1);
      n.children.forEach(function (c) { PARENT_OF[c.key] = n.key; });
    });
  })(MODEL.tree, 0);

  var rowsEl = document.getElementById('rows');
  var panelEl = document.getElementById('panel');
  var open = {}; // key -> expanded, default expanded
  var selected = MODEL.tree.length ? MODEL.tree[0].key : null;

  function fileHref(relFile) {
    return REPO_REL + '/' + relFile;
  }

  function render() {
    rowsEl.textContent = '';

    (function walk(nodes, depth) {
      nodes.forEach(function (node) {
        var tr = document.createElement('tr');
        tr.className = 'row' + (node.key === selected ? ' selected' : '');

        var nameTd = document.createElement('td');
        var nameWrap = el('span', 'namewrap');
        nameWrap.style.paddingLeft = depth * 18 + 'px';

        var hasKids = node.children.length > 0;
        var twisty = el('span', 'twisty' + (hasKids ? (open[node.key] !== false ? ' open' : '') : ' leaf'), hasKids ? '▶' : '');
        nameWrap.appendChild(twisty);
        nameWrap.appendChild(el('span', 'name', node.label));
        nameTd.appendChild(nameWrap);
        tr.appendChild(nameTd);

        LEVELS.forEach(function (l) {
          var td = el('td', 'c');
          var n = node.counts[l.id];
          td.appendChild(countPill(n, false));
          tr.appendChild(td);
        });

        var filesTd = el('td', 'c');
        filesTd.appendChild(countPill(node.filesNothingRuns.length, true));
        tr.appendChild(filesTd);

        var branchesTd = el('td', 'c');
        if (node.branchesNothingTakes === null) {
          branchesTd.appendChild(el('span', 'pill na', 'unknown'));
        } else {
          branchesTd.appendChild(countPill(node.branchesNothingTakes.length, true));
        }
        tr.appendChild(branchesTd);

        tr.addEventListener('click', function (e) {
          if (hasKids && (e.target === twisty || twisty.contains(e.target))) {
            open[node.key] = !(open[node.key] !== false);
            render();
            return;
          }
          selected = node.key;
          render();
          renderPanel();
        });

        rowsEl.appendChild(tr);

        if (hasKids && open[node.key] !== false) walk(node.children, depth + 1);
      });
    })(MODEL.tree, 0);
  }

  function countPill(n, badWhenNonzero) {
    if (n === null) return el('span', 'pill na', 'n/a');
    var cls = n === 0 ? 'pill zero' : badWhenNonzero ? 'pill bad' : 'pill';
    return el('span', cls, String(n));
  }

  function renderPanel() {
    var node = BY_KEY[selected];
    panelEl.textContent = '';
    if (!node) {
      panelEl.appendChild(el('div', 'p-empty', 'Select a row.'));
      return;
    }

    var head = el('div', 'panelhead');
    head.appendChild(el('div', 'p-name', node.label));
    panelEl.appendChild(head);

    var rulesHead = el('div', 'p-section', 'Rules (' + node.rules.length + ')');
    panelEl.appendChild(rulesHead);
    if (!node.rules.length) {
      panelEl.appendChild(el('div', 'p-empty', 'No rules found directly on this area.'));
    } else {
      var list = el('div', 'rulelist');
      node.rules.forEach(function (r) {
        var row = el('div', 'rule');
        var top = el('div', 'r-top');
        top.appendChild(el('span', 'r-level', r.level));
        top.appendChild(fileLink(r.file, r.line));
        row.appendChild(top);
        row.appendChild(el('div', 'r-text', r.statement));
        if (r.todoCases) row.appendChild(el('span', 'r-todo', r.todoCases + ' todo'));
        list.appendChild(row);
      });
      panelEl.appendChild(list);
    }

    panelEl.appendChild(el('div', 'p-section', 'Files nothing runs (' + node.filesNothingRuns.length + ')'));
    if (!node.filesNothingRuns.length) {
      panelEl.appendChild(el('div', 'p-empty', 'None.'));
    } else {
      var files = el('div', 'filelist');
      node.filesNothingRuns.forEach(function (f) {
        var row = el('div', 'f-item');
        row.appendChild(fileLink(f));
        files.appendChild(row);
      });
      panelEl.appendChild(files);
    }

    panelEl.appendChild(el('div', 'p-section', 'Branches nothing takes'));
    if (node.branchesNothingTakes === null) {
      panelEl.appendChild(el('div', 'p-empty', 'No coverage data for this run — run pnpm test:coverage first.'));
    } else if (!node.branchesNothingTakes.length) {
      panelEl.appendChild(el('div', 'p-empty', 'None.'));
    } else {
      var branches = el('div', 'filelist');
      node.branchesNothingTakes.forEach(function (b) {
        var row = el('div', 'f-item branch-item');
        row.appendChild(fileLink(b.file, b.line));
        if (b.snippet) row.appendChild(el('code', 'snippet', b.snippet));
        branches.appendChild(row);
      });
      panelEl.appendChild(branches);
    }
  }

  function fileLink(relFile, line) {
    var a = document.createElement('a');
    a.href = fileHref(relFile);
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'filelink';
    a.textContent = relFile + (line ? ':' + line : '');
    return a;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  render();
  renderPanel();
})();
