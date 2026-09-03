// js/dashboard.js
// Renders the performance dashboard.
// Uses Supabase RPCs when logged in, falls back to localStorage stats.

import { getClient, getUser } from "./supabase-client.js";
import { localStats } from "./tracker.js";
import { studyPlan } from "./recommend.js";

/**
 * Fetch all dashboard data.
 * Returns { catStats, dailyTrend, sessions, streak, plan }.
 */
export async function fetchDashboard() {
  const user = getUser();
  const client = getClient();

  if (user && client) {
    try {
      const [cs, dt, sess, str] = await Promise.all([
        client.rpc("my_category_stats"),
        client.rpc("my_daily_trend"),
        client.rpc("my_sessions", { lim: 10 }),
        client.rpc("my_streak"),
      ]);
      const catStats = cs.data || [];
      const plan = studyPlan(catStats);
      return {
        catStats,
        dailyTrend: dt.data || [],
        sessions: sess.data || [],
        streak: str.data ?? 0,
        plan,
        source: "server",
      };
    } catch (e) {
      console.warn("dashboard fetch failed:", e);
    }
  }

  // Fallback: local only
  const catStats = localStats();
  return {
    catStats,
    dailyTrend: [],
    sessions: [],
    streak: 0,
    plan: studyPlan(catStats),
    source: "local",
  };
}

/**
 * Render the dashboard into a container element.
 * @param {HTMLElement} el - the #v-dashboard container
 * @param {object} data - from fetchDashboard()
 * @param {object} CATS - category config {key: {label, color}}
 */
export function renderDashboard(el, data, CATS) {
  const { catStats, dailyTrend, sessions, streak, plan, source } = data;
  const catLabel = (c) => CATS[c]?.label || c;
  const catColor = (c) => CATS[c]?.color || "var(--gold)";

  if (!catStats.length) {
    el.innerHTML =
      '<div class="empty">' +
      "<p>No data yet. Answer some questions and your dashboard will build itself.</p>" +
      "</div>";
    return;
  }

  let html = "";

  // ---- headline stats ----
  const totalQ = catStats.reduce((s, c) => s + (+c.total || 0), 0);
  const totalR = catStats.reduce((s, c) => s + (+c.correct || 0), 0);
  const overallAcc = totalQ ? Math.round((totalR / totalQ) * 100) : 0;

  html += '<div class="dash-row">';
  html += stat(overallAcc + "%", "overall accuracy");
  html += stat(totalQ.toLocaleString(), "items answered");
  html += stat(sessions.length || "—", "sessions");
  html += stat(streak || "0", "day streak");
  html += "</div>";

  // ---- category bars ----
  html += '<h3 class="dash-h">Performance by area</h3>';
  html += '<div class="cat-bars">';
  catStats.forEach((c) => {
    const pct = Math.round((+c.accuracy || 0) * 100);
    const cls = pct >= 85 ? "high" : pct >= 70 ? "mid" : "low";
    html +=
      '<div class="cat-bar">' +
      '<span class="cat-nm">' + esc(catLabel(c.category)) + "</span>" +
      '<span class="cat-track"><i class="' + cls + '" style="width:' + pct + "%;background:" + catColor(c.category) + '"></i></span>' +
      '<span class="cat-pct">' + pct + "%</span>" +
      '<span class="cat-n">' + c.total + "</span>" +
      "</div>";
  });
  html += "</div>";

  // ---- daily trend chart ----
  if (dailyTrend.length > 1) {
    html += '<h3 class="dash-h">Last 30 days</h3>';
    html += renderTrendChart(dailyTrend);
  }

  // ---- study plan ----
  if (plan.length) {
    html += '<h3 class="dash-h">What to work on next</h3>';
    html += '<div class="plan">';
    plan.forEach((p) => {
      const pct = Math.round(p.accuracy * 100);
      const urgent = p.priority >= 2 ? " urgent" : "";
      html +=
        '<div class="plan-row' + urgent + '">' +
        '<span class="plan-cat" style="color:' + catColor(p.category) + '">' + esc(catLabel(p.category)) + " — " + pct + "%</span>" +
        '<span class="plan-act">' + esc(p.action) + "</span>" +
        "</div>";
    });
    html += "</div>";
  }

  // ---- recent sessions ----
  if (sessions.length) {
    html += '<h3 class="dash-h">Recent sessions</h3>';
    html += '<div class="sess-list">';
    sessions.forEach((s) => {
      const d = new Date(s.finished_at);
      const pct = s.total ? Math.round((s.correct / s.total) * 100) : 0;
      html +=
        '<div class="sess-row">' +
        '<span class="sess-date">' + d.toLocaleDateString() + "</span>" +
        '<span class="sess-score">' + s.correct + "/" + s.total + " (" + pct + "%)</span>" +
        '<span class="sess-len">' + s.length + " items</span>" +
        "</div>";
    });
    html += "</div>";
  }

  if (source === "local") {
    html +=
      '<p class="dash-note">Showing local data only. Sign in to sync across devices and see trends over time.</p>';
  }

  el.innerHTML = html;
}

// ---- helpers ----

function stat(value, label) {
  return (
    '<div class="dash-stat"><span class="ds-val">' +
    value + '</span><span class="ds-lbl">' + esc(label) + "</span></div>"
  );
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function renderTrendChart(data) {
  const W = 680, H = 140, PAD = 30;
  const n = data.length;
  const maxQ = Math.max(...data.map((d) => +d.total), 1);
  const xStep = (W - PAD * 2) / Math.max(n - 1, 1);

  let accPath = "", volBars = "";
  data.forEach((d, i) => {
    const x = PAD + i * xStep;
    const yAcc = PAD + (1 - +d.accuracy) * (H - PAD * 2);
    accPath += (i === 0 ? "M" : "L") + x.toFixed(1) + "," + yAcc.toFixed(1);

    const bh = (+d.total / maxQ) * (H - PAD * 2) * 0.5;
    volBars +=
      '<rect x="' + (x - 3).toFixed(1) + '" y="' + (H - PAD - bh).toFixed(1) +
      '" width="6" height="' + bh.toFixed(1) +
      '" rx="2" fill="var(--surface-2)" opacity="0.7"/>';
  });

  return (
    '<svg viewBox="0 0 ' + W + " " + H + '" class="trend-svg" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="' + PAD + '" y1="' + (H - PAD) + '" x2="' + (W - PAD) + '" y2="' + (H - PAD) + '" stroke="var(--line)" stroke-width="1"/>' +
    '<line x1="' + PAD + '" y1="' + PAD + '" x2="' + (W - PAD) + '" y2="' + PAD + '" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="4"/>' +
    '<text x="' + (PAD - 4) + '" y="' + (PAD + 4) + '" fill="var(--text-dim)" font-size="9" text-anchor="end" font-family="var(--mono)">100%</text>' +
    '<text x="' + (PAD - 4) + '" y="' + (H - PAD + 4) + '" fill="var(--text-dim)" font-size="9" text-anchor="end" font-family="var(--mono)">0%</text>' +
    volBars +
    '<path d="' + accPath + '" fill="none" stroke="var(--gold)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>"
  );
}
