/* Merge a Markdown content-additions file into an app's bank.
 *
 * Content arrives written as prose — glossary entries, numbered scenarios, and
 * a separate answer key. This parses that shape and folds it into the existing
 * data, rather than anyone hand-editing a 200KB JSON file.
 *
 * It refuses to write anything unless every scenario has a matching answer,
 * every scenario has four choices, and no id or scenario number collides with
 * what is already there. A silently dropped question is worse than a failed
 * merge, and a scenario whose answer key is missing would ship as unanswerable.
 *
 * Usage: node scripts/merge-additions.mjs <slug> <file.md> [more.md ...]
 *        node scripts/merge-additions.mjs <slug> <file.md> --dry
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FREE_QUESTIONS = 10;

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const [slug, ...files] = argv.filter(a => !a.startsWith("--"));

if (!slug || !files.length) {
  console.error("usage: node scripts/merge-additions.mjs <slug> <file.md> [...] [--dry]");
  process.exit(1);
}

/* ---------- parsing ---------- */

const between = (text, start, end) => {
  const i = text.indexOf(start);
  if (i < 0) return "";
  const from = i + start.length;
  const j = end ? text.indexOf(end, from) : -1;
  return text.slice(from, j < 0 ? undefined : j);
};

/** Glossary entries: a bold term followed by its definition paragraph. */
function parseTerms(part) {
  const out = [];
  // Split into "## <Sub> — N new terms" blocks; a file may have only one.
  const blocks = [...part.matchAll(/^## (.+?)\s+—\s+\d+ new terms\s*$/gm)];
  const spans = blocks.map((m, i) => ({
    sub: m[1].trim(),
    text: part.slice(m.index + m[0].length,
      i + 1 < blocks.length ? blocks[i + 1].index : undefined),
  }));
  const scan = spans.length ? spans : [{ sub: null, text: part }];

  for (const { sub, text } of scan) {
    for (const m of text.matchAll(/^\*\*(.+?)\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n## |\n---|$(?![\s\S]))/gm)) {
      const term = m[1].trim();
      const def = m[2].trim().replace(/\s*\n\s*/g, " ");
      if (term && def) out.push({ term, def, sub });
    }
  }
  return out;
}

/** Numbered scenarios with four lettered choices. */
function parseScenarios(part) {
  const out = [];
  const blocks = [...part.matchAll(/^## (.+?)\s+—\s+\d+ scenarios\s*$/gm)];
  const spans = blocks.map((m, i) => ({
    sub: m[1].trim(),
    text: part.slice(m.index + m[0].length,
      i + 1 < blocks.length ? blocks[i + 1].index : undefined),
  }));
  const scan = spans.length ? spans : [{ sub: null, text: part }];

  for (const { sub, text } of scan) {
    for (const m of text.matchAll(/^\*\*(\d+)\.\*\*\s*([\s\S]*?)(?=\n\*\*\d+\.\*\*|\n## |\n---|$(?![\s\S]))/gm)) {
      const n = Number(m[1]);
      const body = m[2];
      const lines = body.split("\n").map(s => s.trim()).filter(Boolean);
      const first = lines.findIndex(l => /^A\.\s/.test(l));
      if (first < 0) continue;
      const stem = lines.slice(0, first).join(" ").trim();
      const choices = [];
      for (const letter of ["A", "B", "C", "D"]) {
        const line = lines.find(l => new RegExp(`^${letter}\\.\\s`).test(l));
        if (line) choices.push(line.replace(/^[A-D]\.\s*/, "").trim());
      }
      out.push({ n, stem, choices, sub });
    }
  }
  return out;
}

/** Answer key: number, letter, short label, then the rationale. */
function parseAnswers(part) {
  const out = new Map();
  for (const m of part.matchAll(
    /^\*\*(\d+)\.\s*([A-D])\s*[—–-]\s*(.+?)\*\*\s*\n([\s\S]*?)(?=\n\*\*\d+\.|\n## |\n---|$(?![\s\S]))/gm)) {
    out.set(Number(m[1]), {
      letter: m[2],
      label: m[3].trim(),
      why: m[4].trim().replace(/\s*\n\s*/g, " "),
    });
  }
  return out;
}

async function parseFile(path) {
  const md = await readFile(path, "utf8");
  const gloss = between(md, "# Glossary Additions", "# Practice Scenario Additions");
  const scen  = between(md, "# Practice Scenario Additions", "# Answer Key with Rationales");
  const ans   = md.slice(md.indexOf("# Answer Key with Rationales"));
  return {
    terms: parseTerms(gloss),
    scenarios: parseScenarios(scen),
    answers: parseAnswers(ans),
  };
}

/* ---------- load what exists ---------- */

const bankPath = join(ROOT, "content", slug, "bank.json");
const freePath = join(ROOT, "apps", slug, "src", "content-free.js");
if (!existsSync(bankPath)) { console.error(`no bank at ${bankPath}`); process.exit(1); }
if (!existsSync(freePath)) { console.error(`no bundle at ${freePath}`); process.exit(1); }

const bank = JSON.parse(await readFile(bankPath, "utf8"));
const freeSrc = await readFile(freePath, "utf8");
const bundle = JSON.parse(freeSrc.slice(freeSrc.indexOf("window.DATA = ") + 14, freeSrc.lastIndexOf(";")));

const cards = bundle.cards || [];
const questions = bank.questions || [];
const CAT = questions[0]?.cat || cards[0]?.cat || "General";

const nextCardNum = () => cards.reduce((mx, c) =>
  Math.max(mx, Number(String(c.id).replace(/\D/g, "")) + 1), 0);
const takenN = new Set(questions.map(q => q.n));
const takenQId = new Set(questions.map(q => q.id));
const takenTerms = new Set(cards.map(c => c.term.toLowerCase()));

/* ---------- merge ---------- */

const problems = [];
const newCards = [];
const newQuestions = [];
let cardNum = nextCardNum();

for (const file of files) {
  const path = resolve(file);
  const { terms, scenarios, answers } = await parseFile(path);
  const name = path.split("/").pop();
  console.log(`\n  ${name}: parsed ${terms.length} terms, ${scenarios.length} scenarios, ${answers.size} answers`);

  for (const t of terms) {
    if (takenTerms.has(t.term.toLowerCase())) {
      problems.push(`${name}: duplicate term "${t.term}" already in the glossary`);
      continue;
    }
    takenTerms.add(t.term.toLowerCase());
    const card = { id: "c" + String(cardNum++).padStart(3, "0"), term: t.term, def: t.def, cat: CAT };
    if (t.sub) card.sub = t.sub;
    newCards.push(card);
  }

  for (const s of scenarios) {
    const a = answers.get(s.n);
    if (!a) { problems.push(`${name}: scenario ${s.n} has no answer key entry`); continue; }
    if (s.choices.length !== 4) {
      problems.push(`${name}: scenario ${s.n} has ${s.choices.length} choices, expected 4`);
      continue;
    }
    if (takenN.has(s.n)) { problems.push(`${name}: scenario number ${s.n} already exists`); continue; }
    const id = "q" + String(s.n).padStart(3, "0");
    if (takenQId.has(id)) { problems.push(`${name}: question id ${id} already exists`); continue; }
    takenN.add(s.n); takenQId.add(id);

    const q = {
      id, n: s.n, cat: CAT,
      stem: s.stem,
      choices: s.choices,
      answer: "ABCD".indexOf(a.letter),
      label: a.label,
      why: a.why,
    };
    if (s.sub) q.sub = s.sub;
    newQuestions.push(q);
  }
}

if (problems.length) {
  console.error(`\n  ${problems.length} problem(s) — nothing written:\n`);
  for (const p of problems.slice(0, 25)) console.error(`    ${p}`);
  if (problems.length > 25) console.error(`    …and ${problems.length - 25} more`);
  process.exit(1);
}

const allCards = [...cards, ...newCards];
const allQuestions = [...questions, ...newQuestions].sort((a, b) => a.n - b.n);

/* A free sample spread across the exam tracks, so the taster is not all one
   topic. Deterministic, so rebuilding does not churn the bundle. */
function pickFree(list, n) {
  const bySub = new Map();
  for (const q of list) {
    const k = q.sub || "_";
    if (!bySub.has(k)) bySub.set(k, []);
    bySub.get(k).push(q);
  }
  const keys = [...bySub.keys()].sort();
  const out = [];
  for (let i = 0; out.length < Math.min(n, list.length); i++) {
    let added = false;
    for (const k of keys) {
      const arr = bySub.get(k);
      if (i < arr.length) { out.push(arr[i]); added = true; }
      if (out.length >= n) break;
    }
    if (!added) break;
  }
  return out;
}

const free = pickFree(allQuestions, FREE_QUESTIONS);

console.log(`\n  ${slug}: ${cards.length} → ${allCards.length} terms, ` +
  `${questions.length} → ${allQuestions.length} scenarios ` +
  `(free sample ${free.length}, ${(free.length / allQuestions.length * 100).toFixed(0)}%)`);

if (dry) { console.log("\n  --dry: nothing written.\n"); process.exit(0); }

await mkdir(dirname(bankPath), { recursive: true });
await writeFile(bankPath, JSON.stringify({
  slug, total: allQuestions.length,
  freeIds: free.map(q => q.id),
  questions: allQuestions,
}) + "\n");

await writeFile(freePath,
  "/* Generated by scripts/split-content.mjs / merge-additions.mjs — do not edit by hand.\n" +
  "   The glossary and a sample of the question bank. The rest is served\n" +
  "   from the content function once entitlement is confirmed. */\n" +
  "window.DATA = " + JSON.stringify({
    cards: allCards,
    questions: free,
    meta: { total: allQuestions.length, free: free.length, split: true },
  }) + ";\n");

console.log(`  written: ${bankPath.replace(ROOT + "/", "")}, ${freePath.replace(ROOT + "/", "")}\n`);
