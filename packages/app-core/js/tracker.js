// js/tracker.js
// Records every answer locally and syncs to Supabase when online.
// Offline-first: localStorage is the source of truth, Supabase is the sync target.

import { getClient, getUser } from "./supabase-client.js";

const QUEUE_KEY = "cb.syncQueue";
const HISTORY_KEY = "cb.history";

// ---- local storage helpers ----

function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
  catch { return []; }
}
function setQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {}
}
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}
function pushHistory(r) {
  const h = getHistory();
  h.push(r);
  // keep last 2000 locally
  if (h.length > 2000) h.splice(0, h.length - 2000);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {}
}

// ---- public API ----

/**
 * Record a single response.
 * @param {object} r - { item_id, category, correct, answer_idx, time_ms }
 */
export function record(r) {
  const row = {
    item_id: r.item_id,
    category: r.category,
    correct: r.correct,
    answer_idx: r.answer_idx,
    time_ms: r.time_ms || null,
    created_at: new Date().toISOString(),
  };
  pushHistory(row);

  if (getUser()) {
    const queue = getQueue();
    queue.push(row);
    setQueue(queue);
    // fire and forget
    flush().catch(() => {});
  }
}

/**
 * Record a completed session.
 */
export async function recordSession(s) {
  const user = getUser();
  if (!user) return;
  const client = getClient();
  if (!client) return;
  try {
    await client.from("study_sessions").insert({
      user_id: user.id,
      length: s.length,
      correct: s.correct,
      total: s.total,
      config: s.config || {},
      started_at: s.started_at,
      finished_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("session record failed:", e);
  }
}

/**
 * Flush the sync queue to Supabase.
 * Called automatically on record(), and can be called manually.
 */
export async function flush() {
  const user = getUser();
  const client = getClient();
  if (!user || !client) return;

  const queue = getQueue();
  if (!queue.length) return;

  // batch insert (Supabase handles up to 1000 rows)
  const rows = queue.map((r) => ({ ...r, user_id: user.id }));
  const { error } = await client.from("responses").insert(rows);

  if (!error) {
    setQueue([]);
  } else {
    console.warn("sync failed, will retry:", error.message);
  }
}

/**
 * On first sign-in, upload any localStorage history that predates the account.
 * Called once after auth, then never again.
 */
export async function backfillHistory() {
  const user = getUser();
  const client = getClient();
  if (!user || !client) return;

  const h = getHistory();
  if (!h.length) return;

  // check if user already has responses (i.e. this isn't a first sync)
  const { count } = await client
    .from("responses")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);

  if (count > 0) return; // already has data, skip backfill

  const rows = h.map((r) => ({ ...r, user_id: user.id }));
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    await client.from("responses").insert(rows.slice(i, i + batchSize));
  }
}

// ---- local analytics (works without auth) ----

/**
 * Returns per-category stats from localStorage history.
 * Used for recommendations when offline or not logged in.
 */
export function localStats() {
  const h = getHistory();
  const cats = {};
  h.forEach((r) => {
    const c = cats[r.category] || { total: 0, correct: 0 };
    c.total++;
    if (r.correct) c.correct++;
    cats[r.category] = c;
  });
  return Object.entries(cats).map(([category, v]) => ({
    category,
    total: v.total,
    correct: v.correct,
    accuracy: v.total ? v.correct / v.total : 0,
  }));
}

/**
 * Returns item-level miss data from localStorage.
 */
export function localWeakItems() {
  const h = getHistory();
  const items = {};
  h.forEach((r) => {
    const it = items[r.item_id] || { item_id: r.item_id, category: r.category, attempts: 0, misses: 0 };
    it.attempts++;
    if (!r.correct) it.misses++;
    items[r.item_id] = it;
  });
  return Object.values(items)
    .filter((x) => x.misses > 0)
    .map((x) => ({ ...x, miss_rate: x.misses / x.attempts }))
    .sort((a, b) => b.miss_rate - a.miss_rate);
}

// ---- auto-sync on reconnect ----
if (typeof window !== "undefined") {
  window.addEventListener("online", () => flush().catch(() => {}));
}
