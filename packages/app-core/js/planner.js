// js/planner.js
// Study blocks, hour estimates, progress, and focus.
//
// The unit is one hour: fifty minutes of work and a ten-minute break. The break
// is part of the block, not a reward for finishing it — attention degrades well
// before sixty minutes, and a planner that pretends otherwise just teaches
// people that they are bad at studying.
//
// Everything is stored locally. Nothing here needs an account, and nothing here
// is gated: someone who cannot afford Pro should still be able to plan their
// week.

const APP = () => (typeof window !== "undefined" && window.BH_APP_ID) || "app";
const KEY = () => `bh.plan.${APP()}`;

const WORK_MINUTES = 50;
const BREAK_MINUTES = 10;

/* Per-item timings, mirroring scripts/estimate-hours.mjs. Kept in seconds so
   the arithmetic below reads the way the estimate is actually reasoned about. */
const T = {
  termFirstRead: 90, termRepetition: 15, termRepetitions: 5,
  questionFirst: 165, questionRedo: 90, redoShare: 0.40,
  examSimItems: 150, examSimPace: 84, examSims: 2,
};

/* ---------------- the estimate ---------------- */

/** Hours of work this app's content represents, broken down by activity. */
export function estimate() {
  const data = (typeof window !== "undefined" && window.DATA) || { cards: [], questions: [] };
  const terms = (data.cards || []).length;
  const questions = data.meta?.total ?? (data.questions || []).length;

  const parts = {
    glossary: terms * T.termFirstRead,
    drills:   terms * T.termRepetition * T.termRepetitions,
    practice: questions * T.questionFirst + questions * T.redoShare * T.questionRedo,
    exams:    T.examSims * Math.min(T.examSimItems, questions) * T.examSimPace,
  };
  const totalSeconds = Object.values(parts).reduce((a, b) => a + b, 0);

  const asHours = s => Math.round(s / 3600 * 2) / 2;
  return {
    terms, questions,
    hours: asHours(totalSeconds),
    blocks: Math.max(1, Math.ceil(totalSeconds / 3600)),
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, asHours(v)])),
    partsSeconds: parts,
  };
}

/* ---------------- stored state ---------------- */

const EMPTY = { sessions: [], target: null, startedAt: null };

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY()) || "null");
    if (!v || !Array.isArray(v.sessions)) return { ...EMPTY };
    return { ...EMPTY, ...v };
  } catch { return { ...EMPTY }; }
}
function save(state) {
  try { localStorage.setItem(KEY(), JSON.stringify(state)); } catch { /* private mode */ }
}

export function state() { return read(); }

/** Set an exam date so the plan can say how many blocks a week that means. */
export function setTarget(isoDate) {
  const s = read();
  s.target = isoDate || null;
  if (!s.startedAt) s.startedAt = new Date().toISOString();
  save(s);
  return s;
}

/* ---------------- progress ---------------- */

export function progress() {
  const s = read();
  const est = estimate();
  const done = s.sessions.filter(x => x.minutes > 0);
  const minutes = done.reduce((a, x) => a + x.minutes, 0);
  const blocksDone = done.filter(x => x.minutes >= WORK_MINUTES * 0.8).length;

  const byActivity = {};
  for (const x of done) byActivity[x.activity] = (byActivity[x.activity] || 0) + x.minutes;

  let daysLeft = null, blocksPerWeek = null;
  if (s.target) {
    const ms = new Date(s.target).getTime() - Date.now();
    daysLeft = Math.max(0, Math.ceil(ms / 86400000));
    const remaining = Math.max(0, est.blocks - blocksDone);
    if (daysLeft > 0) blocksPerWeek = Math.ceil(remaining / (daysLeft / 7));
  }

  return {
    minutes, hours: Math.round(minutes / 6) / 10,
    blocksDone, blocksTotal: est.blocks,
    percent: Math.min(100, Math.round(minutes / (est.hours * 60) * 100)) || 0,
    byActivity, daysLeft, blocksPerWeek,
    streak: streak(done),
    estimate: est,
  };
}

