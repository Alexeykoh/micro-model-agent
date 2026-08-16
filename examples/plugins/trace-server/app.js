(function () {
  'use strict';
  var log = document.getElementById('log');
  var countEl = document.getElementById('count');
  var empty = log.querySelector('.empty');

  var GROUP = {
    tool_start: 'tool', tool_end: 'tool',
    llm_start: 'llm', llm_end: 'llm',
    text: 'text', meta: 'meta',
    phase: 'phase', error: 'err', system: 'sys',
    context: 'ctx', compaction: 'ctx'
  };
  var CLASS = {
    tool_start: 't-tool', tool_end: 't-done',
    llm_start: 't-llm', llm_end: 't-llm',
    text: 't-text', meta: 't-meta',
    phase: 't-phase', error: 't-err', system: 't-sys',
    context: 't-ctx', compaction: 't-ctx'
  };
  var active = { tool: true, llm: true, text: true, meta: true, phase: true, err: true, sys: true, ctx: true };
  var searchTerm = '';
  var paused = false;
  var stick = true;
  var total = 0;
  var openTools = {}; // toolCallId -> row element
  var openLlm = null; // in-flight llm_start row
  var deferred = [];
  var startTs = Date.now();
  var thinkStart = null;
  var ctxTextEl = document.getElementById('ctxText');
  var ctxDeltaEl = document.getElementById('ctxDelta');
  var ctxHistoryEl = document.getElementById('ctxHistory');
  var ctxStatsEl = document.getElementById('ctxStats');
  var plansActiveEl = document.getElementById('plansActive');
  var plansAllEl = document.getElementById('plansAll');
  var plansHistEl = document.getElementById('plansHist');
  var lastCtxLines = []; // per-line map from previous context_text for diffing
  var ctxHistCount = 0;

  function fmtMs(ms) {
    if (ms === undefined || ms === null) return '';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  // side tabs
  var tabs = document.querySelectorAll('.side-tab');
  var panes = document.querySelectorAll('.pane');
  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      var name = t.getAttribute('data-tab');
      tabs.forEach(function (x) { x.classList.toggle('on', x === t); });
      panes.forEach(function (p) { p.classList.toggle('on', p.id === 'pane-' + name); });
    });
  });

  // chips
  var chips = document.querySelectorAll('.chip');
  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      var g = c.getAttribute('data-g');
      active[g] = !active[g];
      c.classList.toggle('on', active[g]);
      apply();
    });
  });

  document.getElementById('search').addEventListener('input', function (e) {
    searchTerm = e.target.value.toLowerCase();
    apply();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      document.getElementById('search').focus();
    }
  });

  document.getElementById('pause').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? 'Продолжить' : 'Пауза';
    this.classList.toggle('active', paused);
    var note = document.getElementById('pausedNote');
    if (paused) {
      note.textContent = 'пауза · буферизация';
      note.style.display = 'block';
    } else {
      note.style.display = 'none';
      if (deferred.length) {
        deferred.forEach(function (f) { f(); });
        deferred = [];
      }
      apply();
    }
  });

  document.getElementById('clear').addEventListener('click', function () {
    log.innerHTML = '';
    empty = null;
    openTools = {};
    openLlm = null;
    total = 0;
    countEl.textContent = '0 событий';
  });

  document.getElementById('autoscroll').addEventListener('click', function () {
    stick = !stick;
    this.classList.toggle('active', !stick);
    if (stick) scrollBottom();
  });

  log.addEventListener('scroll', function () {
    if (log.scrollTop + log.clientHeight >= log.scrollHeight - 60) stick = true;
  });

  function now() {
    var d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) { return (n < 10 ? '0' : '') + n; }).join(':');
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function entry(type, tagText, titleEl, body, iter) {
    var e = el('div', 'entry ' + (CLASS[type] || type));
    e.dataset.type = type;
    e.dataset.g = GROUP[type] || type;
    var head = el('div', 'head');
    head.appendChild(el('span', 't', now()));
    head.appendChild(el('span', 'tag', tagText));
    if (iter !== undefined && iter !== null) head.appendChild(el('span', 'iter', '#' + iter));
    if (titleEl) head.appendChild(titleEl);
    e.appendChild(head);
    if (body) e.appendChild(body);
    return e;
  }

  function openDetails(summaryText, preText, cls) {
    var det = el('details');
    det.setAttribute('open', '');
    det.appendChild(el('summary', '', summaryText));
    det.appendChild(el('pre', cls, preText));
    return det;
  }

  function toolStart(e) {
    var body = el('div');
    body.appendChild(el('div', 'title', '▶ ' + e.name));
    if (e.summary) body.appendChild(el('div', 'summary', e.summary));
    if (e.args) body.appendChild(openDetails('аргументы', e.args));
    return entry('tool_start', 'ИНСТР', null, body, e.iteration);
  }

  function toolEnd(e) {
    var row = openTools[e.toolCallId];
    if (row) {
      delete openTools[e.toolCallId];
      var title = row.querySelector('.title');
      var ok = e.success;
      if (title) title.textContent = (ok ? '✓ ' : '✗ ') + e.name + ' · ' + fmtMs(e.durationMs);
      row.classList.toggle('fail', !ok);
      var body = row.querySelector('.body') || el('div', 'body');
      var res = el('div', 'result ' + (ok ? 'ok' : 'bad'),
        (ok ? 'УСПЕХ' : 'ОШИБКА') + ' · ' + fmtMs(e.durationMs) + (e.iteration !== undefined ? ' · итер #' + e.iteration : ''));
      body.appendChild(res);
      if (e.output) body.appendChild(openDetails('вывод', e.output));
      row.appendChild(body);
      return null;
    }
    var b = el('div', 'body');
    b.appendChild(el('div', 'title', (e.success ? '✓ ' : '✗ ') + e.name + ' · ' + fmtMs(e.durationMs)));
    if (e.output) b.appendChild(openDetails('вывод', e.output));
    var row2 = entry('tool_end', 'ГОТОВО', null, b, e.iteration);
    row2.classList.toggle('fail', !e.success);
    return row2;
  }

  function llmStart(e) {
    var title = el('span', 'title');
    title.appendChild(el('span', 'mini-spin'));
    title.appendChild(document.createTextNode(' Вызов LLM…'));
    var row = entry('llm_start', 'LLM', title, null, e.iteration);
    if (e.task) {
      var body = el('div', 'body dim');
      body.appendChild(el('div', 'summary', 'задача: ' + e.task));
      row.appendChild(body);
    }
    openLlm = row;
    return row;
  }

  function llmEnd(e) {
    var t = '✓ LLM';
    var dur = fmtMs(e.durationMs);
    if (dur) t += ' · ' + dur;
    if (e.kind) t += ' · ' + e.kind;
    if (e.callCount) t += ' · ' + e.callCount + ' вызов(ов)';
    if (e.callNames && e.callNames.length) t += ': ' + e.callNames.join(', ');
    var row = openLlm;
    if (row) {
      openLlm = null;
      var title = row.querySelector('.title');
      if (title) title.textContent = t;
      if (e.callNames && e.callNames.length) {
        var b = row.querySelector('.body') || el('div', 'body');
        b.appendChild(el('div', 'summary', '→ ' + e.callNames.join(', ')));
        row.appendChild(b);
      }
      return null;
    }
    return entry('llm_end', 'LLM', el('span', 'title', t), null, e.iteration);
  }

  function phaseRow(e) {
    var on = e.phase === 'thinking';
    if (on) thinkStart = Date.now();
    else thinkStart = null;
    setThinking(on);
    var title = el('span', 'title', on ? '● думает…' : '○ готово');
    return entry('phase', 'ФАЗА', title, null, e.iteration);
  }

  function errRow(e) {
    var title = el('span', 'title', '✖ ' + e.message);
    var body = null;
    if (e.stack) {
      body = el('div');
      body.appendChild(openDetails('стек', e.stack));
    }
    return entry('error', 'ОШИБКА', title, body, e.iteration);
  }

  function textRow(e) {
    var body = el('div', 'body' + (e.type === 'meta' ? ' dim' : ''), e.text);
    return entry(e.type, e.type === 'meta' ? 'МЕТА' : 'ТЕКСТ', null, body, e.iteration);
  }

  function sysRow(e) {
    return entry('system', 'СИСТЕМА', el('span', 'title', e.message));
  }

  function compRow(e) {
    var title = el('span', 'title', '⟳ Сжатие #' + e.compactionCount);
    var body = el('div', 'body');
    var before = e.tokensBefore || 0;
    var after = e.tokensAfter || 0;
    var removed = before - after;
    body.appendChild(el('div', 'result ' + (removed > 0 ? 'ok' : 'bad'),
      'токены: ' + before + ' → ' + after + (removed !== 0 ? ' (−' + removed + ')' : '') +
      ' · качество: ' + e.qualityBefore + '% → ' + e.qualityAfter + '%'));
    var budget = e.budgetHistory || 0;
    if (budget) body.appendChild(el('div', 'summary', 'бюджет истории: ' + budget));
    return entry('compaction', 'КОНТЕКСТ', title, body, e.iteration);
  }

  function updateCtxBar(e) {
    var fill = document.getElementById('ctxFill');
    var thresh = document.getElementById('ctxThresh');
    var info = document.getElementById('ctxInfo');
    var budget = e.budget || {};
    var history = budget.history || 0;
    var pct = history ? Math.min(100, Math.round((e.tokens / history) * 100)) : 0;
    fill.style.width = pct + '%';
    fill.className = 'ctx-fill' + (pct >= 90 ? ' hot' : pct >= 75 ? ' warn' : '');
    thresh.style.left = '75%';
    var qCls = e.quality >= 70 ? 'q-ok' : e.quality >= 40 ? 'q-warn' : 'q-bad';
    var since = e.iterationsSinceCompaction !== undefined ? e.iterationsSinceCompaction : 0;
    info.innerHTML =
      '<span>ctx: <b>' + e.tokens + '/' + history + '</b> (' + pct + '%)</span>' +
      '<span>качество: <b class="' + qCls + '">' + e.quality + '%</b></span>' +
      '<span>сжатий: <b>' + e.compactionCount + '</b></span>' +
      '<span>с тех пор: <b>' + since + '</b></span>' +
      '<span>сообщ.: <b>' + e.messageCount + '</b></span>';
  }

  var RENDER = {
    tool_start: toolStart,
    tool_end: toolEnd,
    llm_start: llmStart,
    llm_end: llmEnd,
    phase: phaseRow,
    error: errRow,
    text: textRow,
    meta: textRow,
    system: sysRow,
    compaction: compRow
  };

  function fmtK(n) {
    if (n === undefined || n === null) return '?';
    return n >= 10000 ? (n / 1000).toFixed(0) + 'K' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  }

  // ---- right panel: context text + diff + history ----

  function renderContext(e) {
    ctxStatsEl.textContent =
      fmtK(e.tokens) + ' ток · q ' + e.quality + '% · ' + e.messageCount + ' сообщ.';
    var lines = e.text.split('\n');
    ctxTextEl.textContent = e.text;
    ctxTextEl.scrollTop = ctxTextEl.scrollHeight;

    // diff against the previous snapshot (line-count based, cheap)
    var added = [];
    var removed = [];
    var prevCount = {};
    var curCount = {};
    lastCtxLines.forEach(function (l) { prevCount[l] = (prevCount[l] || 0) + 1; });
    lines.forEach(function (l) { curCount[l] = (curCount[l] || 0) + 1; });
    Object.keys(curCount).forEach(function (l) {
      var p = prevCount[l] || 0;
      for (var i = p; i < curCount[l]; i++) added.push(l);
    });
    Object.keys(prevCount).forEach(function (l) {
      var c = curCount[l] || 0;
      for (var i = c; i < prevCount[l]; i++) removed.push(l);
    });
    if (added.length > 0 || removed.length > 0) {
      ctxDeltaEl.innerHTML = '';
      removed.slice(-30).forEach(function (l) { ctxDeltaEl.appendChild(el('div', 'del', '− ' + l)); });
      added.slice(-30).forEach(function (l) { ctxDeltaEl.appendChild(el('div', 'add', '+ ' + l)); });
    } else {
      ctxDeltaEl.innerHTML = '';
    }
    lastCtxLines = lines;
  }

  function addCtxHistory(e) {
    var isComp = e.type === 'compaction';
    var row = el('div', 'ctxhist-row' + (isComp ? ' comp' : ''));
    var hdr = el('div', 'hdr');
    hdr.appendChild(el('span', '', now()));
    hdr.appendChild(document.createTextNode(' · '));
    hdr.appendChild(el('b', '', isComp ? 'сжатие #' + e.compactionCount : 'итер ' + (e.iteration ?? '') + ' → ' + fmtK(e.tokens) + ' ток'));
    hdr.appendChild(document.createTextNode(' · q ' + e.quality + '% · ' + e.messageCount + ' сообщ.'));
    row.appendChild(hdr);
    if (isComp) {
      var prev = el('div', 'prev');
      prev.appendChild(document.createTextNode('удалено ' + fmtK(e.tokensBefore) + ' → ' + fmtK(e.tokensAfter) + ' ток (было q ' + e.qualityBefore + '%)'));
      row.appendChild(prev);
    }
    ctxHistoryEl.insertBefore(row, ctxHistoryEl.firstChild);
    ctxHistCount++;
    while (ctxHistoryEl.children.length > 60) ctxHistoryEl.removeChild(ctxHistoryEl.lastChild);
  }

  function planRowHtml(p, label) {
    var steps = (p.steps || []).map(function (s) {
      var icon = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'skipped' ? '−' : '○';
      var subs = (s.subtasks || []).map(function (st) { return '    ' + (st.done ? '✓' : '○') + ' ' + st.text; }).join('\n');
      return icon + ' ' + s.description + (s.kind === 'delete' ? ' [delete]' : '') + (subs ? '\n' + subs : '');
    }).join('\n');
    var done = (p.steps || []).filter(function (s) { return s.status === 'done'; }).length;
    return { steps: steps, done: done, total: (p.steps || []).length, title: p.title || 'План без названия' };
  }

  function planBlock(r, tagText) {
    var blk = el('div', 'plan-block');
    var head = el('div', 'phead');
    head.appendChild(el('span', '', r.title));
    head.appendChild(el('span', 'pmeta', tagText + ' · ' + r.done + '/' + r.total));
    blk.appendChild(head);
    var pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
    var bar = el('div', 'pbar');
    var fill = el('i');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    blk.appendChild(bar);
    blk.appendChild(el('div', '', r.steps || '(нет шагов)'));
    return blk;
  }

  function renderPlans(e) {
    // active
    plansActiveEl.innerHTML = '';
    if (e.active) {
      plansActiveEl.appendChild(planBlock(planRowHtml(e.active), 'активен'));
    } else {
      plansActiveEl.appendChild(el('div', 'plan-block', '(нет активного плана)'));
    }
    // all plans (drafts + archived)
    plansAllEl.innerHTML = '';
    var others = (e.drafts || []).map(function (p) { return { p: p, tag: 'черновик' }; })
      .concat((e.archived || []).map(function (p) { return { p: p, tag: 'архив' }; }));
    if (others.length === 0) {
      plansAllEl.appendChild(el('div', 'plan-block', '(нет)'));
    } else {
      others.forEach(function (o) {
        plansAllEl.appendChild(planBlock(planRowHtml(o.p), o.tag));
      });
    }
    // history feed
    plansHistEl.innerHTML = '';
    (e.history || []).forEach(function (h) {
      var row = el('div', 'phist-row');
      row.appendChild(el('span', 't', new Date(h.ts).toLocaleTimeString()));
      row.appendChild(document.createTextNode('  '));
      row.appendChild(el('b', '', h.kind));
      row.appendChild(document.createTextNode(' · ' + h.detail));
      plansHistEl.appendChild(row);
    });
  }

  function handle(evt) {
    if (evt.type === 'session') {
      startTs = evt.connectedAt || Date.now();
      var s = evt.session;
      var sess = document.getElementById('session');
      if (s && (s.name || s.model || s.id)) {
        var parts = [];
        if (s.name) parts.push(s.name);
        if (s.model) parts.push(s.model);
        if (s.id) parts.push(s.id);
        sess.innerHTML = 'сессия: <b>' + escapeHtml(parts.join(' · ')) + '</b>';
      }
      return;
    }
    if (evt.type === 'context') {
      updateCtxBar(evt);
      return;
    }
    if (evt.type === 'context_text') {
      renderContext(evt);
      addCtxHistory(evt);
      return;
    }
    if (evt.type === 'compaction') {
      addCtxHistory(evt);
    }
    if (evt.type === 'plans') {
      renderPlans(evt);
      return;
    }
    if (RENDER[evt.type]) {
      var row = RENDER[evt.type](evt);
      if (evt.type === 'tool_start' && evt.toolCallId) {
        openTools[evt.toolCallId] = row;
      }
      append(row);
    }
  }

  function setThinking(on) {
    document.getElementById('think').classList.toggle('on', on);
  }

  // header thinking elapsed ticker
  setInterval(function () {
    var thinkEl = document.getElementById('thinkTxt');
    if (thinkStart) {
      var sec = (Date.now() - thinkStart) / 1000;
      thinkEl.textContent = 'думает · ' + sec.toFixed(1) + 's';
    } else {
      thinkEl.textContent = 'думает…';
    }
  }, 100);

  function scrollBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function apply() {
    var nodes = log.children;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.dataset || !n.dataset.g) continue;
      var visible = active[n.dataset.g] !== false;
      if (visible && searchTerm) {
        visible = (n.textContent || '').toLowerCase().indexOf(searchTerm) !== -1;
      }
      n.style.display = visible ? '' : 'none';
    }
  }

  function append(row) {
    if (!row) return;
    if (empty) { empty.remove(); empty = null; }
    if (paused) {
      deferred.push(function () { log.appendChild(row); });
      return;
    }
    log.appendChild(row);
    total++;
    countEl.textContent = total + ' событий';
    if (stick) scrollBottom();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // elapsed timer
  setInterval(function () {
    var sec = Math.floor((Date.now() - startTs) / 1000);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    document.getElementById('elapsed').textContent =
      (h ? h + 'h ' : '') + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }, 1000);

  // SSE
  function connect() {
    var es = new EventSource('/events');
    var status = document.getElementById('status');
    var dot = document.getElementById('dot');

    es.onopen = function () {
      status.textContent = 'онлайн';
      status.className = 'live';
      dot.className = 'dot live';
    };
    es.onerror = function () {
      status.textContent = 'переподключение…';
      status.className = 'bad';
      dot.className = 'dot dead';
    };
    es.addEventListener('session', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('system', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('tool_start', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('tool_end', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('llm_start', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('llm_end', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('phase', function (e) { handle(JSON.parse(e.data)); });
    // NB: error is also a built-in EventSource event (connection failures,
    // which carry no data). Guard so those can't blow up the parser.
    es.addEventListener('error', function (e) { if (e.data) handle(JSON.parse(e.data)); });
    es.addEventListener('text', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('meta', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('context', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('context_text', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('compaction', function (e) { handle(JSON.parse(e.data)); });
    es.addEventListener('plans', function (e) { handle(JSON.parse(e.data)); });
  }

  connect();
})();