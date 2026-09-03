// js/content.js
// The paid question bank: fetching it, and filling in the answer key as the
// reader earns it.
//
// The bundle ships the glossary and a small sample set. Everything else arrives
// here, without `answer`, `why` or `label` — those come back from the server
// only for items the reader has actually answered. So the objects the app holds
// start incomplete and get patched in place, which keeps every existing
// `picked === q.answer` comparison working once a verdict is due.
//
// Fetched questions and revealed answers are cached, so a set already worked
// through stays available offline. A set that has never been fetched needs a
// connection to start — that is the cost of not shipping the bank to everyone.

import { getClient, getUser } from "./supabase-client.js";

const FN = "content";
const CACHE_KEY = () => `bh.bank.${APP()}`;
const APP = () => (typeof window !== "undefined" && window.BH_APP_ID) || "app";

let _loaded = false;
let _loading = null;

export function isLoaded() { return _loaded; }

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY()) || "null"); }
  catch { return null; }
}
function writeCache(payload) {
  try { localStorage.setItem(CACHE_KEY(), JSON.stringify(payload)); }
  catch { /* private mode, or full: the bank simply will not persist */ }
}

/** Merge questions into window.DATA.questions without duplicating ids. */
function merge(questions) {
  const data = window.DATA || (window.DATA = { cards: [], questions: [] });
  const byId = new Map(data.questions.map(q => [q.id, q]));
  for (const q of questions) {
    const existing = byId.get(q.id);
    if (existing) {
      // Never let a keyless copy overwrite an answer already revealed.
      for (const [k, v] of Object.entries(q)) {
        if (existing[k] === undefined || existing[k] === null) existing[k] = v;
      }
    } else {
      data.questions.push(q);
      byId.set(q.id, q);
    }
  }
  return data.questions.length;
}

async function invoke(body) {
  const client = getClient();
  if (!client) throw new Error("The full bank needs a connection.");
  const { data: s } = await client.auth.getSession();
  const token = s?.session?.access_token;
  if (!token) throw new Error("Sign in to load the full question bank.");

  const { data, error } = await client.functions.invoke(FN, {
    body, headers: { Authorization: `Bearer ${token}` },
  });
  if (error) {
    let detail = "";
    try { detail = (await error.context?.json())?.error || ""; } catch { /* ignore */ }
    throw new Error(detail || "Could not reach the question bank.");
  }
  return data;
}

/**
 * Load the paid bank into window.DATA. Resolves to the number of questions
 * available. Safe to call repeatedly; concurrent calls share one request.
 */
export function loadBank({ force = false } = {}) {
  if (_loaded && !force) return Promise.resolve((window.DATA?.questions || []).length);
  if (_loading) return _loading;

  _loading = (async () => {
    // Cached first: it makes a previously loaded bank work with no connection.
    const cached = readCache();
    if (cached?.questions?.length) {
      merge(cached.questions);
      _loaded = true;
    }

    if (!getUser()) {
      // Signed out. Whatever was cached still stands; nothing new to fetch.
      if (!cached) throw new Error("Sign in to load the full question bank.");
      return (window.DATA.questions || []).length;
    }

    try {
      const res = await invoke({ action: "bank", app: APP() });
      const questions = res?.questions || [];
      merge(questions);
      // Merge into the cache so revealed answers already stored are not lost.
      const keep = new Map((cached?.questions || []).map(q => [q.id, q]));
      for (const q of questions) keep.set(q.id, { ...keep.get(q.id), ...q });
      writeCache({ at: Date.now(), questions: [...keep.values()] });
      _loaded = true;
    } catch (err) {
      if (!_loaded) throw err;    // nothing cached to fall back on
      console.warn("bank refresh failed, using cache:", err);
    }
    return (window.DATA.questions || []).length;
  })().finally(() => { _loading = null; });

  return _loading;
}

/**
 * Reveal the answers for items the reader has answered.
 * @param {Object} answers  { [questionId]: chosenIndex }
 * Patches window.DATA in place and returns the raw results.
 */
export async function grade(answers) {
  const ids = Object.keys(answers || {});
  if (!ids.length) return [];

  // Anything already revealed (from cache) needs no round trip.
  const data = window.DATA || { questions: [] };
  const byId = new Map(data.questions.map(q => [q.id, q]));
  const missing = {};
  for (const id of ids) {
    const q = byId.get(id);
    if (!q || q.answer === undefined || q.answer === null) missing[id] = answers[id];
  }
  if (!Object.keys(missing).length) return [];

  const res = await invoke({ action: "grade", app: APP(), answers: missing });
  const results = res?.results || [];

  for (const r of results) {
    const q = byId.get(r.id);
    if (!q) continue;
    q.answer = r.answer;
    if (r.why !== null && r.why !== undefined) q.why = r.why;
    if (r.label !== null && r.label !== undefined) q.label = r.label;
  }

  // Persist the revealed key so a reviewed set reads offline.
  const cached = readCache() || { questions: [] };
  const keep = new Map(cached.questions.map(q => [q.id, q]));
  for (const r of results) {
    const q = byId.get(r.id);
    if (q) keep.set(q.id, q);
  }
  writeCache({ at: Date.now(), questions: [...keep.values()] });

  return results;
}

/** True when an item still has no answer key locally. */
export function needsGrading(q) {
  return !q || q.answer === undefined || q.answer === null;
}
