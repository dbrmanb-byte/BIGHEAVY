/* Generate a companion book from the app's own content.
 *
 * The books were previously produced somewhere else, which is why one of them
 * still called itself "Casebook" after the app became "Casebook LMSW". Building
 * them from the registry and the question bank means a book cannot disagree with
 * the app it accompanies, and a content fix reaches the PDF by rebuilding.
 *
 * Renders HTML and prints it through Chromium, so layout is CSS rather than a
 * hand-rolled engine.
 *
 * Usage: node scripts/build-ebook.mjs <slug> [...]      (default: every book)
 *        node scripts/build-ebook.mjs casebook --html   (leave the HTML for a look)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "ebooks");

const args = process.argv.slice(2);
const keepHtml = args.includes("--html");
const wanted = args.filter(a => !a.startsWith("--"));

const registry = JSON.parse(await readFile(join(ROOT, "packages/registry/apps.json"), "utf8"));
const books = (registry.apps || []).filter(a => a.ebook && (!wanted.length || wanted.includes(a.slug)));

if (!books.length) {
  console.error("build-ebook: nothing to build. Known books:",
    (registry.apps || []).filter(a => a.ebook).map(a => a.slug).join(", "));
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("build-ebook: needs playwright-core.  pnpm add -Dw playwright-core");
  process.exit(1);
}

const EXE = process.env.CHROMIUM_PATH
  || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const esc = s => String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* Category display names, matching the apps. Anything unknown falls through
   as-is rather than being dropped. */
const CAT_LABEL = {
  HBSE: "Human Behavior & Development", Assessment: "Assessment & Diagnosis",
  Intervention: "Intervention & Treatment", Ethics: "Ethics & Professional Practice",
  Policy: "Policy & Programs", Research: "Research & Evaluation",
  Diversity: "Diversity & Social Justice", Supervision: "Supervision & Development",
};
const CAT_COLOR = {
  HBSE: "#E4703A", Assessment: "#3FA9B8", Intervention: "#7B8FE0", Ethics: "#D9455F",
  Policy: "#5FB86B", Research: "#C77CD6", Diversity: "#E0B23A", Supervision: "#93A4AF",
};

/** The app bundle holds the glossary; the bank holds every question. */
async function loadContent(slug) {
  const freePath = join(ROOT, "apps", slug, "src", "content-free.js");
  const bankPath = join(ROOT, "content", slug, "bank.json");

  let cards = [], questions = [];

  if (existsSync(freePath)) {
    const t = await readFile(freePath, "utf8");
    const json = t.slice(t.indexOf("window.DATA = ") + 14, t.lastIndexOf(";"));
    const data = JSON.parse(json);
    cards = data.cards || [];
    questions = data.questions || [];
  }

  if (existsSync(bankPath)) {
    // The bank is the complete set, answers included — which is exactly what a
    // book is. It is not committed, so a build needs it present locally.
    const bank = JSON.parse(await readFile(bankPath, "utf8"));
    if (bank.questions?.length) questions = bank.questions;
  }

  return { cards, questions };
}

function groupByCat(items) {
  const m = new Map();
  for (const it of items) {
    if (!m.has(it.cat)) m.set(it.cat, []);
    m.get(it.cat).push(it);
  }
  return m;
}

