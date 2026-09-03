/* Wire an app's quiz flow to the split content.
 *
 * Three seams, and nothing else changes:
 *   1. Starting a set larger than the free sample loads the paid bank first.
 *   2. Answering an item reveals its key from the server, then renders.
 *   3. Finishing a held set reveals every answered item's key before scoring.
 *
 * The revealed key is written back onto the question object, so every existing
 * `picked === q.answer` comparison downstream keeps working untouched.
 *
 * Usage: node scripts/wire-content.mjs [slug ...]     (default: every app)
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const slugs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(join(ROOT, "apps")).filter(s =>
      s !== "hub" && existsSync(join(ROOT, "apps", s, "src", "index.html")));

/* --- 1. the module layer publishes the content API for the classic script --- */
const IMPORT_ANCHOR = 'import * as Tiers from "./js/tiers.js";';
const IMPORT_PATCH = IMPORT_ANCHOR + '\nimport * as Content from "./js/content.js";';
const EXPOSE_ANCHOR = "window.Tiers = Tiers;";
const EXPOSE_PATCH = EXPOSE_ANCHOR + "\nwindow.Content = Content;";

/* --- 2. starting a paid-size set pulls the bank --- */
const START_ANCHOR = `function startSet(L){
  if(L.exam){`;
const START_PATCH = `async function startSet(L){
  // Sets beyond the free sample need the paid bank, which is not in the bundle.
  const free = (window.DATA && window.DATA.meta && window.DATA.meta.free) || 0;
  if(window.DATA && window.DATA.meta && window.DATA.meta.split && L.n > free && window.Content){
    const btns = document.querySelectorAll("#lenGrid .len");
    btns.forEach(b => b.disabled = true);
    try{
      await window.Content.loadBank();
    }catch(err){
      btns.forEach(b => b.disabled = false);
      toast(err && err.message ? err.message : "Could not load the question bank.");
      return;
    }
    btns.forEach(b => b.disabled = false);
  }
  if(L.exam){`;

/* --- 3. answering reveals that item's key before the verdict renders --- */
const PICK_ANCHOR = `      b.onclick = () => { S.quizAnswers[q.id] = i; saveSession(); hold ? next() : renderQuiz(); };`;
const PICK_PATCH = `      b.onclick = async () => {
        S.quizAnswers[q.id] = i; saveSession();
        // The answer key is not in the bundle for paid items; ask for it now
        // that a choice has been made. Held sets reveal everything at the end.
        if(!hold && window.Content && window.Content.needsGrading(q)){
          try{ await window.Content.grade({[q.id]: i}); }
          catch(err){ toast(err && err.message ? err.message : "Could not check that answer."); }
        }
        hold ? next() : renderQuiz();
      };`;

/* --- 4. a held set reveals every answered item before it is scored --- */
const FINISH_ANCHOR = `function finishSet(timedOut){
  stopClock();
  const answered = S.quizQueue.filter(q => S.quizAnswers[q.id] !== undefined);`;
const FINISH_PATCH = `async function finishSet(timedOut){
  stopClock();
  // Scoring reads q.answer, so anything still keyless has to be revealed first.
  if(window.Content){
    const pending = {};
    S.quizQueue.forEach(q => {
      if(S.quizAnswers[q.id] !== undefined && window.Content.needsGrading(q)){
        pending[q.id] = S.quizAnswers[q.id];
      }
    });
    if(Object.keys(pending).length){
      try{ await window.Content.grade(pending); }
      catch(err){ toast(err && err.message ? err.message : "Could not score every item."); }
    }
  }
  const answered = S.quizQueue.filter(q => S.quizAnswers[q.id] !== undefined);`;

/* --- 5. the keyboard path answers too, and must reveal the same way --- */
const KEY_ANCHOR = `      S.quizAnswers[q.id] = i; saveSession();
      S.cfg.hold ? next() : renderQuiz();`;
const KEY_PATCH = `      S.quizAnswers[q.id] = i; saveSession();
      if(!S.cfg.hold && window.Content && window.Content.needsGrading(q)){
        window.Content.grade({[q.id]: i})
          .catch(err => toast(err && err.message ? err.message : "Could not check that answer."))
          .then(() => renderQuiz());
      } else {
        S.cfg.hold ? next() : renderQuiz();
      }`;

/* --- 6. the bank size shown on the setup screen is the real total --- */
const SIZE_ANCHOR = `bankSizeEl.textContent = window.DATA.questions.length;`;
const SIZE_PATCH = `bankSizeEl.textContent = (window.DATA.meta && window.DATA.meta.total) || window.DATA.questions.length;`;

const EDITS = [
  ["module import", IMPORT_ANCHOR, IMPORT_PATCH],
  ["expose Content", EXPOSE_ANCHOR, EXPOSE_PATCH],
  ["startSet", START_ANCHOR, START_PATCH],
  ["choice click", PICK_ANCHOR, PICK_PATCH],
  ["finishSet", FINISH_ANCHOR, FINISH_PATCH],
  ["keyboard answer", KEY_ANCHOR, KEY_PATCH],
  ["bank size", SIZE_ANCHOR, SIZE_PATCH],
];

let failed = false;

for (const slug of slugs) {
  const p = join(ROOT, "apps", slug, "src", "index.html");
  if (!existsSync(p)) continue;
  let t = await readFile(p, "utf8");
  const applied = [], missing = [];

  for (const [name, anchor, patch] of EDITS) {
    if (t.includes(patch)) { applied.push(name + " (already)"); continue; }
    if (!t.includes(anchor)) { missing.push(name); continue; }
    t = t.replace(anchor, patch);
    applied.push(name);
  }

  await writeFile(p, t);
  console.log(`  ${slug}: ${applied.length} applied${missing.length ? `, MISSING: ${missing.join(", ")}` : ""}`);
  if (missing.length) failed = true;
}

process.exit(failed ? 1 : 0);
