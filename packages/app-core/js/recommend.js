// js/recommend.js
// Adaptive recommendation engine.
// Uses a combination of:
//   1. Category accuracy (study your weakest area)
//   2. Item difficulty (harder items need more reps)
//   3. Recency (don't repeat items you just saw)
//   4. Spaced repetition (items you missed come back sooner)

import { getClient, getUser } from "./supabase-client.js";
import { localStats, localWeakItems } from "./tracker.js";

/**
 * Build a recommended study set.
 *
 * @param {Array} allQuestions - DATA.questions from the app
 * @param {number} n - how many items to select
 * @param {object} opts - { useServer: bool }
 * @returns {Promise<{ questions: Array, reason: string }>}
 */
export async function recommend(allQuestions, n, opts = {}) {
  let catStats, weakItems, itemDiff;

  if (opts.useServer && getUser() && getClient()) {
    try {
      const client = getClient();
      const [cs, wi, id] = await Promise.all([
        client.rpc("my_category_stats"),
        client.rpc("my_weakest_items", { lim: 60 }),
        client.rpc("item_difficulty"),
      ]);
      catStats = cs.data || [];
      weakItems = wi.data || [];
      itemDiff = {};
      (id.data || []).forEach((r) => (itemDiff[r.item_id] = +r.difficulty));
    } catch (e) {
      console.warn("server stats failed, falling back to local:", e);
      catStats = null;
    }
  }

  // Fallback to localStorage
  if (!catStats || !catStats.length) {
    catStats = localStats();
    weakItems = localWeakItems();
    itemDiff = {};
  }

  // If no history at all, return a shuffled random set
  if (!catStats.length) {
    return {
      questions: shuffle(allQuestions).slice(0, n),
      reason: "Random set — answer some questions first and recommendations will kick in.",
    };
  }

  // ---- score every item ----
  const missedIds = new Set(weakItems.map((w) => w.item_id));
  const catAccuracy = {};
  catStats.forEach((c) => (catAccuracy[c.category] = +c.accuracy));

  const scored = allQuestions.map((q) => {
    let score = 0;

    // 1. Category weakness: lower accuracy = higher score
    const acc = catAccuracy[q.cat];
    if (acc !== undefined) {
      score += (1 - acc) * 10;
    } else {
      // unseen category gets moderate priority
      score += 5;
    }

    // 2. Previously missed: bonus
    if (missedIds.has(q.id)) {
      const w = weakItems.find((x) => x.item_id === q.id);
      score += (w ? +w.miss_rate : 0.5) * 6;
    }

    // 3. Item difficulty (from population data): harder items get a small boost
    if (itemDiff[q.id] !== undefined) {
      score += itemDiff[q.id] * 3;
    }

    // 4. Small random jitter so sets aren't identical
    score += Math.random() * 2;

    return { q, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Take the top-scoring items, but ensure category diversity:
  // no single category should exceed 40% of the set
  const maxPerCat = Math.ceil(n * 0.4);
  const catCounts = {};
  const selected = [];

  for (const { q } of scored) {
    if (selected.length >= n) break;
    const cc = catCounts[q.cat] || 0;
    if (cc >= maxPerCat) continue;
    catCounts[q.cat] = cc + 1;
    selected.push(q);
  }

  // If we didn't fill up (unlikely), pad with randoms
  if (selected.length < n) {
    const usedIds = new Set(selected.map((q) => q.id));
    for (const q of shuffle(allQuestions)) {
      if (selected.length >= n) break;
      if (!usedIds.has(q.id)) selected.push(q);
    }
  }

  // Shuffle the final set so the order isn't by difficulty
  const questions = shuffle(selected);

  // Build a human-readable reason
  const weakest = catStats.filter((c) => +c.accuracy < 0.7).sort((a, b) => +a.accuracy - +b.accuracy);
  let reason;
  if (weakest.length) {
    reason =
      "Weighted toward " +
      weakest
        .slice(0, 2)
        .map((c) => c.category + " (" + Math.round(+c.accuracy * 100) + "%)")
        .join(" and ") +
      " — your weakest " + (weakest.length === 1 ? "area" : "areas") + " right now.";
  } else {
    reason = "Strong across the board. This set mixes in your previously missed items and harder questions from the bank.";
  }

  return { questions, reason };
}

/**
 * Generate a study plan: what to work on today.
 * Returns an ordered list of { category, accuracy, action, itemCount }.
 */
export function studyPlan(catStats, totalItems) {
  if (!catStats || !catStats.length) return [];

  const plan = catStats
    .map((c) => {
      const acc = +(c.accuracy || 0);
      let action, priority;
      if (acc < 0.5) {
        action = "Review glossary first, then drill";
        priority = 3;
      } else if (acc < 0.7) {
        action = "Run a focused 10-item set";
        priority = 2;
      } else if (acc < 0.85) {
        action = "Practice vignettes to solidify";
        priority = 1;
      } else {
        action = "Maintenance — revisit weekly";
        priority = 0;
      }
      return {
        category: c.category,
        accuracy: acc,
        total: +(c.total || 0),
        action,
        priority,
      };
    })
    .sort((a, b) => b.priority - a.priority || a.accuracy - b.accuracy);

  return plan;
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
