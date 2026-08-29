/*
 * Browser code for the generated page. Reads window.__MODEL__ and nothing
 * else. Plain browser JS, no modules, no build step — a report that needs a
 * bundler to view is a report nobody opens.
 */
(function () {
  'use strict';

  var MODEL = window.__MODEL__;
  var COLUMNS = ['backend', 'frontend', 'browser', 'contract'];
  var BY_KEY = {};
  MODEL.concepts.forEach(function (c) { BY_KEY[c.key] = c; });

  var rowsEl = document.getElementById('rows');
  var panelEl = document.getElementById('panel');
  var selected = MODEL.concepts.length ? MODEL.concepts[0].key : null;

  function render() {
    rowsEl.textContent = '';
    MODEL.concepts.forEach(function (concept) {
      var tr = document.createElement('tr');
      tr.className = 'row' + (concept.key === selected ? ' selected' : '');

      var nameTd = document.createElement('td');
      nameTd.appendChild(el('span', 'name', concept.label));
      tr.appendChild(nameTd);

      COLUMNS.forEach(function (col) {
        var td = el('td', 'c');
        var n = concept.counts[col];
        td.appendChild(el('span', n === null ? 'pill na' : n === 0 ? 'pill zero' : 'pill', n === null ? 'n/a' : String(n)));
        tr.appendChild(td);
      });

      var filesTd = el('td', 'c');
      filesTd.appendChild(countPill(concept.filesNothingRuns.length, true));
      tr.appendChild(filesTd);

      var branchesTd = el('td', 'c');
      if (concept.branchesNothingTakes === null) {
        branchesTd.appendChild(el('span', 'pill na', 'unknown'));
      } else {
        branchesTd.appendChild(countPill(concept.branchesNothingTakes.length, true));
      }
      tr.appendChild(branchesTd);

      tr.addEventListener('click', function () {
        selected = concept.key;
        render();
        renderPanel();
      });

      rowsEl.appendChild(tr);
    });
  }

  function countPill(n, badWhenNonzero) {
    var cls = n === 0 ? 'pill zero' : badWhenNonzero ? 'pill bad' : 'pill';
    return el('span', cls, String(n));
  }

  function renderPanel() {
    var concept = BY_KEY[selected];
    panelEl.textContent = '';
    if (!concept) {
      panelEl.appendChild(el('div', 'p-empty', 'Select a row.'));
      return;
    }

    var head = el('div', 'panelhead');
    head.appendChild(el('div', 'p-name', concept.label));
    panelEl.appendChild(head);

    var rulesHead = el('div', 'p-section', 'Rules (' + concept.rules.length + ')');
    panelEl.appendChild(rulesHead);
    if (!concept.rules.length) {
      panelEl.appendChild(el('div', 'p-empty', 'No rules found for this concept.'));
    } else {
      var list = el('div', 'rulelist');
      concept.rules.forEach(function (r) {
        var row = el('div', 'rule');
        row.appendChild(el('span', 'r-level', r.column + ' / ' + r.level));
        row.appendChild(el('span', 'r-text', r.statement));
        row.appendChild(el('span', 'r-loc', r.file + ':' + r.line));
        if (r.todoCases) row.appendChild(el('span', 'r-todo', r.todoCases + ' todo'));
        list.appendChild(row);
      });
      panelEl.appendChild(list);
    }

    panelEl.appendChild(el('div', 'p-section', 'Files nothing runs (' + concept.filesNothingRuns.length + ')'));
    if (!concept.filesNothingRuns.length) {
      panelEl.appendChild(el('div', 'p-empty', 'None.'));
    } else {
      var files = el('div', 'filelist');
      concept.filesNothingRuns.forEach(function (f) { files.appendChild(el('div', 'f-item', f)); });
      panelEl.appendChild(files);
    }

    panelEl.appendChild(el('div', 'p-section', 'Branches nothing takes'));
    if (concept.branchesNothingTakes === null) {
      panelEl.appendChild(el('div', 'p-empty', 'No coverage data for this run.'));
    } else if (!concept.branchesNothingTakes.length) {
      panelEl.appendChild(el('div', 'p-empty', 'None.'));
    } else {
      var branches = el('div', 'filelist');
      concept.branchesNothingTakes.forEach(function (b) { branches.appendChild(el('div', 'f-item', b.file + ':' + b.line)); });
      panelEl.appendChild(branches);
    }
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
