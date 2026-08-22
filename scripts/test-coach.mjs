/* The hub coach, checked against the real registry.
 *
 * Two things here are worth guarding. The first is that the matcher sends
 * people to the right app: recommending LMSW to someone sitting the clinical
 * exam is the most expensive mistake this codebase can make, and it is silent.
 * The second is that the hours quoted on the hub are the hours the app itself
 * will show — they come from two different call sites and must not drift.
 *
 * Usage: node scripts/test-coach.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Coach from "../packages/app-core/js/coach.js";
import { estimateFrom } from "../packages/app-core/js/planner.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reg = JSON.parse(await readFile(join(ROOT, "packages/registry/apps.json"), "utf8"));
const APPS = reg.apps;
const live = APPS.filter(a => a.status === "live");

let pass = 0, fail = 0;
const ok = (label, got, expect) => {
  const good = JSON.stringify(got) === JSON.stringify(expect);
  good ? pass++ : fail++;
  console.log(`  ${good ? "ok  " : "FAIL"}  ${label.padEnd(52)} expected ${JSON.stringify(expect)}  got ${JSON.stringify(got)}`);
};
const assert = (label, cond, note = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label.padEnd(52)} ${cond ? "" : note}`);
};

/* ---------------- matching ---------------- */

console.log("\n  search — the query lands on the right app");

// [query, expected top slug]
const TOP = [
  ["CISSP", "forge-security"],
  ["security+", "forge-security"],
  ["I'm studying for the CEH", "forge-security"],
  ["nclex", "casebook-nursing"],
  ["I am a nurse taking my boards", "casebook-nursing"],
  ["NCLEX-PN", "casebook-nursing"],
  ["real estate agent", "keystone"],
  ["realtor licence", "keystone"],
  ["broker exam", "keystone"],
  ["journeyman electrician", "forge-trades"],
  ["NEC", "forge-trades"],
  ["PMP", "forge-management"],
  ["togaf", "forge-management"],
  ["scrum master", "forge-management"],
  ["kubernetes", "forge-systems"],
  ["cka", "forge-systems"],
  ["terraform associate", "forge-systems"],
  ["aws solutions architect", "forge-cloud"],
  ["google cloud architect", "forge-cloud"],
  ["azure", "forge-cloud"],
  ["LCSW", "casebook-lcsw"],
  ["clinical social work exam", "casebook-lcsw"],
  ["LBSW", "casebook-lbsw"],
  ["bachelor social work", "casebook-lbsw"],
  ["LMSW", "casebook"],
  ["aswb masters", "casebook"],
];
for (const [q, slug] of TOP) {
  const hits = Coach.search(q, APPS);
  ok(`"${q}"`, hits[0] && hits[0].app.slug, slug);
}

console.log("\n  search — an exam name is unambiguous, and stays that way");
for (const [q, slug] of [["CISSP", "forge-security"], ["NCLEX-RN", "casebook-nursing"], ["PMP", "forge-management"]]) {
  const hits = Coach.search(q, APPS);
  assert(`"${q}" returns one candidate`, hits.length === 1 && hits[0].app.slug === slug,
    `got ${hits.map(h => h.app.slug).join(",")}`);
}

console.log("\n  search — a vague query keeps the siblings so we can ask");
{
  const hits = Coach.search("social work", APPS);
  const slugs = hits.map(h => h.app.slug).sort();
  assert("'social work' keeps all three levels", ["casebook", "casebook-lbsw", "casebook-lcsw"].every(s => slugs.includes(s)),
    `got ${slugs.join(",")}`);
  assert("'social work' does not drag in nursing", !slugs.includes("casebook-nursing"), `got ${slugs.join(",")}`);
}
{
  const hits = Coach.search("devops", APPS);
  assert("'devops' finds systems", hits.some(h => h.app.slug === "forge-systems"), `got ${hits.map(h => h.app.slug).join(",")}`);
}

console.log("\n  search — nonsense returns nothing rather than a guess");
for (const q of ["", "   ", "asdfghjkl", "I want to study for my exam", "hello"]) {
  ok(`"${q}"`, Coach.search(q, APPS).length, 0);
}