function buildHtml(app, { cards, questions }) {
  const accent = app.accent || "#EBA83A";
  const title = app.ebook.title;
  const cardCats = groupByCat(cards);
  const qCats = groupByCat(questions);

  const contents = [
    `<li><span>How to Use This Book</span></li>`,
    `<li><span>Glossary</span></li>`,
    ...[...cardCats.entries()].map(([c, list]) =>
      `<li class="sub"><span>${esc(CAT_LABEL[c] || c)}</span><em>${list.length} terms</em></li>`),
    `<li><span>Practice Scenarios</span><em>${questions.length} items</em></li>`,
  ].join("");

  const glossary = [...cardCats.entries()].map(([c, list]) => `
    <section class="cat">
      <h2 style="--c:${esc(CAT_COLOR[c] || accent)}">${esc(CAT_LABEL[c] || c)}</h2>
      <dl>${list.map(t => `
        <div class="term"><dt>${esc(t.term)}</dt><dd>${esc(t.def)}</dd></div>`).join("")}
      </dl>
    </section>`).join("");

  const scenarios = [...qCats.entries()].map(([c, list]) => `
    <section class="cat">
      <h2 style="--c:${esc(CAT_COLOR[c] || accent)}">${esc(CAT_LABEL[c] || c)}</h2>
      ${list.map((q, i) => `
        <article class="q">
          <p class="qn">${esc(c)} · ${i + 1} of ${list.length}</p>
          <p class="stem">${esc(q.stem)}</p>
          <ol class="choices">${(q.choices || []).map((ch, j) =>
            `<li${j === q.answer ? ' class="right"' : ""}>${esc(ch)}</li>`).join("")}</ol>
          <p class="ans"><b>Answer: ${"ABCD"[q.answer] || "?"}</b>${q.label ? " — " + esc(q.label) : ""}</p>
          ${q.why ? `<p class="why">${esc(q.why)}</p>` : ""}
        </article>`).join("")}
    </section>`).join("");

  const head = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: Georgia, "Times New Roman", serif; color:#1A1A1A;
         font-size: 10.5pt; line-height: 1.5; }
  h1,h2,h3,.mono { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .mono { font-family: "SF Mono", Menlo, Consolas, monospace; }

  /* cover — its own document, printed with no page margin so it bleeds */
  .cover { position:relative; background:#0E1A20; color:#F2EDE3;
           width: 216mm; height: 279mm; padding: 30mm 24mm;
           display:flex; flex-direction:column; }
  .cover .brand { font-family:"SF Mono",Menlo,monospace; font-size:8.5pt; letter-spacing:.34em;
                  color:${accent}; text-transform:uppercase; }
  .cover .rule { width:38px; height:2px; background:${accent}; margin:7px 0 auto; }
  .cover h1 { font-family: Georgia, serif; font-size:44pt; font-weight:700; margin:0 0 10mm;
              letter-spacing:-.02em; line-height:1.02; }
  .cover .sub { font-size:13pt; color:#9FC7D4; max-width:78%; line-height:1.5; margin-bottom:auto; }
  .cover .foot { font-family:"SF Mono",Menlo,monospace; font-size:8pt; color:#8FA8B3; line-height:1.8; }
  .cover .foot b { color:${accent}; display:block; letter-spacing:.2em; }

  .body { padding: 20mm 18mm 18mm; }
  .page-break { page-break-before: always; }
  h2 { font-size:13pt; margin:0 0 4mm; padding-bottom:2mm; letter-spacing:-.01em;
       border-bottom:2px solid var(--c, ${accent}); page-break-after: avoid; }
  h3 { font-size:11pt; margin:0 0 3mm; }
  .lead { font-size:11pt; color:#4A4A4A; }

  ol.toc { list-style:none; padding:0; margin:0; }
  ol.toc li { display:flex; justify-content:space-between; gap:8px; padding:2.4mm 0;
              border-bottom:1px dotted #CFCFCF; }
  ol.toc li.sub { padding-left:8mm; font-size:9.5pt; color:#555; border-bottom-style:none; }
  ol.toc em { font-style:normal; font-family:"SF Mono",Menlo,monospace; font-size:8.5pt; color:#777; }

  .cat { page-break-before: always; }
  .term { page-break-inside: avoid; margin-bottom:3.4mm; }
  dt { font-weight:700; font-size:10.5pt; }
  dd { margin:0.6mm 0 0; color:#333; }

  .q { page-break-inside: avoid; margin-bottom:6mm; padding-bottom:4mm;
       border-bottom:1px solid #E4E4E4; }
  .qn { font-family:"SF Mono",Menlo,monospace; font-size:7.5pt; letter-spacing:.14em;
        text-transform:uppercase; color:#8A8A8A; margin:0 0 1.6mm; }
  .stem { margin:0 0 2.4mm; }
  ol.choices { margin:0 0 2.4mm; padding-left:6mm; }
  ol.choices li { margin-bottom:1mm; }
  ol.choices li.right { font-weight:700; }
  .ans { margin:0 0 1.6mm; font-size:10pt; }
  .why { margin:0; color:#3A3A3A; background:#F4F1EA; border-left:2px solid ${accent};
         padding:2.2mm 3mm; font-size:9.5pt; }

  .note { border-left:2px solid #CCC; padding-left:4mm; color:#4A4A4A; }
</style></head><body>`;

  const cover = head + `
<div class="cover">
  <div class="brand">BIGHEAVYINK</div><div class="rule"></div>
  <h1>${esc(app.name)}</h1>
  <p class="sub">${esc(title)} — the complete glossary and every practice rationale for the ${esc(app.exam)} exam.</p>
  <div class="foot"><b>BIGHEAVYINK</b>Study aid only. Not affiliated with any licensing board.</div>
</div>
</body></html>`;

  const body = head + `
<div class="body">
<h2>Contents</h2>
<ol class="toc">${contents}</ol>

<div class="page-break"></div>
<h2>How to Use This Book</h2>
<p class="lead">This is the reading companion to ${esc(app.name)}. The app is where you drill;
this is where you read.</p>
<p>The glossary is the language of the exam. Read it start to finish once, then use it to look
things up. Definitions are written to be recognised under time pressure, not to be exhaustive.</p>
<p>The practice scenarios are the same items as the app, printed with their answers and the
reasoning behind them. Reading a rationale you already got right is not wasted time — the exam
tests whether you can name <em>why</em>, not just pick the option that feels correct.</p>
<p class="note">Study aid only. This is condensed revision material, not official exam
material, and it is not affiliated with or endorsed by any licensing board. Verify anything you
plan to rely on against current primary sources and your jurisdiction's rules.</p>

<div class="page-break"></div>
<h2>Glossary</h2>
<p class="lead">${cards.length} terms across ${cardCats.size} areas.</p>
${glossary}

<div class="page-break"></div>
<h2>Practice Scenarios</h2>
<p class="lead">${questions.length} items with answers and rationales.</p>
${scenarios}
</div>
</body></html>`;

  return { cover, body };
}

/** Stitch the cover in front of the body and set the document metadata.
    The title matters: readers see it in the tab and the file properties, and it
    is the thing that was wrong on the book this generator replaces. */
async function joinPdfs(coverBytes, bodyBytes, meta) {
  const { PDFDocument } = await import("pdf-lib");
  const out = await PDFDocument.create();

  for (const bytes of [coverBytes, bodyBytes]) {
    const src = await PDFDocument.load(bytes);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach(p => out.addPage(p));
  }

  out.setTitle(meta.title);
  out.setAuthor(meta.author);
  out.setSubject(meta.subject);
  out.setCreationDate(new Date());
  return Buffer.from(await out.save());
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: EXE });
let failed = false;

for (const app of books) {
  const content = await loadContent(app.slug);
  if (!content.cards.length && !content.questions.length) {
    console.error(`  FAIL ${app.slug}: no content found (is content/${app.slug}/bank.json present?)`);
    failed = true;
    continue;
  }

  const { cover, body } = buildHtml(app, content);
  if (keepHtml) await writeFile(join(OUT, `${app.slug}.html`), cover + body);

  // Two passes, because the two halves want opposite page settings: the cover
  // has to bleed to the paper edge (no margin, no running footer), and the body
  // needs margins and a page number on every leaf.
  const coverPage = await browser.newPage();
  await coverPage.setContent(cover, { waitUntil: "load" });
  const coverPdf = await coverPage.pdf({
    format: "Letter", printBackground: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" },
  });
  await coverPage.close();

  const bodyPage = await browser.newPage();
  await bodyPage.setContent(body, { waitUntil: "load" });
  const bodyPdf = await bodyPage.pdf({
    format: "Letter",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<div></div>",
    footerTemplate:
      `<div style="width:100%;font:8px -apple-system,Helvetica,sans-serif;color:#9A9A9A;
        padding:0 18mm;display:flex;justify-content:space-between;">
        <span>${esc(app.ebook.title)}</span><span class="pageNumber"></span></div>`,
    margin: { top: "16mm", bottom: "16mm", left: "0", right: "0" },
  });
  await bodyPage.close();

  const pdf = await joinPdfs(coverPdf, bodyPdf, {
    title: app.ebook.title,
    author: "BIGHEAVYINK",
    subject: `${app.name} — ${app.exam}`,
  });

  // The file is named for the slug because the download function fetches
  // "<slug>.pdf" — a title-based name would 404 for every buyer.
  await writeFile(join(OUT, `${app.slug}.pdf`), pdf);
  console.log(`  built ${app.slug}.pdf  (${(pdf.length / 1024).toFixed(0)}KB, ` +
    `${content.cards.length} terms, ${content.questions.length} scenarios)`);
}

await browser.close();
process.exit(failed ? 1 : 0);
