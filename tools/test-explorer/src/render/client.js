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
  var ruleLevelFilter = null; // one of LEVELS' ids, or null for "every level"

  // ---- links -----------------------------------------------------------
  function localHref(relFile) {
    return REPO_REL + '/' + relFile;
  }

  /** GitHub's #Lnn anchor jumps straight to the line — preferred over the local link when available. */
  function githubHref(relFile, line) {
    if (!MODEL.commitUrl) return null;
    return MODEL.commitUrl.replace('/commit/', '/blob/') + '/' + relFile + (line ? '#L' + line : '');
  }

  function selectNode(key) {
    selected = key;
  }

  // Collapsed to the roots is the shape of the product on one screen; expanded
  // is every area. Both are one click, so neither is a trek through twisties.
  function setAllOpen(isOpen) {
    Object.keys(BY_KEY).forEach(function (key) {
      open[key] = isOpen;
    });
    render();
  }
  document.getElementById('collapse-all').addEventListener('click', function () {
    setAllOpen(false);
  });
  document.getElementById('expand-all').addEventListener('click', function () {
    setAllOpen(true);
  });

  // ---- tree --------------------------------------------------------------
  function render() {
    rowsEl.textContent = '';

    (function walk(nodes, depth) {
      nodes.forEach(function (node) {
        var tr = document.createElement('tr');
        tr.className = 'row' + (node.key === selected ? ' selected' : '');

        var nameTd = document.createElement('td');
        var nameWrap = el('span', 'namewrap');
        // A guide per level rather than one wide indent: past two levels,
        // depth read off blank space is depth being measured by eye.
        for (var g = 0; g < depth; g++) nameWrap.appendChild(el('span', 'guide'));

        var hasKids = node.children.length > 0;
        var twisty = el('span', 'twisty' + (hasKids ? (open[node.key] !== false ? ' open' : '') : ' leaf'), hasKids ? '▶' : '');
        twisty.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!hasKids) return;
          open[node.key] = !(open[node.key] !== false);
          render();
        });
        nameWrap.appendChild(twisty);

        var nameBtn = el('span', 'name', node.label);
        nameWrap.appendChild(nameBtn);
        nameWrap.addEventListener('click', function (e) {
          if (e.target === twisty) return;
          selectNode(node.key);
          activeTab = 'rules';
          ruleLevelFilter = null; // clicking the concept itself means "show me everything"
          render();
          renderPanel();
        });
        nameTd.appendChild(nameWrap);
        tr.appendChild(nameTd);

        LEVELS.forEach(function (l) {
          var td = el('td', 'c clickable');
          td.appendChild(cell(node.counts[l.id], node.subtree.counts[l.id], hasKids, false));
          td.title = 'Show ' + l.label + ' rules for ' + node.label;
          td.addEventListener('click', function () {
            selectNode(node.key);
            activeTab = 'rules';
            ruleLevelFilter = l.id;
            render();
            renderPanel();
          });
          tr.appendChild(td);
        });

        var filesTd = el('td', 'c clickable');
        filesTd.appendChild(cell(node.filesNothingRuns.length, node.subtree.filesNothingRuns, hasKids, true));
        filesTd.title = 'Show files nothing runs for ' + node.label;
        filesTd.addEventListener('click', function () {
          selectNode(node.key);
          activeTab = 'files';
          render();
          renderPanel();
        });
        tr.appendChild(filesTd);

        var branchesTd = el('td', 'c clickable');
        if (node.branchesNothingTakes === null) {
          // Unknown, never 0: no coverage was run, so nothing was measured.
          branchesTd.appendChild(el('span', 'pill na', 'unknown'));
          if (hasKids && node.subtree.branchesNothingTakes !== null) {
            branchesTd.appendChild(el('span', 'subtotal', '(' + node.subtree.branchesNothingTakes + ')'));
          }
        } else {
          branchesTd.appendChild(cell(node.branchesNothingTakes.length, node.subtree.branchesNothingTakes, hasKids, true));
        }
        branchesTd.title = 'Show branches nothing takes for ' + node.label;
        branchesTd.addEventListener('click', function () {
          selectNode(node.key);
          activeTab = 'branches';
          render();
          renderPanel();
        });
        tr.appendChild(branchesTd);

        rowsEl.appendChild(tr);

        if (hasKids && open[node.key] !== false) walk(node.children, depth + 1);
      });
    })(MODEL.tree, 0);
  }

  /**
   * A row's own number, and — where it holds other rows — what the whole
   * subtree holds, beside it and visibly secondary. A holding row has nothing
   * filed against its own name, so its own number alone reads as an untested
   * part of the product, and collapsing it would hide everything under it.
   */
  function cell(own, subtree, hasKids, badWhenNonzero) {
    var wrap = el('span', 'cellwrap');
    wrap.appendChild(countPill(own, badWhenNonzero));
    // No bracket when there is no number to put in it: a level that is n/a in
    // every row beneath this one is n/a, and "(unknown)" beside it would read
    // as something nobody has measured yet.
    if (hasKids && subtree !== null) wrap.appendChild(el('span', 'subtotal', '(' + subtree + ')'));
    return wrap;
  }

  function countPill(n, badWhenNonzero) {
    if (n === null) return el('span', 'pill na', 'n/a');
    var cls = n === 0 ? 'pill zero' : badWhenNonzero ? 'pill bad' : 'pill';
    return el('span', cls, String(n));
  }

  // ---- detail panel: tabs, each filling the whole panel -------------------
  var TABS = [
    { id: 'rules', label: function (n) { return 'Rules (' + n.rules.length + ')'; } },
    { id: 'files', label: function (n) { return 'Files (' + n.filesNothingRuns.length + ')'; } },
    {
      id: 'branches',
      label: function (n) { return 'Branches (' + (n.branchesNothingTakes === null ? 'unknown' : n.branchesNothingTakes.length) + ')'; },
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
    // Where it sits, above what it is called: a name alone ('Panels') doesn't
    // say which part of the product it belongs to, and the indentation that
    // says so in the tree is gone by the time you're reading the panel.
    if (node.path.length) head.appendChild(el('div', 'p-path', node.path.join(' › ')));
    head.appendChild(el('div', 'p-name', node.label));
    // One prompt for everything this node is missing, not one button per gap —
    // the tab labels below already say how many files/branches there are, so
    // there's nothing to add here except the action itself.
    var gapPrompt = allGapsPrompt(node);
    if (gapPrompt) {
      var copyline = el('div', 'p-copyline');
      copyline.appendChild(copyPromptAction(gapPrompt, 'Copy prompt for missing tests'));
      head.appendChild(copyline);
    }
    panelEl.appendChild(head);

    var tabbar = el('div', 'tabbar');
    TABS.forEach(function (t) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab' + (activeTab === t.id ? ' active' : '');
      btn.textContent = t.label(node);
      btn.addEventListener('click', function () {
        activeTab = t.id;
        if (t.id === 'rules') ruleLevelFilter = null; // the tab itself always means "every level"
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
    if (ruleLevelFilter) {
      var chip = el('div', 'filterchip');
      chip.appendChild(document.createTextNode('Showing ' + ruleLevelFilter + ' only'));
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'filterclear';
      clear.textContent = 'Show all levels ✕';
      clear.addEventListener('click', function () {
        ruleLevelFilter = null;
        renderPanel();
      });
      chip.appendChild(clear);
      body.appendChild(chip);
    }

    var rules = ruleLevelFilter ? node.rules.filter(function (r) { return r.level === ruleLevelFilter; }) : node.rules;

    if (!rules.length) {
      body.appendChild(el('div', 'p-empty', ruleLevelFilter ? 'No ' + ruleLevelFilter + ' rules on this area.' : 'No rules found directly on this area.'));
      return;
    }

    // Grouped and ordered by LEVELS (L1, L2, L3, F1, F2, F3, Contract), not by
    // whichever order test files happened to be walked in — a level heading per
    // group is the "which is which" distinction a small badge per card wasn't.
    LEVELS.forEach(function (l) {
      var group = rules.filter(function (r) { return r.level === l.id; });
      if (!group.length) return;

      body.appendChild(el('div', 'levelhead', l.label + ' · ' + l.name + ' (' + group.length + ')'));
      var list = el('div', 'rulelist');
      group.forEach(function (r) {
        // The statement leads — it's the actual content and the visually bold
        // element, so it reads as the "title." The file:line is secondary
        // metadata below it, not the other way around.
        var card = el('div', 'rule');
        card.appendChild(el('div', 'r-text', r.statement));
        var loc = el('div', 'r-loc');
        loc.appendChild(codeToggle(r, r.file + ':' + r.line));
        card.appendChild(loc);

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
    });
  }

  function caseRow(c, isTodo) {
    // No checkmark: this tool never runs the suite, so nothing here has "passed" — a ✓ would claim
    // a fact this report cannot know. A written case is shown plainly; only "not written yet" gets
    // a visible marker, since that (a describe.todo/it.todo case) is a fact the AST does know.
    var row = el('div', 'case' + (isTodo ? ' case-todo' : ''));
    if (isTodo) row.appendChild(el('span', 'case-badge', 'not written yet'));
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
   * One prompt covering every file/branch gap this node has, not one per gap —
   * a paste target for a real agent session, not a code review in miniature.
   * No source snippet: a handful of lines (often just the file's imports)
   * isn't enough to judge whether a test is warranted, so rather than pretend
   * otherwise, this hands over the real paths and lets the reader (or the
   * agent it's pasted to) open the actual files and use judgment — same as
   * this repo's `scoping` skill already asks a person to do. Deliberately NOT
   * an LLM call from the report itself: the report stays fact-only and
   * reproducible; this is just the real gap list assembled into a shape ready
   * to hand to whoever (or whatever) does the actual reasoning and writing.
   */
  function allGapsPrompt(node) {
    var files = node.filesNothingRuns.map(function (f) { return f.file; });
    var branches = (node.branchesNothingTakes || []).map(function (b) { return b.file + ':' + b.line; });
    if (!files.length && !branches.length) return null;

    var lines = [];
    if (files.length) {
      lines.push('Tests are missing for these files in the "' + node.label + '" feature area:');
      files.forEach(function (f) { lines.push('- ' + f); });
    }
    if (branches.length) {
      if (files.length) lines.push('');
      lines.push('Tests are missing for these branches in the "' + node.label + '" feature area:');
      branches.forEach(function (b) { lines.push('- ' + b); });
    }
    lines.push('');
    lines.push(
      "Use this repo's test strategy and guidance when defining tests, to figure out which tests " +
        'may need to be added to ensure this is covered.',
    );
    return lines.join('\n');
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
    } else {
      var pre = document.createElement('pre');
      pre.className = 'codepre';
      ref.context.forEach(function (l) {
        var lineEl = el('div', 'codeline' + (l.line === ref.line ? ' target' : ''));
        lineEl.appendChild(el('span', 'codeline-no', String(l.line)));
        lineEl.appendChild(el('span', 'codeline-text', l.text));
        pre.appendChild(lineEl);
      });
      box.appendChild(pre);
    }

    return box;
  }

  /**
   * A "Copy prompt" action: hands `text` (see allGapsPrompt above) to the
   * clipboard, not an LLM call from the report itself — the report stays
   * fact-only and reproducible between runs; this just saves retyping the
   * gap list for whoever (or whatever agent) actually goes and acts on it.
   */
  function copyPromptAction(text, label) {
    var wrap = el('div', 'copywrap');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copybtn';
    btn.textContent = label || 'Copy prompt';
    var extra = null;

    btn.addEventListener('click', function () {
      if (extra) {
        extra.remove();
        extra = null;
      }
      copyToClipboard(text, function (ok) {
        extra = ok ? el('span', 'copystatus', 'Copied ✓') : renderCopyFallback(text);
        wrap.appendChild(extra);
        if (ok) setTimeout(function () { if (extra) { extra.remove(); extra = null; } }, 2500);
      });
    });

    wrap.appendChild(btn);
    return wrap;
  }

  /** Modern clipboard API only (it needs a secure context and can silently fail on a local file://
   *  page in some browsers) — `done(false)` triggers the visible-textarea fallback below rather
   *  than leaving the click looking like it did nothing. */
  function copyToClipboard(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(false); },
      );
    } else {
      done(false);
    }
  }

  function renderCopyFallback(text) {
    var wrap = el('div', 'copyfallback');
    wrap.appendChild(el('div', 'p-empty', 'Clipboard unavailable here — select the text below and copy it manually.'));
    var ta = document.createElement('textarea');
    ta.className = 'copytextarea';
    ta.readOnly = true;
    ta.value = text;
    wrap.appendChild(ta);
    ta.focus();
    ta.select();
    return wrap;
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
