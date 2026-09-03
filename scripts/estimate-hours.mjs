/* Estimate the study hours each app and book actually represents.
 *
 * The numbers a study planner promises have to come from somewhere defensible.
 * These are derived from the content itself — how many terms, how many
 * scenarios, how much prose — using per-item timings that are stated openly
 * below so they can be argued with and adjusted.
 *
 * Deliberately not padded. A planner that overstates the work makes people
 * despair; one that understates it makes them walk into the exam short.
 *
 * Usage: node scripts/estimate-hours.mjs [--write]
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.includes("--write");

/* Seconds per activity. Chosen to describe deliberate study, not skimming. */
const T = {
  termFirstRead:   90,   // meet a term, understand it, connect it to something
  termRepetition:  15,   // one spaced-repetition exposure
  termRepetitions:  5,   // exposures to move a term into a long-term box
  questionFirst:  165,   // read the stem, decide, read the rationale, reflect
  questionRedo:    90,   // a second pass on one you got wrong
  redoShare:      0.40,  // the share of items most people revisit
  examSimItems:   150,   // a full simulation, capped at the bank size
  examSimPace:     84,   // seconds per item under exam conditions
  examSims:         2,   // simulations worth running before the real thing
  wordsPerMinute: 200,   // study reading, slower than leisure reading
  rereadFactor:   1.35,  // books get revisited, not read once
};

const hours = s => s / 3600;
const round = h => Math.round(h * 2) / 2;      // half-hour resolution

const registry = JSON.parse(await readFile(join(ROOT, "packages/registry/apps.json"), "utf8"));
const rows = [];

for (const app of registry.apps || []) {
  const freePath = join(ROOT, "apps", app.slug, "src", "content-free.js");
  const bankPath = join(ROOT, "content", app.slug, "bank.json");
  if (!existsSync(freePath)) continue;

  const src = await readFile(freePath, "utf8");
  const bundle = JSON.parse(src.slice(src.indexOf("window.DATA = ") + 14, src.lastIndexOf(";")));
  const cards = bundle.cards || [];

  let questions = bundle.questions || [];
  if (existsSync(bankPath)) {
    const bank = JSON.parse(await readFile(bankPath, "utf8"));
    if (bank.questions?.length) questions = bank.questions;
  }

  const nTerms = cards.length;
  const nQ = questions.length;

  const learn  = nTerms * T.termFirstRead;
  const drill  = nTerms * T.termRepetition * T.termRepetitions;
  const first  = nQ * T.questionFirst;
  const redo   = nQ * T.redoShare * T.questionRedo;
  const sims   = T.examSims * Math.min(T.examSimItems, nQ) * T.examSimPace;

  // The book is the same content in prose; time it by its own word count.
  const words = [...cards.map(c => `${c.term} ${c.def}`),
                 ...questions.map(q => `${q.stem} ${(q.choices || []).join(" ")} ${q.why || ""}`)]
    .join(" ").split(/\s+/).filter(Boolean).length;
  const bookSeconds = (words / T.wordsPerMinute) * 60 * T.rereadFactor;

  const appSeconds = learn + drill + first + redo + sims;
  const appHours  = round(hours(appSeconds));
  const bookHours = round(hours(bookSeconds));
  // Blocks come off the raw figure, not the half-rounded one: 11.4 hours of work
  // is twelve one-hour blocks, and rounding to 11 before ceiling loses the
  // twelfth. The in-app planner ceils the raw seconds, so anything else here
  // makes the hub quote a block count the app then contradicts.
  const appBlocks = Math.max(1, Math.ceil(hours(appSeconds)));

  rows.push({
    slug: app.slug, name: app.name, terms: nTerms, questions: nQ, words,
    app: appHours, book: bookHours,
    breakdown: {
      glossary: round(hours(learn)),
      drills:   round(hours(drill)),
      practice: round(hours(first + redo)),
      exams:    round(hours(sims)),
    },
  });

  if (write) {
    app.hours = { study: appHours, reading: bookHours, blocks: appBlocks };
    if (app.ebook) app.ebook.hours = bookHours;
  }
}

console.log("\n  app                  terms   qs    words   glossary drills practice exams |  app   book");
for (const r of rows.sort((a, b) => a.app - b.app)) {
  console.log(
    `  ${r.slug.padEnd(20)}${String(r.terms).padStart(5)}${String(r.questions).padStart(5)}` +
    `${String(r.words).padStart(9)}` +
    `${String(r.breakdown.glossary).padStart(10)}${String(r.breakdown.drills).padStart(7)}` +
    `${String(r.breakdown.practice).padStart(9)}${String(r.breakdown.exams).padStart(6)} |` +
    `${String(r.app).padStart(6)}h${String(r.book).padStart(5)}h`);
}

const total = rows.reduce((s, r) => s + r.app, 0);
console.log(`\n  whole catalogue: ${total} study hours across ${rows.length} apps\n`);

if (write) {
  registry.hoursModel = {
    comment: "Derived by scripts/estimate-hours.mjs from the content itself. Timings are stated in that file; change them there and re-run rather than editing these numbers.",
    ...T,
  };
  await writeFile(join(ROOT, "packages/registry/apps.json"), JSON.stringify(registry, null, 2) + "\n");
  console.log("  registry updated.\n");
} else {
  console.log("  run with --write to store these in the registry.\n");
}
