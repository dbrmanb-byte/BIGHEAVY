// js/coach.js
// The hub coach: which app, is there time, and which plan.
//
// Deliberately not a language model. Every question a visitor arrives with —
// "which of these covers CISSP", "LMSW or LCSW", "my exam is in three weeks",
// "is Unlimited worth it" — is answered from the registry and arithmetic. That
// makes it instant, offline, and incapable of telling someone to study for the
// wrong exam, which is the one mistake here that actually costs them.
//
// Everything below is pure: it takes the registry and the visitor's answers and
// returns data. The page in apps/hub renders it.

import { estimateFrom, CONSTANTS } from "./planner.js";

const WEEKS_PER_MONTH = 4.345;

/* ---------------- matching ---------------- */

const STOP = new Set([
  "i","im","i'm","am","a","an","the","for","to","my","me","is","are","in","on","of",
  "and","or","do","need","want","study","studying","studies","exam","exams","test",
  "tests","testing","prep","prepare","preparing","licence","license","licensing",
  "certification","certified","cert","certs","take","taking","sit","sitting","about",
  "what","which","help","looking","look","get","got","have","be","been","next"
]);

const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9+ ]+/g, " ").replace(/\s+/g, " ").trim();

function tokens(s) {
  return norm(s).split(" ").filter(w => w && !STOP.has(w));
}

/**
 * Score one app against a free-text query.
 *
 * Phrase hits beat word hits, because "social work" landing on three apps is a
 * useful signal and "work" landing on all ten is noise. An exam name in the
 * `covers` list is the strongest signal there is: someone who types CISSP has
 * told us exactly what they need.
 */
function scoreApp(app, query) {
  const q = norm(query);
  if (!q) return { score: 0, why: [] };
  const words = tokens(query);
  if (!words.length) return { score: 0, why: [] };

  const c = app.coach || {};
  let score = 0;
  const why = [];

  for (const name of c.covers || []) {
    const n = norm(name);
    if (!n) continue;
    if (q.includes(n) || n.includes(q)) { score += 60; why.push(name); }
  }

  for (const kw of c.keywords || []) {
    const k = norm(kw);
    if (!k) continue;
    if (k.includes(" ")) {
      if (q.includes(k)) { score += 30; why.push(kw); }
    } else if (words.includes(k)) {
      score += 18; why.push(kw);
    } else if (k.length >= 5 && words.some(w => w.length >= 5 && (w.startsWith(k) || k.startsWith(w)))) {
      score += 9; why.push(kw);                       // nurse/nursing, electrician/electrical
    }
  }

  const hay = norm(`${app.name} ${app.exam} ${app.audience}`);
  for (const w of words) if (w.length >= 4 && hay.includes(w)) score += 6;

  return { score, why: [...new Set(why)].slice(0, 4) };
}

/**
 * Rank the catalogue against a query.
 * Returns every app that scored, best first. An empty array means "no idea" —
 * the caller should show the field picker rather than guess.
 */
