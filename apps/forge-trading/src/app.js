/* Forge Trading — drills for supervising a paper-trading agent.
   No accounts, no network after first load. Progress stays on this device. */

const STORE_KEY = 'forge-trading:v1';
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const k of kids) n.append(k?.nodeType ? k : document.createTextNode(k ?? ''));
  return n;
};
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

let bank = null;
let state = load();

function load() {
  try { return Object.assign({ terms: {}, say: {}, scen: {}, filter: 'all' }, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
  catch { return { terms: {}, say: {}, scen: {}, filter: 'all' }; }
}
function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); updateRuler(); }

/* ---------- boot ---------- */
fetch('bank.json').then(r => r.json()).then(b => {
  bank = b;
  $('#bank-meta').textContent = `${b.terms.length} terms · ${b.scenarios.length} scenarios · reviewed ${b.reviewed}`;
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.view)));
  show(location.hash.slice(1) || 'terms');
  updateRuler();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}).catch(() => { $('#bank-meta').textContent = 'Bank failed to load. Reload the page.'; });

function show(view) {
  document.querySelectorAll('.view').forEach(v => v.hidden = true);
  document.querySelectorAll('.tab').forEach(t => t.dataset.view === view ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current'));
  const target = $('#view-' + view);
  target.hidden = false;
  target.replaceChildren();
  ({ terms: renderTerms, say: renderSay, scenarios: renderScenarios, progress: renderProgress })[view](target);
  history.replaceState(null, '', '#' + view);
}

function sectionSelect(onchange) {
  const s = el('select', { 'aria-label': 'Section', onchange: e => { state.filter = e.target.value; save(); onchange(); } },
    el('option', { value: 'all' }, 'All sections'),
    ...bank.sections.map(x => el('option', { value: x.key }, `${x.key}. ${x.name}`)));
  s.value = state.filter;
  return s;
}
const inFilter = x => state.filter === 'all' || x.section === state.filter;

/* ---------- Terms: flashcards ---------- */
function renderTerms(root) {
  const pool = bank.terms.filter(inFilter);
  const known = id => state.terms[id] === 'known';
  const queue = shuffle(pool.filter(t => !known(t.id)).concat(pool.filter(t => known(t.id))));
  let i = 0, flipped = false;

  const card = el('div', { class: 'card', tabindex: '0', role: 'button', 'aria-label': 'Flashcard, activate to flip',
    onclick: flip, onkeydown: e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } } });
  const count = el('span', { class: 'tally num' });
  const again = el('button', { class: 'btn quiet', onclick: () => mark('again') }, 'Again');
  const got = el('button', { class: 'btn', onclick: () => mark('known') }, 'Know it');

  root.append(
    el('div', { class: 'row' }, sectionSelect(() => show('terms')), count),
    card,
    el('div', { class: 'actions' }, again, got));
  draw();

  function draw() {
    const t = queue[i];
    count.textContent = `${i + 1} / ${queue.length}`;
    card.replaceChildren(
      el('div', { class: 'id num' }, `${t.id} · ${t.sectionName}`),
      flipped ? el('div', { class: 'def' }, t.def) : el('div', { class: 'term' }, t.term),
      el('div', { class: 'hint' }, flipped ? 'Mark it, then the next card loads.' : 'Tap to see the definition.'));
    again.disabled = got.disabled = !flipped;
  }
  function flip() { flipped = !flipped; draw(); }
  function mark(v) { state.terms[queue[i].id] = v; save(); i = (i + 1) % queue.length; flipped = false; draw(); }
}

/* ---------- Say it: typed articulation ---------- */
function renderSay(root) {
  const pool = bank.terms.filter(inFilter);
  // lowest box first, then oldest
  const box = id => state.say[id]?.box ?? 0;
  const queue = pool.slice().sort((a, b) => box(a.id) - box(b.id) || (state.say[a.id]?.at ?? 0) - (state.say[b.id]?.at ?? 0));
  let i = 0;

  const prompt = el('h2');
  const ta = el('textarea', { placeholder: 'Explain it as if a new hire asked you.', 'aria-label': 'Your explanation' });
  const ref = el('div', { class: 'reference' });
  const reveal = el('button', { class: 'btn', onclick: () => { ref.hidden = false; grade.hidden = false; reveal.hidden = true; } }, 'Compare with reference');
  const grade = el('div', { class: 'grade' },
    el('button', { class: 'btn danger', onclick: () => rate(0) }, 'Missed it'),
    el('button', { class: 'btn quiet', onclick: () => rate(1) }, 'Close'),
    el('button', { class: 'btn', onclick: () => rate(2) }, 'Nailed it'));
  const count = el('span', { class: 'tally num' });

  root.append(
    el('div', { class: 'row' }, sectionSelect(() => show('say')), count),
    prompt,
    el('p', { class: 'empty' }, 'Type the definition in your own words, then compare.'),
    ta, el('div', { class: 'actions' }, reveal), ref, grade);
  draw();

  function draw() {
    const t = queue[i];
    count.textContent = `${i + 1} / ${queue.length}`;
    prompt.textContent = t.term;
    ta.value = ''; ref.textContent = t.def;
    ref.hidden = true; grade.hidden = true; reveal.hidden = false;
    ta.focus();
  }
  function rate(score) {
    const id = queue[i].id;
    const cur = box(id);
    state.say[id] = { box: score === 2 ? Math.min(cur + 1, 3) : score === 1 ? cur : 0, at: Date.now() };
    save();
    i = (i + 1) % queue.length; draw();
  }
}

