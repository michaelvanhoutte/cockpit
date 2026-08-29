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
  (function index(nodes, depth) {
    nodes.forEach(function (n) {
      BY_KEY[n.key] = n;
      index(n.children, depth + 1);
    });
  })(MODEL.tree, 0);

  var rowsEl = document.getElementById('rows');
  var panelEl = document.getElementById('panel');
  var open = {}; // tree node key -> expanded, default expanded
  var selected = MODEL.tree.length ? MODEL.tree[0].key : null;
  var activeTab = 'rules'; // 'rules' | 'files' | 'branches', per selected node

  // ---- links -----------------------------------------------------------
  function localHref(relFile) {
    return REPO_REL + '/' + relFile;
  }

  /** GitHub's #Lnn anchor jumps straight to the line — preferred over the local link when available. */
  function githubHref(relFile, line) {
    if (!MODEL.commitUrl) return null;
    return MODEL.commitUrl.replace('/commit/', '/blob/') + '/' + relFile + (line ? '#L' + line : '');
  }

  // ---- tree --------------------------------------------------------------
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
          td.appendChild(countPill(node.counts[l.id], false));
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
          activeTab = 'rules';
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

  // ---- detail panel: tabs, each filling the whole panel -------------------
  var TABS = [
    { id: 'rules', label: function (n) { return 'Rules (' + n.rules.length + ')'; } },
    { id: 'files', label: function (n) { return 'Files nothing runs (' + n.filesNothingRuns.length + ')'; } },
    {
      id: 'branches',
      label: function (n) { return 'Branches nothing takes (' + (n.branchesNothingTakes === null ? 'unknown' : n.branchesNothingTakes.length) + ')'; },
    },
  ];

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

    var tabbar = el('div', 'tabbar');
    TABS.forEach(function (t) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab' + (activeTab === t.id ? ' active' : '');
      btn.textContent = t.label(node);
      btn.addEventListener('click', function () {
        activeTab = t.id;
        renderPanel();
      });
      tabbar.appendChild(btn);
    });
    panelEl.appendChild(tabbar);

    var body = el('div', 'tabbody');
    panelEl.appendChild(body);

    if (activeTab === 'rules') renderRules(body, node);
    else if (activeTab === 'files') renderFiles(body, node);
    else renderBranches(body, node);
  }

  function renderRules(body, node) {
    if (!node.rules.length) {
      body.appendChild(el('div', 'p-empty', 'No rules found directly on this area.'));
      return;
    }
    var list = el('div', 'rulelist');
    node.rules.forEach(function (r) {
      var card = el('div', 'rule');
      var top = el('div', 'r-top');
      top.appendChild(el('span', 'r-level', r.level));
      top.appendChild(codeToggle(r, r.file + ':' + r.line));
      card.appendChild(top);
      card.appendChild(el('div', 'r-text', r.statement));

      if (r.cases.length) {
        var cases = el('div', 'caselist');
        r.cases.forEach(function (c) {
          cases.appendChild(caseRow(c, false));
        });
        card.appendChild(cases);
      }
      if (r.todoCases.length) {
        var todos = el('div', 'caselist');
        r.todoCases.forEach(function (c) {
          todos.appendChild(caseRow(c, true));
        });
        card.appendChild(todos);
      }

      list.appendChild(card);
    });
    body.appendChild(list);
  }

  function caseRow(c, isTodo) {
    var row = el('div', 'case' + (isTodo ? ' case-todo' : ''));
    row.appendChild(el('span', 'case-mark', isTodo ? '○' : '✓'));
    var text = el('span', 'case-text', c.text);
    row.appendChild(text);
    row.appendChild(codeToggle(c, c.file + ':' + c.line));
    return row;
  }

  function renderFiles(body, node) {
    if (!node.filesNothingRuns.length) {
      body.appendChild(el('div', 'p-empty', 'None.'));
      return;
    }
    var list = el('div', 'filelist');
    node.filesNothingRuns.forEach(function (f) {
      var row = el('div', 'f-item');
      row.appendChild(codeToggle(f, f.file));
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  function renderBranches(body, node) {
    if (node.branchesNothingTakes === null) {
      body.appendChild(el('div', 'p-empty', 'No coverage data for this run — run pnpm test:coverage first.'));
      return;
    }
    if (!node.branchesNothingTakes.length) {
      body.appendChild(el('div', 'p-empty', 'None.'));
      return;
    }
    var list = el('div', 'filelist');
    node.branchesNothingTakes.forEach(function (b) {
      var row = el('div', 'f-item');
      row.appendChild(codeToggle(b, b.file + ':' + b.line));
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  /**
   * A clickable `label` that toggles an inline source-context viewer for `ref`
   * ({file, line, context}) open/closed — reading the surrounding source
   * without leaving the page, plus a real link (GitHub when the report knows
   * its commit, otherwise a local relative link) to open the actual file.
   */
  function codeToggle(ref, label) {
    var wrap = el('div', 'coderef');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filelink';
    btn.textContent = label;
    var body = null;

    btn.addEventListener('click', function () {
      if (body) {
        body.remove();
        body = null;
        btn.classList.remove('open');
        return;
      }
      btn.classList.add('open');
      body = renderCodeContext(ref);
      wrap.appendChild(body);
    });

    wrap.appendChild(btn);
    return wrap;
  }

  function renderCodeContext(ref) {
    var box = el('div', 'codebox');

    var links = el('div', 'codelinks');
    var gh = githubHref(ref.file, ref.line);
    if (gh) {
      var ghLink = document.createElement('a');
      ghLink.href = gh;
      ghLink.target = '_blank';
      ghLink.rel = 'noopener';
      ghLink.textContent = 'Open on GitHub ↗';
      links.appendChild(ghLink);
    }
    var localLink = document.createElement('a');
    localLink.href = localHref(ref.file);
    localLink.target = '_blank';
    localLink.rel = 'noopener';
    localLink.textContent = 'Open file ↗';
    links.appendChild(localLink);
    box.appendChild(links);

    if (!ref.context || !ref.context.length) {
      box.appendChild(el('div', 'p-empty', 'Source not available.'));
      return box;
    }

    var pre = document.createElement('pre');
    pre.className = 'codepre';
    ref.context.forEach(function (l) {
      var lineEl = el('div', 'codeline' + (l.line === ref.line ? ' target' : ''));
      lineEl.appendChild(el('span', 'codeline-no', String(l.line)));
      lineEl.appendChild(el('span', 'codeline-text', l.text));
      pre.appendChild(lineEl);
    });
    box.appendChild(pre);
    return box;
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
