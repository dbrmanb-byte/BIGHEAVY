/* Shared packages here are plain static assets — there is nothing to compile.
   "Building" one means proving it is present and parseable, so a site never
   ships against a broken shared file. The deploy runbook requires packages to
   build before any site does; this is what that step actually verifies. */

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

/* ES modules cannot be parsed with `new Function` — `import` is a syntax error
   there. Hand those to node itself, which is the only parser guaranteed to
   agree with the one that will actually load them. */
async function checkSyntax(text, path) {
  const isModule = /^\s*(import|export)\s/m.test(text);
  if (!isModule) { new Function(text); return; }

  const dir = await mkdtemp(join(tmpdir(), "bh-check-"));
  const tmp = join(dir, basename(path).replace(/\.js$/, "") + ".mjs");
  try {
    await writeFile(tmp, text);
    const res = spawnSync(process.execPath, ["--check", tmp], { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error((res.stderr || "").split("\n").filter(Boolean).slice(0, 3).join(" ").trim()
        || "failed to parse as an ES module");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
      // Parse without executing: these are browser-targeted and expect a
      // window, so running them here would fail for the wrong reason.
      await checkSyntax(text, path);
    }
    console.log(`  ok  ${basename(path)} (${text.length} bytes)`);
  } catch (err) {
    console.error(`  FAIL  ${target}: ${err.message}`);
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
