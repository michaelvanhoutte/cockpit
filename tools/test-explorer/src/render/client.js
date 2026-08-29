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
          td.appendChild(countPill(node.counts[l.id], false));
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
        filesTd.appendChild(countPill(node.filesNothingRuns.length, true));
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
          branchesTd.appendChild(el('span', 'pill na', 'unknown'));
        } else {
          branchesTd.appendChild(countPill(node.branchesNothingTakes.length, true));
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

  /** A persistent, always-visible shortcut into the files/branches tabs — see panelhead above. */
  function gapChip(tabId, n, label) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gapchip' + (n === 0 ? ' clean' : n === null ? ' unknown' : '');
    chip.textContent = (n === null ? 'unknown' : n) + ' ' + label;
    chip.addEventListener('click', function () {
      activeTab = tabId;
      renderPanel();
    });
    return chip;
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
    // Always visible regardless of which tab is active — previously these two
    // counts were only visible by clicking into their own tab, easy to lose
    // track of while reading Rules.
    var gapline = el('div', 'p-gapline');
    gapline.appendChild(gapChip('files', node.filesNothingRuns.length, 'files nothing runs'));
    gapline.appendChild(
      gapChip('branches', node.branchesNothingTakes === null ? null : node.branchesNothingTakes.length, 'branches nothing takes'),
    );
    head.appendChild(gapline);
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
      row.appendChild(codeToggle(f, f.file, fileGapPrompt(node, f)));
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
      row.appendChild(codeToggle(b, b.file + ':' + b.line, branchGapPrompt(node, b)));
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  /**
   * These two build the actual text a "Copy prompt" button copies — real file,
   * line and source (from the Model, never invented) plus the feature area it
   * belongs to, framed as a ready-to-paste ask for an agent to go act on. This
   * is deliberately NOT an LLM call from the report itself: the report stays
   * fact-only and reproducible; the prompt is just real data assembled into a
   * shape that saves retyping it, for whoever (or whatever) does the writing.
   */
  function branchGapPrompt(node, ref) {
    return [
      'Add a test covering an untested branch in the "' + node.label + '" feature area.',
      '',
      'File: ' + ref.file + ':' + ref.line,
      '```',
      contextText(ref),
      '```',
      '',
      "No existing test exercises this branch. Follow this repo's testing skill/strategy:",
      '- place the test at the lowest level that can prove the behavior',
      "- name it in the product's language, not the implementation's",
      '- add it to the existing "' + node.label + '" area if this rule is a natural fit for it',
      '',
      "Verify the test actually fails before any fix and passes after, per this repo's definition of done.",
    ].join('\n');
  }

  function fileGapPrompt(node, ref) {
    return [
      'Assess whether ' + ref.file + ' needs a test (feature area: "' + node.label + '").',
      '',
      'No test in the repository imports this file directly. It may still be exercised indirectly',
      '(e.g. through an HTTP-driven integration test) — verify before assuming this is a real gap.',
      '',
      'Start of the file:',
      '```',
      contextText(ref),
      '```',
      '',
      "If it needs a test, follow this repo's testing skill/strategy: lowest level that can prove",
      'the behavior, named in product language.',
    ].join('\n');
  }

  function contextText(ref) {
    return (ref.context || []).map(function (l) { return l.text; }).join('\n');
  }

  /**
   * A clickable `label` that toggles an inline source-context viewer for `ref`
   * ({file, line, context}) open/closed — reading the surrounding source
   * without leaving the page, plus a real link (GitHub when the report knows
   * its commit, otherwise a local relative link) to open the actual file.
   * `promptText`, when given (gaps only — a rule/case already has a test, so
   * there's nothing to prompt for), adds a "Copy prompt" action.
   */
  function codeToggle(ref, label, promptText) {
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
      body = renderCodeContext(ref, promptText);
      wrap.appendChild(body);
    });

    wrap.appendChild(btn);
    return wrap;
  }

  function renderCodeContext(ref, promptText) {
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

    if (promptText) box.appendChild(copyPromptAction(promptText));

    return box;
  }

  /**
   * A "Copy prompt to write a test" action: real file/line/source assembled
   * into a ready-to-paste ask (see branchGapPrompt/fileGapPrompt above), not
   * an LLM call from the report itself — the report stays fact-only and
   * reproducible between runs; this just saves retyping the context for
   * whoever (or whatever agent) actually goes and writes the test.
   */
  function copyPromptAction(text) {
    var wrap = el('div', 'copywrap');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copybtn';
    btn.textContent = 'Copy prompt to write a test';
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
