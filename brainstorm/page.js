// The brainstorm page (brainstorm/server.js). Agent text is always set as
// text, never as HTML.
(() => {
  const KEY = new URLSearchParams(location.hash.slice(1)).get('k') || '';
  const $ = s => document.querySelector(s);
  const view = $('#view');
  let current = null, timer = null, info = null, seq = 0;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  }

  async function call(method, url, body) {
    const r = await fetch(url, { method, headers: { 'X-Brainstorm-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const type = r.headers.get('content-type') || '';
    const data = type.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error(data && data.error || `HTTP ${r.status}`);
    return data;
  }

  const PH = { setup: 'Getting ready', research: 'Research', ideas: 'Ideas', vote: 'Vote', build: 'Build', done: 'Done', failed: 'Stopped by an error', stopped: 'Stopped' };
  const ENDED = ['done', 'failed', 'stopped'];
  // A duration, short and readable: 12 s, 4.5 min, 23 min, 1 h 5 min.
  const dur = ms => {
    if (ms == null || !isFinite(ms)) return '';
    ms = Math.max(0, ms);
    if (ms < 60000) return `${Math.round(ms / 1000)} s`;
    if (ms < 600000) return `${Math.round(ms / 6000) / 10} min`;
    if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
    return `${Math.floor(ms / 3600000)} h ${Math.round(ms % 3600000 / 60000)} min`;
  };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---- Runs list ----
  async function loadRuns() {
    let list = [];
    try { list = await call('GET', '/api/runs'); } catch (e) { if (!current) view.replaceChildren(h('p', { class: 'msg' }, e.message)); return; }
    $('#runs').replaceChildren(...list.map(r => h('button', { class: 'runlink' + (current === r.id ? ' on' : ''), onclick: () => openRun(r.id) },
      r.problem.split('\n')[0].slice(0, 70), h('small', {}, h('i', { class: 'dot ' + r.phase, 'aria-hidden': 'true' }), `${PH[r.phase] || r.phase} · ${r.agents.join(', ')} · ${r.started.slice(0, 16).replace('T', ' ')}`))));
  }

  // ---- New run form ----
  async function form() {
    current = null; seq++; clearTimeout(timer); loadRuns();
    try { info = await call('GET', '/api/agents'); } catch (e) { view.replaceChildren(h('p', { class: 'msg' }, e.message)); return; }
    const saved = (() => { try { return JSON.parse(localStorage.getItem('brainstorm-form') || '{}'); } catch { return {}; } })();
    const problem = h('textarea', { id: 'problem', placeholder: 'What should the agents explore? Describe the problem, the goal, and what a good result looks like.' });
    problem.value = saved.problem || '';
    const context = h('input', { type: 'text', id: 'context', placeholder: '~/projects/my-app  or  https://github.com/owner/repo  (optional)' });
    context.value = saved.context || '';
    const boxes = info.agents.map(a => {
      const cb = h('input', { type: 'checkbox', value: a.id, disabled: !a.available });
      cb.checked = a.available && (saved.agents ? saved.agents.includes(a.id) : true);
      return h('label', { class: 'agent' + (a.available ? '' : ' off') }, cb, h('span', {}, a.label, ' ', h('small', {}, a.available ? `${a.model || 'default model'}${a.web ? ' · web' : ''}` : 'not installed')));
    });
    const num = (id, v, min, max) => { const i = h('input', { type: 'number', id, min, max }); i.value = String(v); return i; };
    const ideas = num('ideas', saved.ideas_per_agent || 3, 1, 10), top = num('top', saved.top || 2, 1, 10), mins = num('mins', saved.build_minutes || 30, 1, 180);
    const research = h('select', { id: 'research' },
      h('option', { value: 'off' }, 'No: start from the ideas'),
      h('option', { value: 'shared' }, 'Yes, and everyone reads everyone\'s findings'),
      h('option', { value: 'own' }, 'Yes, but each agent keeps its own findings'));
    research.value = saved.research || 'off';
    const instr = h('select', { id: 'instructions' }, info.instructions.map(x => h('option', { value: x.id }, x.label)));
    instr.value = info.instructions.some(x => x.id === saved.instructions) ? saved.instructions : 'claude';
    const criteria = h('textarea', { id: 'criteria', rows: '3', style: 'min-height:80px', placeholder: 'One per line, for example:\nValue for the people who will use it\nCan be built well in the time given\nOriginality' });
    criteria.value = saved.criteria || '';
    const msg = h('span', { class: 'msg' }), checkOut = h('div', { class: 'note' });
    const read = () => ({ problem: problem.value, context: context.value, agents: boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.value),
      ideas_per_agent: Number(ideas.value), top: Number(top.value), build_minutes: Number(mins.value), research: research.value, criteria: criteria.value, instructions: instr.value });
    const go = h('button', { class: 'go', onclick: async () => {
      const body = read();
      try { localStorage.setItem('brainstorm-form', JSON.stringify(body)); } catch {}
      go.disabled = true; msg.textContent = '';
      try { const { id } = await call('POST', '/api/runs', body); openRun(id); } catch (e) { msg.textContent = e.message; go.disabled = false; }
    } }, 'Start');
    const test = h('button', { onclick: async () => {
      test.disabled = true; checkOut.textContent = 'Asking each agent to read one file and write one file… (up to a few minutes)';
      try {
        const { results } = await call('POST', '/api/check', { agents: read().agents });
        checkOut.replaceChildren(...results.map(r => h('div', {}, `${r.id}: ${r.why ? '✗ ' + r.why : `✓ reads and writes${r.web ? ', and reads the web' : ''}`}`, r.tail ? h('pre', {}, r.tail) : null)));
      } catch (e) { checkOut.textContent = e.message; }
      test.disabled = false;
    } }, 'Test the agents first');
    view.replaceChildren(
      h('label', { for: 'problem' }, 'The problem ', h('small', {}, 'what you want explored')), problem,
      h('label', { for: 'context' }, 'Context ', h('small', {}, 'a folder on this computer or a git link the agents can read; they work on a copy')), context,
      h('label', {}, 'Agents ', h('small', {}, `from ${info.file}`)), h('div', { class: 'agents' }, boxes),
      h('label', { for: 'research' }, 'Research first? ', h('small', {}, 'each agent looks into the problem alone (the web where it can, read-only) and brings a few findings with sources')), research,
      h('label', { for: 'criteria' }, 'Voting criteria ', h('small', {}, 'optional: each agent scores every idea on each one, with a sentence why; leave empty for a single score with a reason')), criteria,
      h('label', { for: 'instructions' }, 'Instructions written by ', h('small', {}, 'which agent wrote the prompts for every step; add one with node brainstorm/write-prompts.js <agent>')), instr,
      h('div', { class: 'row' },
        h('div', {}, h('label', { for: 'ideas' }, 'Ideas per agent'), ideas),
        h('div', {}, h('label', { for: 'top' }, 'Ideas to carry forward'), top),
        h('div', {}, h('label', { for: 'mins' }, 'Minutes to build'), mins)),
      h('div', { class: 'actions' }, go, test, msg),
      checkOut,
      h('p', { class: 'note' }, `Each agent reads (and later edits) only a copy in the run folder: ${info.out}. Nothing is pushed or published.`));
  }

  // ---- A run ----
  // The view holds three parts: a notice line, the run (rebuilt when the state
  // changes) and the file viewer (kept as it is, so its scroll survives).
  const notice = h('p', { class: 'msg', hidden: true });
  const runRoot = h('div', { id: 'run' });
  const fileBox = h('div', { id: 'file' });
  let lastJSON = '', openFiles = [], lastSay = '';

  async function openRun(id) {
    const fresh = current !== id;
    const my = ++seq;
    current = id; clearTimeout(timer);
    if (fresh) {
      lastJSON = ''; openFiles = []; fileBox.replaceChildren();
      runRoot.replaceChildren(h('p', { class: 'note' }, 'Loading…'));
    }
    if (!view.contains(runRoot)) view.replaceChildren(notice, runRoot, fileBox);
    if (fresh) window.scrollTo(0, 0);
    loadRuns();
    let S;
    try { S = await call('GET', `/api/runs/${encodeURIComponent(id)}`); } catch (e) {
      if (my !== seq) return;
      notice.hidden = false;
      notice.textContent = fresh ? e.message : `Could not refresh (${e.message}); trying again…`;
      if (!fresh) timer = setTimeout(() => openRun(id), 4000);
      return;
    }
    if (my !== seq) return; // the reader opened something else meanwhile
    notice.hidden = true;
    const drawn = update(S);
    // Keep asking while the run goes on, or while a redraw waits for the reader's selection.
    if (!ENDED.includes(S.phase) || !drawn) timer = setTimeout(() => openRun(id), 2000);
  }

  // Redraws only when the state changed, and keeps the reader's place:
  // open/closed boxes, inner scrolls, the element at the top of the screen,
  // the keyboard focus, and any text being selected (the redraw waits).
  function update(S) {
    const json = JSON.stringify(S);
    if (json === lastJSON) return true;
    const sel = window.getSelection();
    if (lastJSON && sel && !sel.isCollapsed && sel.rangeCount && runRoot.contains(sel.getRangeAt(0).commonAncestorContainer)) return false;
    const keep = lastJSON ? capture() : null;
    render(S);
    restore(keep);
    lastJSON = json;
    tick();
    return true;
  }

  function capture() {
    const det = new Map(), sc = new Map();
    runRoot.querySelectorAll('details[data-k]').forEach(d => det.set(d.dataset.k, d.open));
    runRoot.querySelectorAll('[data-s]').forEach(e => sc.set(e.dataset.s, { top: e.scrollTop, left: e.scrollLeft, bottom: e.scrollTop + e.clientHeight >= e.scrollHeight - 4 }));
    let anchor = null;
    if (window.scrollY > 0) {
      let inner = null, below = null;
      for (const e of runRoot.querySelectorAll('[data-a]')) {
        const r = e.getBoundingClientRect();
        if (!r.height) continue;
        if (r.top < 0 && r.bottom > 0) inner = { k: e.dataset.a, top: r.top };
        else if (r.top >= 0 && !below) below = { k: e.dataset.a, top: r.top };
      }
      anchor = inner || below;
    }
    const ae = document.activeElement;
    let focus = null;
    if (ae && runRoot.contains(ae)) focus = ae.dataset.f ? 'f:' + ae.dataset.f : ae.tagName === 'SUMMARY' && ae.parentElement.dataset.k ? 'k:' + ae.parentElement.dataset.k : null;
    return { det, sc, anchor, focus };
  }

  function restore(keep) {
    if (keep) runRoot.querySelectorAll('details[data-k]').forEach(d => { if (keep.det.has(d.dataset.k)) d.open = keep.det.get(d.dataset.k); });
    runRoot.querySelectorAll('[data-s]').forEach(e => {
      const s = keep && keep.sc.get(e.dataset.s);
      if (e.hasAttribute('data-follow') && (!s || s.bottom)) e.scrollTop = e.scrollHeight;
      else if (s) { e.scrollTop = s.top; e.scrollLeft = s.left; }
    });
    if (!keep) return;
    if (keep.anchor) {
      const e = [...runRoot.querySelectorAll('[data-a]')].find(x => x.dataset.a === keep.anchor.k);
      if (e) { const d = e.getBoundingClientRect().top - keep.anchor.top; if (Math.abs(d) >= 1) window.scrollBy(0, d); }
    }
    if (keep.focus) {
      const [kind, k] = [keep.focus.slice(0, 1), keep.focus.slice(2)];
      const e = kind === 'f' ? [...runRoot.querySelectorAll('[data-f]')].find(x => x.dataset.f === k)
        : ([...runRoot.querySelectorAll('details[data-k]')].find(x => x.dataset.k === k) || {}).firstElementChild;
      if (e) e.focus({ preventScroll: true });
    }
  }

  // Clocks and time bars tick every second without redrawing anything.
  function tick() {
    const now = Date.now();
    runRoot.querySelectorAll('[data-since]').forEach(e => { e.textContent = (e.dataset.pre || '') + dur(now - Number(e.dataset.since)); });
    runRoot.querySelectorAll('[data-budget]').forEach(e => { e.style.width = Math.min(100, (now - Number(e.dataset.start)) / Number(e.dataset.budget) * 100).toFixed(1) + '%'; });
  }
  setInterval(tick, 1000);

  const label = (S, id) => (S.agents.find(a => a.id === id) || {}).label || id;
  const since = (ms, pre = '') => h('span', { 'data-since': String(ms), 'data-pre': pre }, pre + dur(Date.now() - ms));
  const jump = id => { const e = document.getElementById(id); if (e) e.scrollIntoView({ block: 'start' }); };
  const phaseNames = S => [...(S.research_mode && S.research_mode !== 'off' ? ['research'] : []), 'ideas', 'vote', 'build'];
  const clean = s => String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').trim();
  const lastLine = t => { const l = String(t || '').split('\n').map(s => s.trim()).filter(Boolean).pop() || ''; return l.length > 160 ? l.slice(0, 157) + '…' : l; };
  const firstSentence = t => { const s = clean(t).replace(/\s+/g, ' '); const m = /^.{20,220}?[.!?](\s|$)/.exec(s); return m ? m[0].trim() : s.length > 220 ? s.slice(0, 217) + '…' : s; };

  // ---- Reading the agents' fixed reply formats ----

  // Research: FINDING / SOURCE lines, then SURPRISE / SOURCE. Lines without a label continue the one before.
  function parseResearch(t) {
    const items = [];
    let cur = null, field = 'text';
    for (const raw of String(t || '').split('\n')) {
      const m = /^[\s>*_#•\-–\d.)]*(FINDING|SOURCE|SURPRISE)S?\b[\s*_]*(?:\d+\s*)?[*_]*\s*[:\-–—]\s*[*_]*\s*(.*)$/i.exec(raw);
      if (m) {
        const kind = m[1].toLowerCase();
        if (kind === 'source') { if (cur) { cur.source = cur.source ? cur.source + '; ' + m[2] : m[2]; field = 'source'; } }
        else { cur = { kind, text: m[2], source: '' }; items.push(cur); field = 'text'; }
      } else if (cur && raw.trim()) cur[field] = (cur[field] ? cur[field] + ' ' : '') + raw.trim();
    }
    return items;
  }

  // Build report: WHAT I BUILT / HOW TO SEE IT / NOT DONE, each possibly over several lines.
  function parseReport(t) {
    const out = { pre: [], built: [], how: [], not: [] }, key = { 'what i built': 'built', 'how to see it': 'how', 'not done': 'not' };
    let cur = 'pre', found = false;
    for (const line of String(t || '').split('\n')) {
      const m = /^[\s>*_#•\-\d.)]*(WHAT I BUILT|HOW TO SEE IT|NOT DONE)\b[\s*_]*(?:[:\-–—][\s*_]*(.*)|$)/i.exec(line);
      if (m) { cur = key[m[1].toLowerCase()]; found = true; if (m[2]) out[cur].push(m[2]); } else out[cur].push(line);
    }
    const j = a => clean(a.join('\n').replace(/^\n+|\s+$/g, ''));
    return { found, pre: j(out.pre), built: j(out.built), how: j(out.how), not: j(out.not) };
  }

  // A source line: shown as text; a web address in it becomes a link (http and https only).
  function src(s) {
    s = clean(s);
    if (!s) return null;
    const shown = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)');
    const u = /https?:\/\/[^\s<>()[\]"'`]+/.exec(s);
    const url = u && u[0].replace(/[.,;:]+$/, '');
    const txt = shown.length > 110 ? shown.slice(0, 107) + '…' : shown;
    return h('small', { class: 'src', title: shown }, 'Source: ', url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, txt) : txt);
  }

  // ---- Pieces of a run ----

  function stepStatus(st) {
    if (!st) return h('span', { class: 'st' }, 'waiting');
    if (st.status === 'running') return h('span', { class: 'st running' }, since(st.started, 'working… '));
    if (st.status === 'done') return h('span', { class: 'st done' }, `done in ${dur(st.ms)}${st.why ? ` (${st.why})` : ''}`);
    return h('span', { class: 'st failed' }, `failed: ${st.why}`);
  }

  // While an agent works: its last few lines, the rest one click away.
  const TAIL = 5;
  function liveBox(name, st) {
    const text = (st.live && (st.live.out || st.live.err)) || '';
    if (!text.trim()) return h('p', { class: 'note' }, 'Started; nothing printed yet.');
    const lines = text.replace(/\s+$/, '').split('\n');
    const tail = lines.slice(-TAIL).map(l => l.length > 220 ? l.slice(0, 217) + '…' : l).join('\n');
    return h('div', { class: 'live' },
      h('pre', { class: 'tail', 'aria-label': 'latest output' }, tail),
      lines.length > TAIL ? h('details', { 'data-k': 'live:' + name }, h('summary', {}, `all output so far (${lines.length} lines)`), h('pre', { 'data-s': 'live:' + name, 'data-follow': '' }, text)) : null);
  }

  function stepCard(S, name, title, body) {
    const st = S.steps[name];
    const running = st && st.status === 'running';
    return h('div', { class: 'card' + (st ? ' is-' + st.status : ''), 'data-a': name },
      h('h3', {}, h('span', {}, title), stepStatus(st)),
      running ? (body || liveBox(name, st)) : body,
      st && !running && st.live && st.live.err ? h('details', { class: 'log', 'data-k': name + ':err' }, h('summary', {}, 'what the agent printed while working'), h('pre', { 'data-s': name + ':err' }, st.live.err)) : null);
  }

  function head(S) {
    const first = S.problem.split('\n')[0];
    const R = S.research_mode && S.research_mode !== 'off';
    return h('div', { class: 'runhead', 'data-a': 'head' },
      h('div', { class: 'titlerow' },
        h('h2', { class: 'title' }, first.length > 200 ? first.slice(0, 197) + '…' : first),
        ENDED.includes(S.phase) ? null : h('button', { class: 'stop', 'data-f': 'stop', onclick: async e => {
          if (!confirm('Stop this run? Agents still working are stopped; what is done so far is kept.')) return;
          e.currentTarget.disabled = true;
          try { await call('POST', `/api/runs/${encodeURIComponent(S.id)}/stop`); } catch (err) { notice.hidden = false; notice.textContent = err.message; }
        } }, 'Stop this run')),
      h('details', { class: 'about', 'data-k': 'about' }, h('summary', {}, 'The full problem and the run settings'),
        h('div', { class: 'problem' }, S.problem),
        h('ul', { class: 'settings note' },
          h('li', {}, 'Agents: ', S.agents.map(a => a.label + (a.model ? ` (${a.model})` : '')).join(', ')),
          h('li', {}, `${S.ideas_per_agent} ideas each · ${S.top} carried forward · ${S.build_minutes} minutes to build`),
          h('li', {}, R ? `Research: ${S.research_mode === 'shared' ? 'shared with everyone' : 'each agent keeps its own'}` : 'No research step'),
          S.criteria && S.criteria.length ? h('li', {}, 'Criteria: ' + S.criteria.join('; ')) : null,
          h('li', {}, `Instructions by ${S.instructions_label || 'Claude'}`),
          h('li', {}, S.context ? 'Context: ' + S.context : 'No context'),
          h('li', {}, 'Folder: ' + S.dir))));
  }

  // ---- Progress strip ----

  // Each phase: waiting, now, past (finished) or halt (where a stopped run ended), with its agents' counts.
  function progress(S) {
    const names = phaseNames(S), ended = ENDED.includes(S.phase);
    let at = S.phase === 'done' ? names.length : names.indexOf(S.phase);
    if (at < 0 && ended) names.forEach((n, k) => { if (S.agents.some(a => S.steps[`${n}/${a.id}`])) at = k; });
    return names.map((n, k) => {
      const steps = S.agents.map(a => S.steps[`${n}/${a.id}`]).filter(Boolean);
      const c = s => steps.filter(x => x.status === s).length;
      return { n, state: k < at ? 'past' : k === at ? (ended ? 'halt' : 'now') : 'wait', done: c('done'), failed: c('failed'), running: c('running'), total: S.agents.length };
    });
  }

  const ICON = { past: '✓', now: '●', wait: '○', halt: '✕' };
  function phasePills(S, prog) {
    const sub = p => p.state === 'wait' ? 'waiting' : p.state === 'halt' ? 'stopped here'
      : `${p.done}/${p.total} done${p.failed ? ` · ${p.failed} failed` : ''}${p.state === 'now' && p.running ? ` · ${p.running} working` : ''}`;
    const pill = (cls, icon, name, small, pct, onclick, extra = {}) => h('button', { class: 'ph ' + cls, onclick, disabled: cls === 'wait', ...extra },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon), h('span', { class: 'nm' }, name), h('small', {}, small),
      pct != null ? h('i', { class: 'bar', style: `width:${pct}%` }) : null);
    return h('nav', { class: 'phases', 'aria-label': 'Progress of the run' },
      prog.map(p => pill(p.state, ICON[p.state], PH[p.n], sub(p), p.total ? Math.round((p.done + p.failed) / p.total * 100) : 0,
        () => jump('sec-' + p.n), { 'aria-current': p.state === 'now' ? 'step' : null, 'data-f': 'ph:' + p.n })),
      S.phase === 'done' ? pill('past', '✓', 'Done', 'see the result', null, () => jump('sec-results'), { 'data-f': 'ph:done' })
        : ['failed', 'stopped'].includes(S.phase) ? pill('halt', '✕', PH[S.phase], S.winners ? 'see what came out' : '', null, () => jump(S.winners ? 'sec-results' : 'sec-' + (prog.find(p => p.state === 'halt') || prog[0]).n), { 'data-f': 'ph:end' })
          : pill('wait', '○', 'Done', 'the result', null, null));
  }

  function headline(S, prog) {
    if (S.phase === 'setup') return 'Getting ready: copying the material for the agents.';
    if (S.phase === 'failed') return 'Stopped by an error' + (S.error ? ': ' + S.error : '.');
    if (S.phase === 'stopped') return 'Stopped before the end. What was done so far is below.';
    if (S.phase === 'done') {
      const built = S.builds ? Object.values(S.builds).filter(b => b.files.length).length : 0;
      return `Finished. ${plural((S.winners || []).length, 'idea')} carried forward; ${plural(built, 'agent')} built ${(S.winners || []).length > 1 ? 'them' : 'it'}.`;
    }
    const p = prog.find(x => x.state === 'now');
    const k = prog.indexOf(p);
    return p ? `Now: ${PH[p.n]} (step ${k + 1} of ${prog.length}) · ${p.done} of ${p.total} agents done` : PH[S.phase] || S.phase;
  }

  // What each agent is doing right now, in one line, with its latest output line.
  function agentRows(S, names) {
    return h('ul', { class: 'who' }, S.agents.map(a => {
      let name = null;
      for (const n of names) if (S.steps[`${n}/${a.id}`]) name = `${n}/${a.id}`;
      const st = name && S.steps[name], ph = name ? PH[name.split('/')[0]] : '';
      let state = 'wait', what, line = '', bar = null;
      if (!st) what = S.phase === 'setup' ? 'getting ready' : ENDED.includes(S.phase) ? 'did nothing' : 'waiting';
      else if (st.status === 'running') {
        state = 'running'; what = [`${ph}: working · `, since(st.started)];
        line = lastLine(st.live && (st.live.out || st.live.err));
        if (name.startsWith('build/')) {
          const budget = (S.build_minutes || 30) * 60000;
          bar = h('span', { class: 'budget', title: `${S.build_minutes} minutes to build` },
            h('i', { 'data-budget': String(budget), 'data-start': String(st.started), style: `width:${Math.min(100, (Date.now() - st.started) / budget * 100).toFixed(1)}%` }));
          what.push(` of ${S.build_minutes} min`);
        }
      } else if (st.status === 'failed') { state = 'failed'; what = `${ph}: failed (${st.why})`; }
      else {
        state = 'done';
        const behind = !ENDED.includes(S.phase) && name.split('/')[0] === S.phase;
        what = S.phase === 'done' ? `finished · ${ph.toLowerCase()} took ${dur(st.ms)}` : `${ph}: done in ${dur(st.ms)}${behind ? ' · waiting for the others' : ''}`;
      }
      return h('li', { class: state }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('b', {}, a.label), h('span', { class: 'what' }, what),
        bar, line ? h('span', { class: 'line', title: line }, line) : null);
    }));
  }

  function statusBox(S, prog) {
    const start = Date.parse(S.started), end = S.finished ? Date.parse(S.finished) : null;
    return h('div', { class: 'status', 'data-a': 'status' },
      h('p', { class: 'headline' + (S.phase === 'failed' ? ' msg' : '') }, headline(S, prog), ' ',
        h('span', { class: 'note' }, ENDED.includes(S.phase) ? (end ? `· took ${dur(end - start)}` : '') : ['· running for ', since(start)])),
      agentRows(S, prog.map(p => p.n)));
  }

  // ---- The result, near the top ----
  function results(S) {
    if (!S.winners || !S.ranking) return null;
    const ideaOf = id => (S.ideas || []).find(i => i.id === id) || {};
    const sum = (b, k) => b.files.reduce((t, f) => t + f[k], 0);
    return h('section', { class: 'sec results', id: 'sec-results', 'data-a': 'sec-results' },
      h('h2', {}, S.phase === 'done' ? 'The result' : 'Carried forward', h('span', { class: 'n' }, 'the ideas that won the vote, and what each agent built')),
      h('div', { class: 'wins' }, S.winners.map((id, k) => {
        const r = S.ranking.find(x => x.id === id) || {}, i = ideaOf(id);
        return h('div', { class: 'wincard', 'data-a': 'w:' + id },
          h('span', { class: 'num', 'aria-hidden': 'true' }, String(k + 1)),
          h('div', {}, h('b', {}, r.title || i.title || id),
            h('div', { class: 'note' }, `${r.mean == null ? 'no votes' : `average ${r.mean.toFixed(1)} from ${plural(r.n, 'vote')}`} · proposed by ${label(S, r.agent || i.agent)}`),
            i.what ? h('p', {}, i.what) : null));
      })),
      S.tie_at_cut ? h('p', { class: 'note' }, 'There was a tie at the cut: it was broken by lot.') : null,
      S.builds ? h('div', { class: 'buildsum' }, S.agents.map(a => {
        const b = S.builds[a.id], st = S.steps['build/' + a.id], rep = b && parseReport(b.report);
        const md = b && b.files.find(f => /(^|\/)BRAINSTORM\.md$/i.test(f.path));
        return h('div', { class: 'bs' }, h('b', {}, a.label), stepStatus(st),
          b ? h('span', { class: 'note' }, `${plural(b.files.length, 'file')} changed · +${sum(b, 'added')} −${sum(b, 'removed')}`) : null,
          h('button', { class: 'link', 'data-f': 'see:' + a.id, onclick: () => jump('b-' + a.id) }, 'see the build'),
          md ? h('button', { class: 'link', 'data-f': 'md:' + a.id, onclick: () => showFile(`build/${a.id}/${md.path}`) }, 'open BRAINSTORM.md') : null,
          rep && (rep.built || rep.pre) ? h('div', { class: 'teaser' }, firstSentence(rep.built || rep.pre)) : null);
      })) : null);
  }

  // ---- Research ----
  function researchBody(a, t) {
    const items = parseResearch(t), finds = items.filter(i => i.kind === 'finding'), sur = items.find(i => i.kind === 'surprise');
    const count = (t.match(/^\W*FINDING/gim) || []).length;
    const full = h('details', { class: 'raw', 'data-k': 'rf:' + a.id }, h('summary', {}, 'full text'), h('pre', { 'data-s': 'rf:' + a.id }, t));
    if (!items.length) return h('div', {}, h('details', { 'data-k': 'r:' + a.id }, h('summary', {}, `${count} findings`), h('pre', { 'data-s': 'r:' + a.id }, t)));
    return h('div', {},
      sur ? h('div', { class: 'surprise' }, h('span', { class: 'tag' }, 'Surprise'), clean(sur.text), src(sur.source)) : null,
      h('details', { class: 'findings', 'data-k': 'r:' + a.id, open: true }, h('summary', {}, `${count || finds.length} findings`),
        h('ol', { class: 'finds' }, finds.map(f => h('li', {}, clean(f.text), src(f.source))))),
      full);
  }

  // ---- Vote ----
  const scoreClass = s => s >= 7.5 ? 'hi' : s >= 5 ? 'mid' : 'lo';
  function voteCell(S, r, a, v) {
    const crit = S.criteria && S.criteria.length && v.criteria;
    const why = crit ? v.criteria.filter(Boolean).map(c => c.why).filter(Boolean).join(' / ') : v.why;
    const score = Math.round(v.score * 10) / 10;
    return h('div', { class: 'vc' },
      h('b', { class: 'score ' + scoreClass(score) }, String(score)),
      crit ? h('small', { class: 'cs', title: S.criteria.join(' · ') }, ' ' + v.criteria.map(c => c ? c.score : '–').join(' · ')) : null,
      why ? h('details', { class: 'why' + (crit ? ' crit' : ''), 'data-k': `v:${r.id}:${a.id}` },
        h('summary', { title: 'show the whole reason' }, h('span', { class: 's' }, why), h('span', { class: 'l' }, 'hide the reasons')),
        crit ? h('ul', {}, v.criteria.map((c, k) => c ? h('li', {}, h('b', {}, `${S.criteria[k]}: ${c.score}.`), ' ', c.why) : null)) : null) : null);
  }

  function voteTable(S) {
    const ideaOf = id => (S.ideas || []).find(i => i.id === id) || {};
    return h('div', { class: 'scrollx stack', 'data-s': 'votetable' },
      h('table', { class: 'vote' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Idea'), h('th', {}, 'Average'), S.agents.map(a => h('th', {}, a.label)))),
        h('tbody', {}, S.ranking.map((r, k) => {
          const win = S.winners.includes(r.id), idea = ideaOf(r.id);
          return h('tr', { class: win ? 'win' : '', 'data-a': 'v:' + r.id },
            h('td', { class: 'rank' }, String(k + 1), win ? ' ✓' : ''),
            h('td', { class: 'name' }, h('span', { class: 't' }, r.title), h('small', { class: 'by' }, 'by ' + label(S, r.agent)),
              win && idea.what ? h('div', { class: 'what' }, idea.what) : null),
            h('td', { class: 'avg', 'data-label': 'Average' }, r.mean == null ? '–'
              : h('span', {}, h('b', {}, r.mean.toFixed(1)), h('span', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.max(0, Math.min(100, r.mean * 10))}%` })), h('small', { class: 'note' }, plural(r.n, 'vote')))),
            S.agents.map(a => h('td', { class: 'sc', 'data-label': a.label }, a.id === r.agent ? h('span', { class: 'note' }, 'own idea') : r.by[a.id] ? voteCell(S, r, a, r.by[a.id]) : '–')));
        }))));
  }

  // ---- Build: one column per agent, the same rows side by side ----
  function buildGrid(S) {
    const A = S.agents;
    const sum = (b, k) => b.files.reduce((t, f) => t + f[k], 0);
    const owners = p => A.filter(a => S.builds[a.id] && S.builds[a.id].files.some(f => f.path === p)).map(a => a.id);
    const block = (key, title, text, cls = '') => text ? h('details', { class: 'blk ' + cls, 'data-k': key, open: true }, h('summary', {}, title), h('div', { class: 'txt' }, text)) : null;
    const fileLink = (text, path, f) => h('a', { role: 'button', tabindex: '0', 'data-f': 'file:' + path, onclick: () => f(),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); f(); } } }, text);
    const rows = {
      head: a => {
        const b = S.builds[a.id], st = S.steps['build/' + a.id];
        return h('div', { class: 'bh', id: 'b-' + a.id, 'data-a': 'b:' + a.id },
          h('h3', {}, h('span', {}, a.label), stepStatus(st)),
          b ? h('div', { class: 'note' }, `${plural(b.files.length, 'file')} changed · +${sum(b, 'added')} −${sum(b, 'removed')} · branch ${b.branch}`) : null);
      },
      built: a => {
        const b = S.builds[a.id], st = S.steps['build/' + a.id];
        if (st && st.status === 'running') return liveBox('build/' + a.id, st);
        if (!b) return st ? null : h('p', { class: 'note' }, 'waiting');
        const r = parseReport(b.report);
        if (!b.report) return h('p', { class: 'note' }, '(no report)');
        return r.found ? block(`b:${a.id}:built`, 'What I built', r.built || r.pre) : block(`b:${a.id}:report`, 'Report', clean(b.report));
      },
      how: a => { const b = S.builds[a.id]; return b && b.report ? block(`b:${a.id}:how`, 'How to see it', parseReport(b.report).how) : null; },
      not: a => {
        const b = S.builds[a.id], t = b && b.report ? parseReport(b.report).not : '';
        return block(`b:${a.id}:not`, 'Not done', t, /^["“]?nothing\.?["”]?\.?$/i.test(t) ? 'nothing' : 'nd');
      },
      files: a => {
        const b = S.builds[a.id];
        if (!b) return null;
        if (!b.files.length) return h('div', { class: 'files' }, h('span', { class: 'note' }, 'no files changed'));
        return h('details', { class: 'blk', 'data-k': `b:${a.id}:files`, open: true }, h('summary', {}, `Files (${b.files.length})`),
          h('div', { class: 'files' }, b.files.map(f => {
            const others = owners(f.path).filter(x => x !== a.id);
            return h('div', {}, fileLink(f.path, `build/${a.id}/${f.path}`, () => showFile(`build/${a.id}/${f.path}`)), h('small', {}, ` +${f.added} −${f.removed}`),
              others.length ? fileLink(`⇆ ${label(S, others[0])}`, `cmp:${a.id}:${f.path}`, () => showFile(null, [`build/${a.id}/${f.path}`, `build/${others[0]}/${f.path}`])) : null);
          }),
          h('div', {}, fileLink('the whole change (patch)', `patches/${a.id}.patch`, () => showFile(`patches/${a.id}.patch`)))));
      },
      more: a => {
        const b = S.builds[a.id], st = S.steps['build/' + a.id];
        if (!b && !(st && st.status !== 'running' && st.live && st.live.err)) return null;
        return h('div', { class: 'more' },
          b && b.report ? h('details', { class: 'raw', 'data-k': `b:${a.id}:full` }, h('summary', {}, 'full text of the report'), h('pre', { 'data-s': `b:${a.id}:full` }, b.report)) : null,
          st && st.status !== 'running' && st.live && st.live.err ? h('details', { class: 'log', 'data-k': `build/${a.id}:err` }, h('summary', {}, 'what the agent printed while working'), h('pre', { 'data-s': `build/${a.id}:err` }, st.live.err)) : null,
          b ? h('div', { class: 'note path' }, b.folder) : null);
      },
    };
    const names = Object.keys(rows);
    const made = names.map(n => A.map(a => rows[n](a)));
    const kept = names.map((n, k) => ({ n, cells: made[k] })).filter((r, k) => k === 0 || r.cells.some(Boolean));
    const cells = [];
    kept.forEach((r, ri) => r.cells.forEach((c, ci) => cells.push(h('div', {
      class: `cell r-${r.n}${ri === 0 ? ' first' : ''}${ri === kept.length - 1 ? ' last' : ''}`,
      style: `--o:${ci * 10 + ri}`,
    }, c))));
    return h('div', { class: 'scrollx plain', 'data-s': 'buildgrid' }, h('div', { class: 'compare', style: `--n:${A.length}` }, cells));
  }

  // ---- The whole run ----
  function render(S) {
    const R = S.research_mode && S.research_mode !== 'off';
    const prog = progress(S);
    const sec = (id, title, sub, ...kids) => h('section', { class: 'sec', id: 'sec-' + id, 'data-a': 'sec-' + id }, h('h2', {}, title, sub ? h('span', { class: 'n' }, sub) : null), kids);
    const kids = [head(S), phasePills(S, prog), statusBox(S, prog), results(S)];

    if (R) {
      kids.push(sec('research', 'Research', S.research_mode === 'shared' ? 'every agent then read everyone\'s findings, without names' : 'each agent then saw only its own findings',
        h('div', { class: 'cards' }, S.agents.map(a => {
          const t = S.research && S.research[a.id];
          return stepCard(S, `research/${a.id}`, a.label, t ? researchBody(a, t) : null);
        }))));
    }

    kids.push(sec('ideas', 'Ideas', `${S.ideas_per_agent} from each agent`, h('div', { class: 'cards' }, S.agents.map(a => {
      const mine = (S.ideas || []).filter(i => i.agent === a.id);
      const st = S.steps[`ideas/${a.id}`];
      const rankOf = id => S.ranking ? S.ranking.findIndex(r => r.id === id) : -1;
      const body = mine.length ? h('div', {}, mine.map(i => {
        const win = S.winners && S.winners.includes(i.id), k = rankOf(i.id), r = k >= 0 ? S.ranking[k] : null;
        return h('div', { class: 'idea' + (win ? ' win' : ''), 'data-a': 'i:' + i.id }, h('b', {}, i.title),
          win || r ? h('div', { class: 'meta' }, win ? h('span', { class: 'badge' }, '✓ carried forward') : null, r ? h('small', { class: 'note' }, ` #${k + 1}${r.mean != null ? ` · average ${r.mean.toFixed(1)}` : ''}`) : null) : null,
          h('p', {}, i.what), i.why ? h('p', { class: 'why' }, i.why) : null);
      }))
        : st && st.status === 'done' ? h('div', {}, h('p', { class: 'msg' }, 'No ideas could be read from the reply.'),
          h('details', { class: 'raw', 'data-k': 'ir:' + a.id }, h('summary', {}, 'full text'), h('pre', { 'data-s': 'ir:' + a.id }, st.reply || ''))) : null;
      return stepCard(S, `ideas/${a.id}`, a.label, body);
    }))));

    if (!['research', 'ideas'].includes(S.phase) && S.ideas) {
      const voted = a => S.steps[`vote/${a.id}`] && S.steps[`vote/${a.id}`].status === 'done' ? `${Object.keys(S.votes[a.id] || {}).length} of ${(S.ballots[a.id] || []).length} scores read` : null;
      kids.push(sec('vote', 'Vote', 'each agent scored the others\' ideas from 1 to 10, without names; never its own',
        S.ranking
          ? h('div', { class: 'voters' }, S.agents.map(a => {
            const st = S.steps[`vote/${a.id}`];
            return h('span', { class: st ? 'is-' + st.status : '' }, h('b', {}, a.label), ' ', st && st.status === 'failed' ? `failed: ${st.why}` : voted(a) || 'did not vote');
          }))
          : h('div', { class: 'cards' }, S.agents.map(a => stepCard(S, `vote/${a.id}`, a.label, voted(a) ? h('div', { class: 'note' }, voted(a)) : null))),
        S.ranking ? [voteTable(S), h('p', { class: 'note' }, '✓ = carried forward: every agent builds these. Click a reason to read all of it.', S.tie_at_cut ? ' There was a tie at the cut: it was broken by lot.' : '')] : null));
    }

    if (S.builds) {
      kids.push(sec('build', 'Build', `each agent alone, in its own branch, side by side · ${S.build_minutes} minutes each`, buildGrid(S)));
    }

    runRoot.replaceChildren(...kids.filter(Boolean));

    // Screen readers hear about phase changes only (a stable region, outside the redraw).
    const say = S.phase === 'done' ? 'The run is finished.' : ENDED.includes(S.phase) ? 'The run stopped.' : `Now: ${PH[S.phase] || S.phase}.`;
    if (say !== lastSay) { lastSay = say; const ann = $('#announce'); if (ann) ann.textContent = say; }
  }

  // ---- File viewer: up to two files side by side, kept across refreshes ----
  function fileLabel(p) {
    const m = /^(build|patches)\/([^/]+?)(?:\.patch)?(?:\/(.*))?$/.exec(p);
    return m ? (m[1] === 'patches' ? `${m[2]} · the whole change` : `${m[2]} · ${m[3] || ''}`) : p;
  }
  function drawFiles() {
    fileBox.replaceChildren(...(openFiles.length ? [
      h('h2', {}, 'Files', h('span', { class: 'n' }, openFiles.length === 1 ? 'open another file to see it beside this one' : 'side by side; opening a third replaces the oldest')),
      h('div', { class: 'panes' }, openFiles.map(f => f.el)),
    ] : []));
  }
  async function showFile(p, pair) {
    const run = current;
    const want = pair || [p];
    const get = q => openFiles.find(f => f.path === q) || (() => {
      const f = { path: q, pre: h('pre', {}, 'Loading…') };
      f.el = h('div', { class: 'pane' }, h('div', { class: 'bar2' }, h('b', { title: q }, fileLabel(q)),
        h('button', { onclick: () => { openFiles = openFiles.filter(x => x !== f); drawFiles(); } }, 'Close')), f.pre);
      f.load = call('GET', `/api/runs/${encodeURIComponent(run)}/file?path=${encodeURIComponent(q)}`)
        .then(t => { f.pre.textContent = t === '' ? '(empty file)' : String(t); }, e => { f.pre.replaceWith(h('p', { class: 'msg' }, e.message)); });
      return f;
    })();
    const now = want.map(get);
    openFiles = pair ? now : [...openFiles.filter(f => !now.includes(f)), ...now].slice(-2);
    drawFiles();
    fileBox.scrollIntoView({ block: 'start' });
  }

  $('#new').addEventListener('click', form);
  if (!KEY) view.replaceChildren(h('p', { class: 'msg' }, 'Open the link the app printed when it started (it carries the key).'));
  else form();
})();
