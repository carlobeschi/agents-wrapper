// The brainstorm page (brainstorm/server.js). Agent text is always set as
// text, never as HTML.
(() => {
  const KEY = new URLSearchParams(location.hash.slice(1)).get('k') || '';
  const $ = s => document.querySelector(s);
  const view = $('#view');
  let current = null, timer = null, info = null;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
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
  const ago = ms => ms == null ? '' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`;

  // ---- Runs list ----
  async function loadRuns() {
    let list = [];
    try { list = await call('GET', '/api/runs'); } catch (e) { view.replaceChildren(h('p', { class: 'msg' }, e.message)); return; }
    $('#runs').replaceChildren(...list.map(r => h('button', { class: 'runlink' + (current === r.id ? ' on' : ''), onclick: () => openRun(r.id) },
      r.problem.split('\n')[0].slice(0, 70), h('small', {}, `${PH[r.phase] || r.phase} · ${r.agents.join(', ')} · ${r.started.slice(0, 16).replace('T', ' ')}`))));
  }

  // ---- New run form ----
  async function form() {
    current = null; clearTimeout(timer); loadRuns();
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
    const criteria = h('textarea', { id: 'criteria', rows: '3', style: 'min-height:80px', placeholder: 'One per line, for example:\nValue for the people who will use it\nCan be built well in the time given\nOriginality' });
    criteria.value = saved.criteria || '';
    const msg = h('span', { class: 'msg' }), checkOut = h('div', { class: 'note' });
    const read = () => ({ problem: problem.value, context: context.value, agents: boxes.map(b => b.querySelector('input')).filter(i => i.checked).map(i => i.value),
      ideas_per_agent: Number(ideas.value), top: Number(top.value), build_minutes: Number(mins.value), research: research.value, criteria: criteria.value });
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
      h('div', { class: 'row' },
        h('div', {}, h('label', { for: 'ideas' }, 'Ideas per agent'), ideas),
        h('div', {}, h('label', { for: 'top' }, 'Ideas to carry forward'), top),
        h('div', {}, h('label', { for: 'mins' }, 'Minutes to build'), mins)),
      h('div', { class: 'actions' }, go, test, msg),
      checkOut,
      h('p', { class: 'note' }, `Each agent reads (and later edits) only a copy in the run folder: ${info.out}. Nothing is pushed or published.`));
  }

  // ---- A run ----
  async function openRun(id) {
    if (current !== id) { const f = document.getElementById('file'); if (f) f.remove(); }
    current = id; clearTimeout(timer);
    let S;
    try { S = await call('GET', `/api/runs/${encodeURIComponent(id)}`); } catch (e) { view.replaceChildren(h('p', { class: 'msg' }, e.message)); return; }
    const scroll = window.scrollY;
    const open = new Set([...view.querySelectorAll('details[open]')].map(d => d.dataset.k));
    render(S);
    view.querySelectorAll('details').forEach(d => { if (open.has(d.dataset.k)) d.open = true; });
    window.scrollTo(0, scroll);
    loadRuns();
    if (!['done', 'failed', 'stopped'].includes(S.phase)) timer = setTimeout(() => openRun(id), 2000);
  }

  const label = (S, id) => (S.agents.find(a => a.id === id) || {}).label || id;

  function stepCard(S, name, title, body) {
    const st = S.steps[name];
    const status = !st ? 'waiting' : st.status === 'running' ? `working… ${ago(Date.now() - st.started)}` : st.status === 'done' ? `done in ${ago(st.ms)}` : `failed: ${st.why}`;
    const live = st && st.status === 'running' ? (st.live.out || st.live.err) : '';
    return h('div', { class: 'card' },
      h('h3', {}, title, h('span', { class: 'st ' + (st ? st.status : '') }, status)),
      body || (live ? h('pre', {}, live.slice(-2500)) : null),
      st && st.status !== 'running' && st.live && st.live.err ? h('details', { 'data-k': name + ':err' }, h('summary', {}, 'what the agent printed while working'), h('pre', {}, st.live.err)) : null);
  }

  // One agent's vote on one idea: the score, then why (per criterion when there are criteria).
  function voteCell(S, v) {
    const crit = S.criteria && S.criteria.length && v.criteria;
    return h('div', {}, h('b', {}, String(Math.round(v.score * 10) / 10)),
      crit ? v.criteria.map((c, k) => c ? h('div', { class: 'why' }, `${S.criteria[k]}: ${c.score}. ${c.why}`) : null)
        : v.why ? h('div', { class: 'why' }, v.why) : null);
  }

  function render(S) {
    const R = S.research_mode && S.research_mode !== 'off';
    const names = [...(S.research_mode && S.research_mode !== 'off' ? ['Research'] : []), 'Ideas', 'Vote', 'Build', 'Done'];
    const at = S.phase === 'done' ? names.length - 1 : names.map(n => n.toLowerCase()).indexOf(S.phase);
    const kids = [
      h('div', { class: 'phases' }, names.map((p, k) => h('span', { class: 'ph' + (k < at || S.phase === 'done' ? ' past' : k === at ? ' now' : '') }, p)),
        ['failed', 'stopped'].includes(S.phase) ? h('span', { class: 'ph now' }, PH[S.phase]) : null),
      S.error ? h('p', { class: 'msg' }, S.error) : null,
      h('div', { class: 'problem' }, S.problem),
      h('p', { class: 'note' }, `${S.agents.map(a => a.label + (a.model ? ` (${a.model})` : '')).join(', ')} · ${S.ideas_per_agent} ideas each · ${S.top} carried forward · ${R ? 'research ' + S.research_mode + ' · ' : ''}${S.criteria && S.criteria.length ? 'criteria: ' + S.criteria.join('; ') + ' · ' : ''}${S.context ? 'context: ' + S.context : 'no context'} · folder: ${S.dir}`),
      ['done', 'failed', 'stopped'].includes(S.phase) ? null : h('button', { onclick: async () => { await call('POST', `/api/runs/${encodeURIComponent(S.id)}/stop`); } }, 'Stop this run'),
    ];

    // Research
    if (R) {
      kids.push(h('h2', {}, '0. Research'), h('p', { class: 'note' }, S.research_mode === 'shared' ? 'Every agent then read everyone\'s findings, without names.' : 'Each agent then saw only its own findings.'));
      kids.push(h('div', { class: 'cards' }, S.agents.map(a => {
        const t = S.research && S.research[a.id];
        return stepCard(S, `research/${a.id}`, a.label, t ? h('details', { 'data-k': 'r:' + a.id }, h('summary', {}, `${(t.match(/^\W*FINDING/gim) || []).length} findings`), h('pre', {}, t)) : null);
      })));
    }

    // Ideas
    kids.push(h('h2', {}, '1. Ideas'), h('div', { class: 'cards' }, S.agents.map(a => {
      const mine = (S.ideas || []).filter(i => i.agent === a.id);
      const st = S.steps[`ideas/${a.id}`];
      const body = mine.length ? h('div', {}, mine.map(i => h('div', { class: 'idea' }, h('b', {}, i.title), i.what, ' ', h('span', { class: 'why' }, i.why))))
        : st && st.status === 'done' ? h('div', {}, h('p', { class: 'msg' }, 'No ideas could be read from the reply:'), h('pre', {}, st.reply || '')) : null;
      return stepCard(S, `ideas/${a.id}`, a.label, body);
    })));

    // Vote
    if (!['research', 'ideas'].includes(S.phase) && S.ideas) {
      kids.push(h('h2', {}, '2. Vote'), h('p', { class: 'note' }, 'Each agent scored the others\' ideas from 1 to 10, without names, in its own order. It never saw its own.'));
      kids.push(h('div', { class: 'cards' }, S.agents.map(a => stepCard(S, `vote/${a.id}`, a.label, S.steps[`vote/${a.id}`] && S.steps[`vote/${a.id}`].status === 'done' ? h('div', { class: 'note' }, `${Object.keys(S.votes[a.id] || {}).length} of ${(S.ballots[a.id] || []).length} scores read`) : null))));
      if (S.ranking) {
        kids.push(h('table', {},
          h('tr', {}, h('th', {}, '#'), h('th', {}, 'Idea'), h('th', {}, 'By'), h('th', {}, 'Average'), S.agents.map(a => h('th', {}, a.label))),
          S.ranking.map((r, k) => h('tr', { class: S.winners.includes(r.id) ? 'win' : '' },
            h('td', {}, String(k + 1), S.winners.includes(r.id) ? ' ✓' : ''), h('td', {}, r.title), h('td', {}, label(S, r.agent)),
            h('td', {}, r.mean == null ? '–' : r.mean.toFixed(1)),
            S.agents.map(a => h('td', {}, a.id === r.agent ? 'own' : r.by[a.id] ? voteCell(S, r.by[a.id]) : '–'))))));
        kids.push(h('p', { class: 'note' }, '✓ = carried forward: every agent builds these.', S.tie_at_cut ? ' There was a tie at the cut: it was broken by lot.' : ''));
      }
    }

    // Build
    if (S.builds) {
      kids.push(h('h2', {}, '3. Build'), h('p', { class: 'note' }, `Each agent worked alone, in its own branch (brainstorm/<agent>) of a copy, in ${S.dir}/build/.`));
      kids.push(h('div', { class: 'cards' }, S.agents.map(a => {
        const b = S.builds[a.id];
        const body = b ? h('div', {},
          h('pre', {}, b.report || '(no report)'),
          h('div', { class: 'files' }, b.files.length ? b.files.map(f => h('div', {}, h('a', { onclick: () => showFile(S, `build/${a.id}/${f.path}`) }, f.path), ` +${f.added} −${f.removed}`)) : h('span', { class: 'note' }, 'no files changed')),
          b.files.length ? h('div', { class: 'files' }, h('a', { onclick: () => showFile(S, `patches/${a.id}.patch`) }, 'the whole change (patch)')) : null,
          h('div', { class: 'note' }, b.folder)) : null;
        return stepCard(S, `build/${a.id}`, a.label, body);
      })));
    }
    kids.push(document.getElementById('file') || h('div', { id: 'file' }));
    view.replaceChildren(...kids.filter(Boolean));
  }

  async function showFile(S, p) {
    const box = $('#file');
    try {
      const text = await call('GET', `/api/runs/${encodeURIComponent(S.id)}/file?path=${encodeURIComponent(p)}`);
      box.replaceChildren(h('h2', {}, p), h('pre', { style: 'max-height:600px' }, text));
      box.scrollIntoView({ behavior: 'smooth' });
    } catch (e) { box.replaceChildren(h('p', { class: 'msg' }, e.message)); }
  }

  $('#new').addEventListener('click', form);
  if (!KEY) view.replaceChildren(h('p', { class: 'msg' }, 'Open the link the app printed when it started (it carries the key).'));
  else form();
})();
