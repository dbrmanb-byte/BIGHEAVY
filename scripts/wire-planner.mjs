/* Add the Plan tab to every app.
 *
 * The planner renders itself, so each app needs only three things: a nav
 * button, an empty section, and a line in the module layer that mounts it when
 * the mode is selected.
 *
 * Usage: node scripts/wire-planner.mjs [slug ...]
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

/* 1. a tab in the mode nav, next to the others */
const NAV_ANCHOR = /(<button[^>]*data-mode="glossary"[^>]*>[^<]*<\/button>)/;
const NAV_ADD = '$1\n    <button role="tab" data-mode="plan" aria-selected="false">Plan</button>';

/* 2. an empty section for the planner to fill */
const SECTION_ANCHOR = /(<section class="wrap hide" id="v-glossary">)/;
const SECTION_ADD =
  '<!-- PLAN -->\n' +
  '  <section class="wrap hide" id="v-plan">\n' +
  '    <p class="lede"><b>Plan</b> turns this material into hour-long study blocks — fifty minutes of\n' +
  '    work and a ten-minute break — and keeps track of what you have actually done. Nothing here\n' +
  '    leaves your device, and none of it is behind a plan.</p>\n' +
  '    <div id="planRoot"></div>\n' +
  '  </section>\n\n  $1';

/* 3. the module layer mounts it, and the patched setMode knows the new mode */
const IMPORT_ANCHOR = 'import * as Content from "./js/content.js";';
const IMPORT_ADD = IMPORT_ANCHOR + '\nimport * as PlannerUI from "./js/planner-ui.js";';

const MODE_ANCHOR = '  if(m==="dashboard") _loadDash();';
const MODE_ADD =
  '  if(m==="dashboard") _loadDash();\n' +
  '  // The planner draws itself; it only needs to be told the tab is visible.\n' +
  '  if(m==="plan") PlannerUI.mount(document.getElementById("planRoot"));\n' +
  '  else PlannerUI.unmount();';

/* The classic script hides views by id; teach it the new one exists. */
const VIEWS_RE = /(\[)("drill","setup","quiz","glossary","summary","review"[^\]]*)(\])/;

const EDITS = [
  ["nav tab", NAV_ANCHOR, NAV_ADD, 'data-mode="plan"'],
  ["section", SECTION_ANCHOR, SECTION_ADD, 'id="v-plan"'],
  ["import", IMPORT_ANCHOR, IMPORT_ADD, "planner-ui.js"],
  ["mount", MODE_ANCHOR, MODE_ADD, 'PlannerUI.mount'],
];

let failed = false;

for (const slug of slugs) {
  const p = join(ROOT, "apps", slug, "src", "index.html");
  if (!existsSync(p)) continue;
  let t = await readFile(p, "utf8");
  const applied = [], missing = [];

  for (const [name, anchor, add, marker] of EDITS) {
    if (t.includes(marker)) { continue; }
    if (typeof anchor === "string" ? !t.includes(anchor) : !anchor.test(t)) {
      missing.push(name); continue;
    }
    t = t.replace(anchor, add);
    applied.push(name);
  }

  // The view list controls which sections are hidden on a mode change.
  if (VIEWS_RE.test(t) && !/"plan"/.test(t.match(VIEWS_RE)[0])) {
    t = t.replace(VIEWS_RE, (_, a, list, b) => a + list + ',"plan"' + b);
    applied.push("view list");
  }

  await writeFile(p, t);
  console.log(`  ${slug}: ${applied.length} applied${missing.length ? `, MISSING: ${missing.join(", ")}` : ""}`);
  if (missing.length) failed = true;
}

process.exit(failed ? 1 : 0);