console.log("\n  search — nothing that is not live is ever offered");
{
  const all = new Set(live.map(a => a.slug));
  const queries = TOP.map(t => t[0]).concat(["social work", "cloud", "devops", "nursing"]);
  const leaked = queries.flatMap(q => Coach.search(q, APPS).map(h => h.app.slug)).filter(s => !all.has(s));
  ok("no non-live slug in any result", leaked, []);
}

/* ---------------- narrowing ---------------- */

console.log("\n  decisions — the right question, only when it is needed");
{
  const three = Coach.search("social work", APPS);
  const d = Coach.decisionFor(three, reg.decisions);
  assert("three social work hits raise the level question", d && d.id === "social-work-level", `got ${d && d.id}`);
  ok("and it offers exactly the three that matched",
    d.options.map(o => o.picks).sort(), ["casebook", "casebook-lbsw", "casebook-lcsw"]);

  const one = Coach.search("CISSP", APPS);
  ok("a single clear match is not interrogated", Coach.decisionFor(one, reg.decisions), null);

  const lcsw = Coach.search("LCSW", APPS);
  ok("naming the clinical exam is not interrogated either", Coach.decisionFor(lcsw, reg.decisions), null);
}
{
  // Every option in every decision must point at an app that exists and is live.
  const slugs = new Set(live.map(a => a.slug));
  const bad = reg.decisions.flatMap(d => (d.options || []).map(o => o.picks)).filter(s => !slugs.has(s));
  ok("every decision option points at a live app", bad, []);
  const badAmong = reg.decisions.flatMap(d => d.among || []).filter(s => !slugs.has(s));
  ok("every decision's 'among' list is live apps", badAmong, []);
}

/* ---------------- hours ---------------- */

console.log("\n  hours — the hub quotes what the app will show");
for (const a of live) {
  const size = Coach.sizeUp(a);
  ok(`${a.slug}`.padEnd(18), size.hours, a.hours.study);
}
{
  const drift = live.filter(a => estimateFrom(a.terms, a.questions).blocks !== a.hours.blocks);
  ok("block counts agree with the registry", drift.map(a => a.slug), []);
}

/* ---------------- timeline ---------------- */

console.log("\n  timeline — the arithmetic, and the honesty");
const NOW = new Date("2026-03-01T12:00:00Z");
const casebook = live.find(a => a.slug === "casebook");          // 28.5 hours
const iso = days => new Date(Date.UTC(2026, 2, 1 + days)).toISOString().slice(0, 10);
{
  const t = Coach.timeline(casebook, { examDate: iso(21), hoursPerWeek: 7 }, NOW);
  ok("three weeks at 7h/wk is 21 available", t.available, 21);
  ok("...74% of the work is 'tight', not 'workable'", t.verdict, "tight");
  assert("...and says how short, in hours", t.shortfall === 7.5, `got ${t.shortfall}`);
  assert("...and offers what to cut", t.cut.length === 4, `got ${t.cut.length}`);
}
{
  const t = Coach.timeline(casebook, { examDate: iso(21), hoursPerWeek: 4 }, NOW);
  ok("half the hours needed is called short outright", t.verdict, "short");
  assert("...and does not hide the number", /16.5 hours short/.test(t.headline), t.headline);
}
{
  const t = Coach.timeline(casebook, { examDate: iso(90), hoursPerWeek: 8 }, NOW);
  ok("three months at 8h/wk is comfortable", t.verdict, "comfortable");
  ok("...with no cut list", t.cut.length, 0);
}
{
  const t = Coach.timeline(casebook, { examDate: iso(28), hoursPerWeek: 7.5 }, NOW);
  ok("exactly enough is 'workable', not 'comfortable'", t.verdict, "workable");
}
{
  const t = Coach.timeline(casebook, { examDate: iso(35), hoursPerWeek: 5 }, NOW);
  ok("25 of 28.5 hours is tight", t.verdict, "tight");
}
{
  const t = Coach.timeline(casebook, { examDate: iso(0), hoursPerWeek: 10 }, NOW);
  ok("the exam being today is its own answer", t.verdict, "past");
}
{
  const t = Coach.timeline(casebook, {}, NOW);
  ok("no date given means no verdict claimed", t.verdict, "unknown");
  assert("...but the size is still stated", t.hours === 28.5, `got ${t.hours}`);
}
{
  ok("days are counted whole", Coach.daysUntil("2026-03-15", NOW), 14);
  ok("a past date floors at zero", Coach.daysUntil("2026-01-01", NOW), 0);
  ok("an unparseable date is null", Coach.daysUntil("not-a-date", NOW), null);
}

