// js/planner-ui.js
// The Plan tab: the estimate, the block timer, progress, and focus.
//
// Kept apart from planner.js so the logic stays testable without a DOM, and so
// an app that wants a different presentation can use the same numbers.

import * as P from "./planner.js";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let tickId = null;
let root = null;

const STYLE = `
.pl-grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:22px;}
.pl-stat{border:1px solid var(--line);border-radius:6px;padding:14px 16px;background:var(--surface);}
.pl-stat b{display:block;font-family:var(--mono);font-size:26px;color:var(--gold);letter-spacing:-.02em;}
.pl-stat span{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--text-dim);}
.pl-bar{height:6px;border-radius:99px;background:var(--surface-2);overflow:hidden;margin:6px 0 18px;}
.pl-bar i{display:block;height:100%;background:var(--gold);}
.pl-block{border:1px solid var(--gold);border-radius:7px;padding:18px 20px;background:var(--surface);margin-bottom:20px;}
.pl-block h3{margin:0 0 4px;font-size:17px;}
.pl-block p{margin:0 0 14px;color:var(--text-dim);font-size:14.5px;line-height:1.5;}
.pl-timer{font-family:var(--mono);font-size:40px;letter-spacing:-.02em;margin:6px 0 12px;}
.pl-timer.break{color:var(--good);}
.pl-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;}
.pl-tip{border-left:2px solid var(--gold);padding:2px 0 2px 14px;margin-bottom:16px;}
.pl-tip b{display:block;font-size:14.5px;margin-bottom:3px;}
.pl-tip span{color:var(--text-dim);font-size:13.5px;line-height:1.55;}
.pl-tip em{font-style:normal;font-family:var(--mono);font-size:9px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--text-dim);display:block;margin-bottom:4px;}
.pl-rate{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0;}
.pl-rate button{border:1px solid var(--line);border-radius:5px;padding:8px 14px;
  font-family:var(--mono);font-size:13px;cursor:pointer;}
.pl-rate button[aria-pressed="true"]{border-color:var(--gold);color:var(--gold);}
.pl-tags{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0 16px;}
.pl-tags button{border:1px solid var(--line);border-radius:99px;padding:6px 12px;font-size:12.5px;cursor:pointer;}
.pl-tags button[aria-pressed="true"]{border-color:var(--gold);color:var(--gold);}
.pl-h{font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--text-dim);margin:26px 0 10px;}
.pl-split{display:grid;gap:8px;}
.pl-split div{display:flex;justify-content:space-between;gap:10px;font-size:14px;
  padding-bottom:6px;border-bottom:1px solid var(--line);}
.pl-split span:last-child{font-family:var(--mono);color:var(--text-dim);font-size:12.5px;}
.pl-note{color:var(--text-dim);font-size:13.5px;line-height:1.6;max-width:62ch;}
.pl-date{background:var(--surface);color:var(--text);border:1px solid var(--line);
  border-radius:5px;padding:8px 10px;font:inherit;font-size:14px;}
`;

function injectStyle() {
  if (document.getElementById("pl-style")) return;
  const el = document.createElement("style");
  el.id = "pl-style";
  el.textContent = STYLE;
  document.head.append(el);
}

