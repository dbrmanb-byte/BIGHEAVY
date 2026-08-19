/* Shared packages here are plain static assets — there is nothing to compile.
   "Building" one means proving it is present and parseable, so a site never
   ships against a broken shared file. The deploy runbook requires packages to
   build before any site does; this is what that step actually verifies. */

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error("check-package: name at least one file to verify");
  process.exit(1);
}

let failed = false;

for (const target of targets) {
  const path = resolve(process.cwd(), target);
  try {
    const text = await readFile(path, "utf8");
    if (!text.trim()) throw new Error("file is empty");

    if (path.endsWith(".json")) {
      JSON.parse(text);                       // throws on malformed JSON
    } else if (path.endsWith(".js")) {
      // Parse without executing: the module is browser-targeted and expects
      // a window, so running it here would fail for the wrong reason.
      new Function(text);                     // throws on a syntax error
    }
    console.log(`  ok  ${basename(path)} (${text.length} bytes)`);
  } catch (err) {
    console.error(`  FAIL  ${target}: ${err.message}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
