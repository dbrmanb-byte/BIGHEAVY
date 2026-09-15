/* Social preview cards, 1200×630, one per site.
 *
 * A link to any page here used to preview as the app icon in a small square —
 * which is what `twitter:card: summary` and a 512px image get you. These are
 * the large landscape cards every platform actually renders, drawn from the
 * registry so a new app gets one without anybody remembering to make it.
 *
 * Output: apps/<slug>/src/og.png, and apps/hub/src/og.png for the front door.
 * Run after changing an app's name, exam list or counts:
 *
 *   node scripts/build-og.mjs [slug ...]        (default: hub + every shipped app)
 *
 * Needs Playwright, so it is a local tool — the PNGs are committed and the
 * Netlify build only copies them.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reg = JSON.parse(await readFile(join(ROOT, "packages/registry/apps.json"), "utf8"));
const SHIPPED = new Set(["live", "free"]);
const apps = reg.apps.filter(a => SHIPPED.has(a.status));

const wanted = process.argv.slice(2);
const targets = [];
if (!wanted.length || wanted.includes("hub")) {
  targets.push({
    slug: "hub",
    accent: "#EBA83A",
    kicker: "STUDY APPS &amp; COMPANION BOOKS",
    title: "Study apps for<br>licensing exams",
    sub: `${apps.length} exams. Free to start. Works offline.`,
    meta: apps.slice(0, 6).map(a => a.exam.split("·")[0].trim()).join("  ·  "),
  });
}
for (const a of apps) {
  if (wanted.length && !wanted.includes(a.slug)) continue;
  const bits = [];
  if (a.terms) bits.push(`${a.terms} terms`);
  if (a.questions) bits.push(`${a.questions} scenarios`);
  bits.push("works offline");
  targets.push({
    slug: a.slug,
    accent: a.accent || "#EBA83A",
    kicker: esc(a.exam),
    title: esc(a.name),
    sub: esc(a.audience || ""),
    meta: bits.join("  ·  "),
  });
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* The card. Dark ground and the accent as a full-height rail, so the eleven
   cards read as one family with a different stripe rather than eleven designs. */
const card = t => `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:1200px;height:630px;background:#0E1A20;overflow:hidden;}
.card{width:1200px;height:630px;display:flex;color:#DCE8ED;
  font-family:'Bricolage Grotesque','DejaVu Sans',sans-serif;}
.rail{width:18px;height:630px;background:${t.accent};flex:0 0 18px;}
.body{flex:1;display:flex;flex-direction:column;justify-content:center;padding:66px 74px;}
.bh{font-family:'IBM Plex Mono','DejaVu Sans Mono',monospace;font-size:19px;font-weight:700;
  letter-spacing:.34em;color:#EBA83A;text-transform:uppercase;}
.bh::after{content:"";display:block;width:52px;height:3px;background:#EBA83A;margin-top:13px;}
.kicker{font-family:'IBM Plex Mono','DejaVu Sans Mono',monospace;font-size:21px;letter-spacing:.2em;
  color:${t.accent};text-transform:uppercase;margin-top:40px;}
h1{font-weight:800;font-size:${t.title.length > 34 ? 62 : 74}px;line-height:1.04;letter-spacing:-.028em;
  margin-top:16px;max-width:980px;}
.sub{font-size:29px;color:#8FA8B3;margin-top:20px;max-width:840px;line-height:1.35;}
.meta{font-family:'IBM Plex Mono','DejaVu Sans Mono',monospace;font-size:19px;letter-spacing:.14em;
  color:#6E8A96;text-transform:uppercase;margin-top:auto;padding-top:34px;}
.site{position:absolute;right:74px;bottom:56px;font-family:'IBM Plex Mono','DejaVu Sans Mono',monospace;
  font-size:19px;letter-spacing:.16em;color:#8FA8B3;}
</style></head><body>
<div class="card">
  <div class="rail"></div>
  <div class="body">
    <div class="bh">BIGHEAVYINK</div>
    <div class="kicker">${t.kicker}</div>
    <h1>${t.title}</h1>
    <div class="sub">${t.sub}</div>
    <div class="meta">${t.meta}</div>
  </div>
</div>
<div class="site">bigheavyink.com</div>
</body></html>`;

const { chromium } = await import("/opt/node22/lib/node_modules/playwright/index.mjs");
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

for (const t of targets) {
  const dir = join(ROOT, "apps", t.slug, "src");
  if (!existsSync(dir)) { console.error(`  skip ${t.slug}: no src directory`); continue; }
  const tmp = join(ROOT, "apps", t.slug, "src", ".og.html");
  await writeFile(tmp, card(t));
  await page.goto("file://" + tmp, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  if (!await page.evaluate(() => document.fonts.check('70px "Bricolage Grotesque"'))) {
    console.error("  brand fonts did not load — the cards would render in a fallback face");
    process.exit(1);
  }
  await page.screenshot({ path: join(dir, "og.png"), type: "png" });
  const { unlink } = await import("node:fs/promises");
  await unlink(tmp);
  console.log(`  og.png  ${t.slug}`);
}
await browser.close();
console.log(`\n  ${targets.length} card(s) written`);
