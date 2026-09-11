/* Validate the question banks against themselves.
 *
 * Two failures are invisible to every other check in this repo — the app
 * renders them, the tests pass, and the student is taught the wrong thing:
 *
 *   miskey   the rationale's opening clause recommends one choice while
 *            `answer` points at another. One of the two is wrong, and on a
 *            clinical item that is a patient-safety defect, not a typo.
 *
 *   stale letter
 *            the rationale names a distractor by letter — "Malingering (A)" —
 *            but that name sits at a different letter in `choices`. The app
 *            renders choices in bank order, so the student reads a rationale
 *            that contradicts the screen. Reordering choices without rewriting
 *            the rationales is how these appear; the durable fix is to stop
 *            citing letters at all.
 *
 * Needs the paid banks present at content/<slug>/bank.json — they are not in
 * this repository, so this is a local check, not CI.
 *
 * Usage: node scripts/check-banks.mjs [slug ...]      (default: every bank)
 * Exits non-zero if any miskey is found.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT = join(ROOT, "content");

if (!existsSync(CONTENT)) {
  console.error("  no content/ directory — unpack the paid content first (see LAUNCH.md §2)");
  process.exit(1);
}

const slugs = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync(CONTENT).filter(s => existsSync(join(CONTENT, s, "bank.json")));

// Words too common to carry meaning when matching a choice against its rationale.
const STOP = new Set(["the","a","an","and","or","of","to","in","for","with","on","at","by","is","are","be",
  "that","this","it","as","from","not","all","any","first","should","patient","nurse","then","when","which",
  "what","who","most","more","than","use","used","using","after","before","only","would","will","its","their"]);
// Numbers carry the meaning in these banks — a 504 plan, 42 CFR Part 2,
// NEC 210.8 — so tokens may start with a digit.
const words = s => [...new Set(String(s).toLowerCase().match(/[a-z0-9][a-z0-9+'.-]{2,}/g) || [])]
  .filter(w => !STOP.has(w) && /[a-z0-9]/.test(w));
const overlap = (a, b) => {
  const A = words(a), B = new Set(words(b));
  return A.length ? A.filter(w => B.has(w)).length / A.length : 0;
};

/* Items a human read and confirmed correct, so the gate stays usable. Add a
   reason with each — an unexplained entry is indistinguishable from hiding a
   real defect. Remove an entry if its question is ever rewritten. */
const REVIEWED = {
  "keystone q004": "Keyed 'a remainder interest' is right; the rationale says " +
    "'remainderman', which shares no whole word with the choice.",
};

let miskeys = 0, stale = 0, checked = 0, dismissed = 0;

for (const slug of slugs) {
  const bank = JSON.parse(readFileSync(join(CONTENT, slug, "bank.json"), "utf8"));
  for (const q of bank.questions || []) {
    if (!Array.isArray(q.choices) || typeof q.answer !== "number" || !q.why) continue;
    checked++;

    // Judge the key on the rationale's opening clause only — later sentences
    // exist to knock down distractors and naturally name them. Three further
    // guards, each earned by a false positive on this repo's own banks:
    //   · the keyed choice must go unmentioned in the WHOLE rationale. A
    //     rationale that says "SSI is needs-based" has keyed SSI correctly even
    //     though its first clause is about SSDI.
    //   · the rival must be more than one word, or an incidental "safety" in a
    //     sentence about Maslow convicts the wrong answer.
    //   · a rival that opens with a negation ("No federal protection") is a
    //     straw man the rationale is knocking down, not the answer.
    const lead = String(q.why).split(/\(([A-D])\)/)[0].split(/(?<=\.)\s/)[0];
    const scores = q.choices.map(c => overlap(c, lead));
    const keyedInLead = scores[q.answer] ?? 0;
    const keyedAnywhere = overlap(q.choices[q.answer], q.why);
    const best = Math.max(...scores);
    const bestIdx = scores.indexOf(best);
    const rival = q.choices[bestIdx] ?? "";
    const rivalIsStrawman = /^(no|none|not|never)\b/i.test(rival.trim());
    if (bestIdx !== q.answer && best >= 0.6 && best - keyedInLead >= 0.5
        && keyedAnywhere < 0.2 && words(rival).length >= 2 && !rivalIsStrawman) {
      if (REVIEWED[`${slug} ${q.id}`]) { dismissed++; continue; }
      miskeys++;
      console.log(`  MISKEY  ${slug} ${q.id}`);
      console.log(`          keyed  ${"ABCD"[q.answer]}. ${q.choices[q.answer]}`);
      console.log(`          why says: ${lead}`);
      console.log(`          which is ${"ABCD"[bestIdx]}. ${q.choices[bestIdx]}`);
    }

    for (const m of String(q.why).matchAll(/([A-Za-z][A-Za-z'’\- ]{3,44}?)\s*\(([A-D])\)/g)) {
      const name = m[1].replace(/^(and|or|but|the|a|an|is|not)\s+/i, "").trim();
      const idx = "ABCD".indexOf(m[2]);
      if (idx >= q.choices.length || name.split(/\s+/).length > 6) continue;
      const here = overlap(name, q.choices[idx]);
      const elsewhere = q.choices.map((c, i) => i === idx ? -1 : overlap(name, c));
      const bestElse = Math.max(...elsewhere);
      if (here < 0.5 && bestElse >= 0.5) {
        stale++;
        console.log(`  LETTER  ${slug} ${q.id}: rationale says "${name} (${m[2]})", but ${m[2]} is ` +
          `"${q.choices[idx]}" — ${name} is at ${"ABCD"[elsewhere.indexOf(bestElse)]}`);
      }
    }
  }
}

console.log(`\n  ${checked} questions checked in ${slugs.length} banks`);
console.log(`  ${miskeys} miskeyed, ${stale} stale letter references` +
  (dismissed ? `, ${dismissed} reviewed and dismissed` : ""));
if (stale && !miskeys) console.log("  Stale letters confuse but do not mislead. Drop the letters from the rationale text.");
if (miskeys) {
  console.log("\n  A miskeyed answer teaches the wrong thing to someone who paid. Fix before shipping.");
  process.exit(1);
}