/* ---------- Scenarios ---------- */
function renderScenarios(root) {
  const pool = shuffle(bank.scenarios.filter(inFilter));
  let i = 0, right = 0, answered = 0;

  const tally = el('div', { class: 'tally num' });
  const stem = el('p', { class: 'stem' });
  const idLine = el('div', { class: 'id num tally' });
  const choices = el('div', { class: 'choices', role: 'group', 'aria-label': 'Answer choices' });
  const rationale = el('div', { class: 'rationale' });
  const next = el('button', { class: 'btn', onclick: () => { i = (i + 1) % pool.length; draw(); } }, 'Next scenario');

  root.append(el('div', { class: 'row' }, sectionSelect(() => show('scenarios')), tally), idLine, stem, choices, rationale, el('div', { class: 'actions' }, next));
  draw();

  function draw() {
    const s = pool[i];
    tally.textContent = answered ? `${right} / ${answered} correct` : `${pool.length} in this set`;
    idLine.textContent = `${s.id} · ${s.sectionName}`;
    stem.textContent = s.stem;
    rationale.hidden = true; next.hidden = true;
    choices.replaceChildren(...s.options.map((o, k) =>
      el('button', { class: 'choice', onclick: () => answer(k) }, el('span', { class: 'letter' }, 'ABCD'[k]), el('span', {}, o))));
  }
  function answer(k) {
    const s = pool[i];
    const ok = k === s.answer;
    answered++; if (ok) right++;
    const hist = state.scen[s.id] || { seen: 0, right: 0 };
    state.scen[s.id] = { seen: hist.seen + 1, right: hist.right + (ok ? 1 : 0) };
    save();
    [...choices.children].forEach((c, j) => {
      c.disabled = true;
      if (j === s.answer) c.dataset.state = 'right';
      else if (j === k) c.dataset.state = 'wrong';
    });
    rationale.className = 'rationale' + (ok ? '' : ' miss');
    rationale.textContent = (ok ? 'Correct. ' : `The answer is ${'ABCD'[s.answer]}. `) + s.rationale;
    rationale.hidden = false; next.hidden = false;
    tally.textContent = `${right} / ${answered} correct`;
    next.focus();
  }
}

/* ---------- Progress ---------- */
function renderProgress(root) {
  const list = el('ul', { class: 'prog' });
  for (const sec of bank.sections) {
    const terms = bank.terms.filter(t => t.section === sec.key);
    const known = terms.filter(t => state.terms[t.id] === 'known').length;
    const said = terms.filter(t => (state.say[t.id]?.box ?? 0) >= 2).length;
    const scen = bank.scenarios.filter(s => s.section === sec.key);
    const seen = scen.filter(s => state.scen[s.id]);
    const acc = seen.length ? Math.round(100 * seen.reduce((a, s) => a + state.scen[s.id].right / state.scen[s.id].seen, 0) / seen.length) : null;
    const pct = Math.round(100 * (known + said) / (2 * terms.length));
    list.append(el('li', {},
      el('span', { class: 'label' }, `${sec.key}. ${sec.name}`),
      el('span', { class: 'pct num' }, `${pct}% terms · ${acc === null ? 'no scenarios yet' : acc + '% scenario accuracy'}`),
      el('div', { class: 'bar' }, el('span', { style: `width:${pct}%` }))));
  }
  root.append(
    el('h2', {}, 'Where you stand'),
    el('p', { class: 'empty' }, 'Term mastery counts a card marked known plus a typed explanation you rated "nailed it".'),
    list,
    el('button', { class: 'btn danger', onclick: () => { if (confirm('Clear all progress on this device?')) { state = { terms: {}, say: {}, scen: {}, filter: 'all' }; save(); show('progress'); } } }, 'Clear progress'));
}

function updateRuler() {
  if (!bank) return;
  const n = bank.terms.length;
  const done = bank.terms.filter(t => state.terms[t.id] === 'known' || (state.say[t.id]?.box ?? 0) >= 2).length;
  $('#ruler-fill').style.width = `${Math.round(100 * done / n)}%`;
}