/* ---------------- plans ---------------- */

console.log("\n  plans — the recommendation is allowed to be the cheap one");
{
  const one = Coach.planAdvice({ examCount: 1 });
  ok("one exam is Pro", one.pick, "pro");

  const seq = Coach.planAdvice({ examCount: 2, simultaneous: false, months: 8 });
  ok("two exams in sequence is still Pro", seq.pick, "pro");
  assert("...and names Unlimited as the alternative", !!seq.alternative, "no alternative offered");

  const both = Coach.planAdvice({ examCount: 2, simultaneous: true, months: 6 });
  ok("two exams at once is Unlimited", both.pick, "all_access");

  const three = Coach.planAdvice({ examCount: 3, simultaneous: true });
  ok("three at once is Unlimited", three.pick, "all_access");
}
{
  // Every figure quoted in the copy is generated, so a price change silently
  // rewrites the sales pitch. These pin the arithmetic that reaches the visitor.
  const one = Coach.planAdvice({ examCount: 1, months: 3 }).reasoning.join(" ");
  assert("one exam over 3 months names the $21.00 wasted", /\$21\.00 over 3 months/.test(one), one);

  const both = Coach.planAdvice({ examCount: 2, simultaneous: true }).reasoning.join(" ");
  assert("two at once names two Pro at $15.98", /\$15\.98 a month/.test(both), both);
  assert("...and the real saving, $0.99", /saves you \$0\.99 a month/.test(both), both);

  const seq = Coach.planAdvice({ examCount: 2, simultaneous: false }).reasoning.join(" ");
  assert("sequential names the $7.00 a month saved", /\$7\.00 a month less/.test(seq), seq);
  assert("...and quotes no month span it cannot know", !/months/.test(seq), seq);
}
{
  // The claim in the copy has to be true: Unlimited must actually beat 2x Pro.
  assert("Unlimited undercuts two Pro subscriptions", Coach.PRICES.allAccess < Coach.PRICES.pro * 2,
    `${Coach.PRICES.allAccess} vs ${Coach.PRICES.pro * 2}`);
  assert("one Pro undercuts Unlimited", Coach.PRICES.pro < Coach.PRICES.allAccess);
}
{
  const m = Coach.monthsOfStudy([casebook], 8);
  assert("28.5 hours at 8h/wk is about a month", m === 1, `got ${m}`);
  ok("no pace given means no month count", Coach.monthsOfStudy([casebook], 0), null);
}

/* ---------------- book or app ---------------- */

console.log("\n  book or app — two products, described as two products");
{
  const b = Coach.bookOrApp(casebook);
  assert("the book is priced from the registry", b.book.price === casebook.ebook.price, `got ${b.book.price}`);
  assert("the book's limits are stated, not buried", /cannot ask you/.test(b.book.doesNot));
  assert("the app is recommended over the book when buying one", /buy the app/.test(b.together));
}

/* ---------------- copy integrity ---------------- */

console.log("\n  registry — the coach metadata is complete");
for (const a of live) {
  const c = a.coach || {};
  assert(`${a.slug}`.padEnd(18) + " has keywords and covers",
    Array.isArray(c.keywords) && c.keywords.length >= 5 && Array.isArray(c.covers) && c.covers.length >= 1);
}
{
  // A keyword shared by two apps makes both unrankable against it. Sharing is
  // fine for deliberately vague terms; it is a bug for an exam name.
  const seen = new Map();
  for (const a of live) for (const k of a.coach.covers) {
    const n = k.toLowerCase();
    seen.set(n, [...(seen.get(n) || []), a.slug]);
  }
  const shared = [...seen].filter(([, v]) => v.length > 1).map(([k]) => k);
  ok("no exam name is claimed by two apps", shared, []);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