/** Consecutive days ending today or yesterday, so one missed evening is not a failure. */
function streak(sessions) {
  const days = new Set(sessions.map(s => new Date(s.at).toDateString()));
  let n = 0;
  const d = new Date();
  if (!days.has(d.toDateString())) d.setDate(d.getDate() - 1);
  while (days.has(d.toDateString())) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---------------- what to do next ---------------- */

const ACTIVITIES = {
  glossary: { label: "Glossary", how: "Read new terms and say each definition back before you look." },
  drills:   { label: "Drills",   how: "Recall first, reveal second. Rate honestly — an inflated 'knew it' costs you later." },
  practice: { label: "Practice", how: "Answer, then read the rationale even when you were right. Name the principle being tested." },
  exams:    { label: "Exam simulation", how: "Full length, timed, no interruptions. This is stamina practice as much as knowledge." },
};

/** The next block's plan: whichever activity is furthest behind its share. */
export function nextBlock() {
  const p = progress();
  const est = p.estimate;
  const order = ["glossary", "drills", "practice", "exams"];

  let pick = "glossary", worst = -Infinity;
  for (const key of order) {
    const target = est.parts[key] * 60;              // minutes this activity deserves
    if (target <= 0) continue;
    const done = p.byActivity[key] || 0;
    const deficit = (target - done) / target;        // proportion still outstanding
    // Exams come last: simulating before the content is learned teaches despair.
    const gate = key === "exams" && p.percent < 55;
    if (!gate && deficit > worst) { worst = deficit; pick = key; }
  }

  const est_remaining = Math.max(0, est.parts[pick] * 60 - (p.byActivity[pick] || 0));
  return {
    activity: pick,
    ...ACTIVITIES[pick],
    workMinutes: WORK_MINUTES,
    breakMinutes: BREAK_MINUTES,
    remainingMinutes: Math.round(est_remaining),
  };
}

/* ---------------- sessions ---------------- */

export function startBlock(activity) {
  const s = read();
  if (!s.startedAt) s.startedAt = new Date().toISOString();
  s.open = { activity: activity || nextBlock().activity, at: new Date().toISOString() };
  save(s);
  return s.open;
}

export function openBlock() { return read().open || null; }

export function cancelBlock() {
  const s = read();
  delete s.open;
  save(s);
}

/**
 * Close the current block.
 * @param {number} minutes  minutes actually worked
 * @param {number} focus    1–5, self-rated
 * @param {string[]} distractions  tags from DISTRACTIONS
 */
export function endBlock(minutes, focus, distractions = []) {
  const s = read();
  const open = s.open;
  if (!open) return null;
  const entry = {
    at: open.at,
    activity: open.activity,
    minutes: Math.max(0, Math.round(minutes)),
    focus: Math.min(5, Math.max(1, Math.round(focus || 3))),
    distractions: distractions.slice(0, 6),
  };
  s.sessions.push(entry);
  delete s.open;
  save(s);
  return entry;
}

export const DISTRACTIONS = [
  { id: "phone",    label: "Phone" },
  { id: "tv",       label: "TV or music with words" },
  { id: "people",   label: "People around me" },
  { id: "tired",    label: "Too tired" },
  { id: "worry",    label: "Mind elsewhere" },
  { id: "toomuch",  label: "Too much on my plate" },
];

/* ---------------- tips ---------------- */

/* Thirty of them. Each carries the reason it works, because a tip you
   understand is one you will actually keep. `when` decides when it surfaces;
   tips with no `when` are general and rotate. */
export const TIPS = [
  // --- environment ---
  { id: 1, tag: "Environment", tip: "Turn the television off, not down.",
    why: "Speech and moving images compete for the exact channels you are reading with. Background noise with words costs comprehension even when you stop noticing it.",
    when: s => s.distraction("tv") },
  { id: 2, tag: "Environment", tip: "Silence the phone and put it in another room.",
    why: "Face-down on the desk is not enough. Being within reach measurably occupies attention, because part of you is still deciding not to check it.",
    when: s => s.distraction("phone") },
  { id: 3, tag: "Environment", tip: "Study somewhere you are not interruptible for the full fifty minutes.",
    why: "An interruption costs far more than the seconds it takes. Rebuilding the thread you were holding is the expensive part.",
    when: s => s.distraction("people") },
  { id: 4, tag: "Environment", tip: "Tell the people you live with the hour you will be unavailable.",
    why: "Most interruptions are not urgent, they are simply unaware. A stated time converts them into a queue." },
  { id: 5, tag: "Environment", tip: "If you need sound, use something without words.",
    why: "Lyrics recruit language processing, which is the same equipment you are reading with. Instrumental or steady noise does not." },
  { id: 6, tag: "Environment", tip: "Keep one surface clear and use only that.",
    why: "Visible clutter is a queue of unfinished decisions, and each one takes a small piece of working memory." },
  { id: 7, tag: "Environment", tip: "Study in the same place at the same time.",
    why: "Consistency turns starting into a habit rather than a decision. Deciding is the part people fail at, not studying." },

  // --- attention and load ---
  { id: 8, tag: "Attention", tip: "Before you start, write down what is on your mind and set it aside.",
    why: "An unresolved worry keeps re-presenting itself for attention. Writing it down is enough to stop the loop, because you are no longer at risk of forgetting it.",
    when: s => s.distraction("worry") },
  { id: 9, tag: "Attention", tip: "You may be carrying too much at once. Consider putting one thing down.",
    why: "Working memory is a fixed budget. Several live commitments each take a slice before you have studied a single term — the fix is fewer things, not more discipline.",
    when: s => s.distraction("toomuch") },
  { id: 10, tag: "Attention", tip: "One subject per block. Do not mix study with anything else.",
    why: "Task switching has a real cost, and it lands hardest on exactly the deliberate thinking these questions require." },
  { id: 11, tag: "Attention", tip: "Close every tab that is not this one.",
    why: "An open tab is an open intention. You do not have to click it for it to cost you." },
  { id: 12, tag: "Attention", tip: "If your focus rating keeps landing at 2, shorten the block rather than repeating it.",
    why: "Thirty attentive minutes beat fifty distracted ones, and the shorter block is one you will come back to.",
    when: s => s.avgFocus > 0 && s.avgFocus < 2.6 },
  { id: 13, tag: "Attention", tip: "Start with the hardest thing while the attention is fresh.",
    why: "Attention is spent, not restored, across a session. Easy work at the start buys nothing and costs the good minutes." },
  { id: 14, tag: "Attention", tip: "Take the ten-minute break away from a screen.",
    why: "The break is what makes the next block possible. Spending it scrolling gives your attention no recovery at all." },

  // --- technique ---
  { id: 15, tag: "Technique", tip: "Say the definition out loud before revealing it.",
    why: "Retrieving is what builds the memory. Reading a definition again feels productive and is close to worthless by comparison." },
  { id: 16, tag: "Technique", tip: "Rate yourself honestly on drills.",
    why: "Marking a shaky term as known removes it from the rotation exactly when you needed it most. The system is only as good as the honesty going in." },
  { id: 17, tag: "Technique", tip: "Read the rationale even when you answered correctly.",
    why: "Being right for the wrong reason is invisible until the exam changes the wording. The rationale names the principle." },
  { id: 18, tag: "Technique", tip: "Say why each wrong option is wrong.",
    why: "Exams are written so that distractors are attractive. Naming the flaw is what stops the same trap working twice." },
  { id: 19, tag: "Technique", tip: "Space repetition out rather than massing it.",
    why: "The same total minutes spread across days produce substantially more retention than one long sitting. The forgetting between sessions is doing the work." },
  { id: 20, tag: "Technique", tip: "Mix topics within a block once you know the basics.",
    why: "Studying one topic in a run feels smoother and retains worse. Interleaving forces you to choose the approach, which is what the exam asks." },
  { id: 21, tag: "Technique", tip: "Do a timed full-length simulation before exam week, not during it.",
    why: "A simulation is stamina practice. Finding out you fade at item ninety is only useful while there is still time to train it." },
  { id: 22, tag: "Technique", tip: "Keep a list of the terms you miss twice, and study that list separately.",
    why: "The items you repeatedly miss are a small set doing most of the damage, and they respond to being singled out." },
  { id: 23, tag: "Technique", tip: "Teach a hard concept to someone, or to an empty room.",
    why: "Explaining exposes the gaps that recognition hides. The stumble is the point, not a sign you wasted the effort." },

  // --- body ---
  { id: 24, tag: "Body", tip: "Do not study through real tiredness. Sleep and take the block tomorrow.",
    why: "Consolidation happens during sleep. Studying on empty writes badly and takes the hours from where the memory is actually formed.",
    when: s => s.distraction("tired") },
  { id: 25, tag: "Body", tip: "Protect sleep in the week before the exam above extra revision.",
    why: "A rested brain retrieves what it already knows. A tired one cannot reach material it genuinely learned." },
  { id: 26, tag: "Body", tip: "Drink water and eat before a long block.",
    why: "Deliberate reasoning is metabolically expensive. Mild dehydration and low blood sugar both show up as being unable to concentrate." },
  { id: 27, tag: "Body", tip: "Move for a few minutes between blocks.",
    why: "Short physical activity reliably improves attention on the task that follows. It is the cheapest intervention available." },

  // --- mind ---
  { id: 28, tag: "Mind", tip: "Judge the week by blocks completed, not by how you felt.",
    why: "Feeling behind is not evidence of being behind. Counted blocks are, and they are the only number that predicts readiness." },
  { id: 29, tag: "Mind", tip: "A missed day is a missed day. Do not write off the week.",
    why: "Most plans die from the response to a slip rather than the slip. Resume at the next block and leave it there." },
  { id: 30, tag: "Mind", tip: "Do not compare your hours to anyone else's.",
    why: "You are studying against the exam, not against a classmate. Their pace tells you nothing about what you still need." },
];

/** Tips worth showing right now, most relevant first. */
export function tips(limit = 3) {
  const s = read();
  // Every recent block counts here, including the short ones. A block cut to
  // five minutes because the television was on is the strongest signal there
  // is — filtering it out for being short would discard exactly the report the
  // advice exists to answer.
  const recent = s.sessions.slice(-6);
  const done = s.sessions.filter(x => x.minutes > 0);

  const counts = {};
  for (const x of recent) for (const d of x.distractions || []) counts[d] = (counts[d] || 0) + 1;
  const avgFocus = recent.length
    ? recent.reduce((a, x) => a + (x.focus || 0), 0) / recent.length : 0;

  const ctx = {
    avgFocus,
    sessions: done.length,
    distraction: id => (counts[id] || 0) >= (recent.length >= 4 ? 2 : 1),
  };

  const triggered = TIPS.filter(t => t.when && safe(t.when, ctx));
  if (triggered.length >= limit) return triggered.slice(0, limit);

  // Fill the rest with general tips, rotating by session count so the same
  // three do not greet someone every evening.
  const general = TIPS.filter(t => !t.when);
  const start = (done.length * 2) % general.length;
  const rotated = [...general.slice(start), ...general.slice(0, start)];
  return [...triggered, ...rotated].slice(0, limit);
}

function safe(fn, ctx) { try { return !!fn(ctx); } catch { return false; } }

/** Everything the UI needs in one call. */
export function summary() {
  return { estimate: estimate(), progress: progress(), next: nextBlock(), tips: tips(3) };
}

export const CONSTANTS = { WORK_MINUTES, BREAK_MINUTES, ACTIVITIES };