export function search(query, apps) {
  const scored = (apps || [])
    .filter(a => a.status === "live")
    .map(a => ({ app: a, ...scoreApp(a, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.app.slug.localeCompare(b.app.slug));

  if (!scored.length) return [];

  // Anything well below the leader is not a real candidate — carrying it forward
  // turns a clean answer into a menu, and a menu is what the visitor came here
  // to avoid. The generic term is deliberately shared ("social work" is on all
  // three levels, and scores level across them, so a vague query keeps its
  // siblings); it is the specific one that has to pull clear.
  const top = scored[0].score;
  return scored.filter(x => x.score >= Math.max(12, top * 0.6));
}

/* ---------------- narrowing ---------------- */

/**
 * The question that separates the remaining candidates, if there is one.
 * Only fires when two or more candidates sit inside the same decision, so a
 * single clear match is never interrogated.
 */
export function decisionFor(candidates, decisions) {
  const slugs = new Set((candidates || []).map(c => c.slug || (c.app && c.app.slug)));
  for (const d of decisions || []) {
    const overlap = (d.among || []).filter(s => slugs.has(s));
    if (overlap.length >= 2) return { ...d, options: (d.options || []).filter(o => overlap.includes(o.picks)) };
  }
  return null;
}

/* ---------------- sizing up an app ---------------- */

/**
 * What this app asks of you. Derived from the same model the in-app planner
 * uses, so the hours quoted before signing up are the hours the app then shows.
 */
export function sizeUp(app) {
  const est = estimateFrom(app.terms, app.questions);
  return {
    slug: app.slug,
    name: app.name,
    hours: est.hours,
    blocks: est.blocks,
    parts: est.parts,
    terms: est.terms,
    questions: est.questions,
    readingHours: (app.ebook && app.ebook.hours) || 0,
  };
}

/* ---------------- is there time ---------------- */

/** Whole days from today to an ISO date, floor 0. */
export function daysUntil(isoDate, now = new Date()) {
  const t = new Date(isoDate + "T00:00:00").getTime();
  if (!isFinite(t)) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((t - start) / 86400000));
}

/**
 * The honest version of "can I do this in time".
 *
 * The temptation here is to reassure. It is worth resisting: someone with three
 * weeks and eight hours a week is short, and telling them so while there is
 * still time to book leave — or move the date — is worth more than a sale.
 */
export function timeline(app, { examDate, hoursPerWeek }, now = new Date()) {
  const size = sizeUp(app);
  const hpw = Number(hoursPerWeek) > 0 ? Number(hoursPerWeek) : null;
  const days = examDate ? daysUntil(examDate, now) : null;

  if (days === null || !hpw) {
    return {
      ...size, days: null, weeks: null, available: null, verdict: "unknown",
      headline: `${size.hours} hours of work, in ${size.blocks} one-hour blocks.`,
      detail: "Give me a date and the hours you can find in a week and I will tell you whether that fits.",
      cut: [],
    };
  }

  const weeks = days / 7;
  const available = Math.round(weeks * hpw * 10) / 10;
  const ratio = size.hours > 0 ? available / size.hours : Infinity;
  const perWeekNeeded = weeks > 0 ? Math.ceil(size.hours / weeks) : Infinity;
  const shortfall = Math.max(0, Math.round((size.hours - available) * 10) / 10);

  let verdict, headline, detail;
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;

  if (days === 0) {
    verdict = "past";
    headline = "Your exam is today.";
    detail = "Nothing here changes that. Use the drills for recall and get some sleep — cramming new material tonight costs you more than it adds.";
  } else if (ratio >= 1.25) {
    verdict = "comfortable";
    headline = `That fits, with room to spare.`;
    detail = `${size.hours} hours of work, ${available} available ${when}. About ${perWeekNeeded} hour${perWeekNeeded === 1 ? "" : "s"} a week gets you there, and the slack absorbs a bad week.`;
  } else if (ratio >= 1) {
    verdict = "workable";
    headline = "That fits, but it is not loose.";
    detail = `${size.hours} hours of work against ${available} available. You need about ${perWeekNeeded} hours a week and there is little room for a missed week — build the buffer in now rather than borrowing it later.`;
  } else if (ratio >= 0.7) {
    verdict = "tight";
    headline = `Tight. You are about ${shortfall} hours short.`;
    detail = `The full pass is ${size.hours} hours and you have ${available}. It is doable if you cut deliberately rather than just falling behind — the list below is the order I would drop things in.`;
  } else {
    verdict = "short";
    headline = `Not enough time for the full pass — you are ${shortfall} hours short.`;
    detail = `${size.hours} hours of work against ${available} available ${when}. That is worth knowing now, while you can still find more hours or move the date. If neither is possible, study the highest-yield parts rather than starting at the beginning and running out.`;
  }

  return {
    ...size, days, weeks: Math.round(weeks * 10) / 10, available, perWeekNeeded,
    shortfall, verdict, headline, detail,
    cut: verdict === "tight" || verdict === "short" ? compress(size) : [],
  };
}

/** What to keep and what to drop when the hours do not fit. */
function compress(size) {
  const A = CONSTANTS.ACTIVITIES;
  return [
    { keep: true,  what: A.drills.label,   hours: size.parts.drills,
      why: "Retrieval practice is the highest return per hour you have. Cut this last." },
    { keep: true,  what: A.practice.label, hours: size.parts.practice,
      why: "Questions with rationales teach the terms and how they are tested at the same time." },
    { keep: false, what: A.glossary.label, hours: size.parts.glossary,
      why: "Reading every term start to finish is the slowest route in. Let the drills surface what you do not know and read those." },
    { keep: false, what: A.exams.label,    hours: size.parts.exams,
      why: "Do one timed simulation instead of two, and do it with a week left so the result can still change something." },
  ];
}

/* ---------------- which plan ---------------- */

const PRICE = { pro: 7.99, allAccess: 14.99, ebook: 9.99 };

/**
 * Pro or Unlimited. The arithmetic is shown rather than asserted, and it is
 * allowed to come out against the more expensive plan — which, for one exam and
 * for exams taken one after another, it does.
 */
export function planAdvice({ examCount = 1, simultaneous = false, months = null } = {}) {
  const n = Math.max(1, examCount | 0);
  // A month count is only quoted when it is actually known. The caller can size
  // one app's study; it cannot size exams the visitor has not named, so for more
  // than one exam the comparison stays per-month rather than inventing a span.
  const m = months && months > 0 ? Math.ceil(months) : null;
  const money = x => `$${x.toFixed(2)}`;
  const span = m === 1 ? "one month" : `${m} months`;
  const gap = money(PRICE.allAccess - PRICE.pro);

  if (n === 1) {
    return {
      pick: "pro", price: PRICE.pro,
      headline: `Pro, at ${money(PRICE.pro)} a month.`,
      reasoning: [
        "Pro unlocks one app completely, and one app is what you need.",
        `Unlimited is ${money(PRICE.allAccess)} and would buy you nine apps you are not going to open — `
          + (m ? `${money((PRICE.allAccess - PRICE.pro) * m)} over ${span}, for nothing.`
               : `${gap} a month, for nothing.`),
      ],
      alternative: null,
    };
  }

  if (simultaneous) {
    const proCost = PRICE.pro * n;
    return {
      pick: "all_access", price: PRICE.allAccess,
      headline: `Unlimited, at ${money(PRICE.allAccess)} a month.`,
      reasoning: [
        `${n} exams at once means ${n} apps at once, and Pro only ever covers one.`,
        `${n} Pro subscriptions would be ${money(proCost)} a month. Unlimited is ${money(PRICE.allAccess)} `
          + `and covers all ten, so it saves you ${money(proCost - PRICE.allAccess)} a month from the second app onward.`,
      ],
      alternative: null,
    };
  }

  return {
    pick: "pro", price: PRICE.pro,
    headline: "Pro, and switch it when you move to the next exam.",
    reasoning: [
      "Taking them one after another means you only ever need one app unlocked at a time.",
      `Pro covers one app and you can change which one, so ${money(PRICE.pro)} a month carries you through all of them in turn — `
        + `${gap} a month less than Unlimited, for the whole run.`,
    ],
    alternative: {
      pick: "all_access",
      when: "Unlimited is the better buy if the timelines end up overlapping, or if you want to read across several apps rather than finish one at a time.",
    },
  };
}

/** Months of study a set of apps represents at a given weekly pace. */
export function monthsOfStudy(apps, hoursPerWeek) {
  const hpw = Number(hoursPerWeek);
  if (!hpw || hpw <= 0) return null;
  const total = (apps || []).reduce((n, a) => n + sizeUp(a).hours, 0);
  return Math.max(1, Math.ceil(total / hpw / WEEKS_PER_MONTH));
}

/* ---------------- book or app ---------------- */

/**
 * The question people ask before buying both: is the book enough? It is not the
 * same product, and saying so sells more of both than pretending it is a
 * cheaper version of the app.
 */
export function bookOrApp(app) {
  const size = sizeUp(app);
  const book = app.ebook || null;
  return {
    book: book && {
      title: book.title,
      price: book.price ?? PRICE.ebook,
      hours: book.hours || 0,
      does: `Every one of the ${size.terms} terms and all ${size.questions} rationales, in reading order. Made to print and to read away from a screen.`,
      doesNot: "It cannot ask you anything. Reading is how you meet material, not how you learn to retrieve it under time pressure.",
    },
    app: {
      does: `The same content as drills that come back on a schedule, timed practice, and weak-area targeting — about ${size.hours} hours of active work.`,
      doesNot: "It is not built to be read start to finish, and it is harder to use on paper.",
    },
    together: book
      ? `They do different jobs. If you are buying one, buy the app — retrieval is what moves the score. The book earns its $${(book.price ?? PRICE.ebook).toFixed(2)} on the commute and in the last week, and it takes 10% off Pro when you do.`
      : null,
  };
}

export const PRICES = PRICE;