const fmt = s => {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

/* ---------- the running block ---------- */

let pending = { focus: 0, tags: new Set() };

function renderOpen(open) {
  const started = new Date(open.at).getTime();
  const workMs = P.CONSTANTS.WORK_MINUTES * 60000;
  const elapsed = Date.now() - started;
  const onBreak = elapsed >= workMs;
  const left = onBreak
    ? (workMs + P.CONSTANTS.BREAK_MINUTES * 60000 - elapsed) / 1000
    : (workMs - elapsed) / 1000;
  const act = P.CONSTANTS.ACTIVITIES[open.activity] || { label: open.activity, how: "" };

  return `
    <div class="pl-block">
      <h3>${esc(act.label)}${onBreak ? " — break" : ""}</h3>
      <p>${onBreak
        ? "Stand up, look at something further away than a screen. The break is part of the block."
        : esc(act.how)}</p>
      <div class="pl-timer${onBreak ? " break" : ""}">${fmt(left)}</div>
      <div class="pl-row">
        <button class="btn primary" id="plDone">Finish block</button>
        <button class="btn" id="plCancel">Abandon</button>
      </div>
    </div>`;
}

function renderRating(open) {
  const mins = Math.round((Date.now() - new Date(open.at).getTime()) / 60000);
  return `
    <div class="pl-block">
      <h3>How did that go?</h3>
      <p>${mins} minute${mins === 1 ? "" : "s"}. Rate your focus honestly — the tips below are chosen from it,
         and flattering the number just gets you worse advice.</p>
      <div class="pl-rate" id="plFocus">
        ${[1, 2, 3, 4, 5].map(n =>
          `<button data-focus="${n}" aria-pressed="false">${n}</button>`).join("")}
      </div>
      <p style="margin:0 0 4px;font-size:13.5px;">Anything pull you away?</p>
      <div class="pl-tags" id="plTags">
        ${P.DISTRACTIONS.map(d =>
          `<button data-tag="${d.id}" aria-pressed="false">${esc(d.label)}</button>`).join("")}
      </div>
      <div class="pl-row">
        <button class="btn primary" id="plSave">Save block</button>
      </div>
    </div>`;
}

function renderIdle(next, prog) {
  const target = P.state().target || "";
  return `
    <div class="pl-block">
      <h3>Next block · ${esc(next.label)}</h3>
      <p>${esc(next.how)}</p>
      <p style="font-family:var(--mono);font-size:11px;letter-spacing:.06em;margin-bottom:14px;">
        ${P.CONSTANTS.WORK_MINUTES} min work · ${P.CONSTANTS.BREAK_MINUTES} min break
        ${next.remainingMinutes > 0 ? ` · about ${Math.round(next.remainingMinutes / 60)}h of ${esc(next.label.toLowerCase())} left` : ""}
      </p>
      <div class="pl-row">
        <button class="btn primary" id="plStart">Start the hour</button>
        <label style="font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-dim);">
          Exam date
          <input class="pl-date" type="date" id="plTarget" value="${esc(target)}">
        </label>
      </div>
      ${prog.blocksPerWeek
        ? `<p class="pl-note" style="margin-top:12px;">${prog.daysLeft} days left — about
           <b style="color:var(--gold)">${prog.blocksPerWeek} blocks a week</b> to finish the material in time.</p>`
        : ""}
    </div>`;
}

/* ---------- the whole view ---------- */

export function render() {
  if (!root) return;
  const open = P.openBlock();
  const s = P.summary();
  const { estimate: est, progress: prog, next } = s;

  const rating = root.dataset.rating === "1" && open;

  root.innerHTML = `
    <p class="pl-note" style="margin-bottom:18px;">
      This material is about <b style="color:var(--gold)">${est.hours} hours</b> of study —
      ${est.blocks} blocks of an hour. Everything here stays on your device.
    </p>

    <div class="pl-grid">
      <div class="pl-stat"><b>${prog.blocksDone}</b><span>blocks done</span></div>
      <div class="pl-stat"><b>${prog.hours}h</b><span>time logged</span></div>
      <div class="pl-stat"><b>${prog.percent}%</b><span>of the material</span></div>
      <div class="pl-stat"><b>${prog.streak}</b><span>day streak</span></div>
    </div>
    <div class="pl-bar"><i style="width:${prog.percent}%"></i></div>

    ${root.dataset.notice ? `<p class="pl-note" style="border-left:2px solid var(--gold);padding-left:14px;margin-bottom:18px;">${esc(root.dataset.notice)}</p>` : ""}

    ${rating ? renderRating(open) : open ? renderOpen(open) : renderIdle(next, prog)}

    <p class="pl-h">Focus</p>
    ${s.tips.map(t => `
      <div class="pl-tip">
        <em>${esc(t.tag)}</em>
        <b>${esc(t.tip)}</b>
        <span>${esc(t.why)}</span>
      </div>`).join("")}

    <p class="pl-h">Where the hours go</p>
    <div class="pl-split">
      ${Object.entries(est.parts).map(([k, h]) => {
        const done = Math.round((prog.byActivity[k] || 0) / 6) / 10;
        return `<div><span>${esc(P.CONSTANTS.ACTIVITIES[k]?.label || k)}</span>
                <span>${done}h of ${h}h</span></div>`;
      }).join("")}
    </div>

    <p class="pl-h">Honest note</p>
    <p class="pl-note">These hours are estimated from the amount of material, not from how fast you
    personally learn. Treat them as a scale, not a verdict — and remember this app is one resource
    among the ones your exam expects you to have used.</p>
  `;

  wire();
  clock(!!open && !rating);
}

function wire() {
  const $ = id => root.querySelector("#" + id);

  $("plStart")?.addEventListener("click", () => {
    P.startBlock();
    root.dataset.rating = "0";
    render();
  });

  $("plCancel")?.addEventListener("click", () => {
    // An abandoned block is not recorded: a zero-minute entry would drag the
    // averages the tips are chosen from without describing anything real.
    P.cancelBlock();
    render();
  });

  $("plDone")?.addEventListener("click", () => {
    pending = { focus: 0, tags: new Set() };
    root.dataset.rating = "1";
    render();
  });

  $("plTarget")?.addEventListener("change", e => { P.setTarget(e.target.value); render(); });

  root.querySelectorAll("#plFocus button").forEach(b => {
    b.addEventListener("click", () => {
      pending.focus = Number(b.dataset.focus);
      root.querySelectorAll("#plFocus button").forEach(x =>
        x.setAttribute("aria-pressed", String(x === b)));
    });
  });

  root.querySelectorAll("#plTags button").forEach(b => {
    b.addEventListener("click", () => {
      const id = b.dataset.tag;
      if (pending.tags.has(id)) pending.tags.delete(id); else pending.tags.add(id);
      b.setAttribute("aria-pressed", String(pending.tags.has(id)));
    });
  });

  $("plSave")?.addEventListener("click", () => {
    const open = P.openBlock();
    if (!open) { root.dataset.rating = "0"; return render(); }
    const mins = Math.min(
      P.CONSTANTS.WORK_MINUTES,
      Math.round((Date.now() - new Date(open.at).getTime()) / 60000));
    P.endBlock(mins, pending.focus || 3, [...pending.tags]);
    root.dataset.rating = "0";
    // A block that ran only a few minutes counts toward no total, and saying so
    // is better than appearing to record something and changing nothing.
    root.dataset.notice = mins < 5
      ? "That was under five minutes, so it does not count toward your hours — but what pulled you away is noted below."
      : "";
    render();
  });
}

/** Repaint once a second only while a block is actually running. */
function clock(on) {
  if (tickId) { clearInterval(tickId); tickId = null; }
  if (!on) return;
  tickId = setInterval(() => {
    const open = P.openBlock();
    if (!open) return render();
    const el = root.querySelector(".pl-timer");
    if (!el) return render();
    const started = new Date(open.at).getTime();
    const workMs = P.CONSTANTS.WORK_MINUTES * 60000;
    const elapsed = Date.now() - started;
    const onBreak = elapsed >= workMs;
    const total = workMs + P.CONSTANTS.BREAK_MINUTES * 60000;
    if (elapsed >= total) return render();          // block is over
    const left = (onBreak ? total - elapsed : workMs - elapsed) / 1000;
    el.textContent = fmt(left);
    el.classList.toggle("break", onBreak);
  }, 1000);
}

/** Attach the planner to an element. Safe to call more than once. */
export function mount(el) {
  if (!el) return;
  injectStyle();
  root = el;
  root.dataset.rating = root.dataset.rating || "0";
  render();
}

export function unmount() {
  if (tickId) { clearInterval(tickId); tickId = null; }
}
