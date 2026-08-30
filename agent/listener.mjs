// agent/listener.mjs
// The Agent OS listener: a small always-on HTTP service that receives the
// structured events the Supabase functions emit (signup, ebook purchase,
// subscription) and acts on them — today, by sending the thank-you emails.
//
// It is deliberately the *optional* half of the notification system. Slack
// notices and the purchases themselves never depend on this process: if the
// machine is off, the functions log "agent notice failed" and everything else
// carries on. When it comes back, new events flow again.
//
//   Run:      node agent/listener.mjs          (see agent/README.md for setup)
//   Health:   GET  /            -> "ok"
//   Events:   POST /            with the x-notify-token header
//
// Environment (see agent/.env.example):
//   NOTIFY_TOKEN     required — must equal the Supabase secret of the same
//                    name; posts without it are rejected.
//   RESEND_API_KEY   optional — with it, emails send through Resend from
//                    MAIL_FROM. Without it the listener runs in dry-run mode
//                    and prints each email to the log instead of sending,
//                    which is also how you test the pipeline safely.
//   MAIL_FROM        sender, default "BIGHEAVYINK <hello@bigheavyink.com>"
//                    — the domain must be verified in Resend before real
//                    sends will be accepted.
//   PORT             default 8787.
//
// No dependencies. Node 18+ (built-in fetch).

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TOKEN = process.env.NOTIFY_TOKEN || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.MAIL_FROM || "BIGHEAVYINK <hello@bigheavyink.com>";
const PORT = Number(process.env.PORT || 8787);
const SITE = "https://bigheavyink.com";

if (!TOKEN) {
  console.error("NOTIFY_TOKEN is not set — refusing to start with an open door.");
  process.exit(1);
}

// Book titles come from the registry so the emails name real products.
const here = dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(readFileSync(join(here, "../packages/registry/apps.json"), "utf8"));
const bySlug = new Map(registry.apps.map(a => [a.slug, a]));
const bookTitle = slug => bySlug.get(slug)?.ebook?.title ?? slug;
const appName = slug => bySlug.get(slug)?.name ?? slug;

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- email sending ---------------- */

async function sendEmail(to, subject, html) {
  if (!RESEND_KEY) {
    log(`DRY RUN — would email ${to}: "${subject}"`);
    log(html);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`resend ${res.status}: ${body}`);
  log(`emailed ${to}: "${subject}"`);
}

const wrap = inner => `
<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <h2 style="font-family: Arial, Helvetica, sans-serif; letter-spacing: -0.5px; margin: 0 0 4px;">BIGHEAVYINK</h2>
  <p style="font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #8a8a8a; letter-spacing: 2px; text-transform: uppercase; margin: 0 0 24px;">Study apps &amp; books</p>
  ${inner}
  <p style="font-size: 13px; color: #8a8a8a; line-height: 1.6; margin-top: 32px;">
    Questions? Just reply, or use the contact form at
    <a href="${SITE}/contact.html" style="color: #8a8a8a;">bigheavyink.com/contact</a>.
  </p>
</div>`;

const btn = (href, label) => `
  <p style="margin: 24px 0;">
    <a href="${href}" style="background: #EBA83A; color: #1a1206; text-decoration: none; font-family: Arial, Helvetica, sans-serif; font-weight: bold; padding: 13px 26px; border-radius: 6px; display: inline-block;">${label}</a>
  </p>`;

/* ---------------- event handlers ---------------- */

async function onEbookPurchase(ev) {
  if (!ev.email) { log("ebook purchase with no email — nothing to send", ev); return; }
  const titles = (ev.ebooks || []).map(bookTitle);
  const list = titles.map(t => `<li style="margin: 4px 0;">${t}</li>`).join("");
  const discount = ev.discount_code ? `
  <p style="font-size: 15px; line-height: 1.7;">
    And a thank-you for building your library: code
    <b style="font-family: 'Courier New', monospace;">${ev.discount_code}</b>
    takes a percentage off an Unlimited or Pro subscription at checkout. It is tied
    to your account and waits until you want it.
  </p>` : "";

  await sendEmail(
    ev.email,
    titles.length === 1 ? `Your book: ${titles[0]}` : `Your ${titles.length} books are ready`,
    wrap(`
  <p style="font-size: 16px; line-height: 1.6;">Thank you — your ${titles.length === 1 ? "book is" : "books are"} ready to download:</p>
  <ul style="font-size: 15px; line-height: 1.7;">${list}</ul>
  ${btn(`${SITE}/library.html`, "Open your library")}
  <p style="font-size: 15px; line-height: 1.7;">
    Download from any device you sign into — the book is yours, stamped with your
    purchase. The matching study app has a free tier whenever you want to drill
    what you read.
  </p>
  ${discount}`)
  );
}

async function onSubscription(ev) {
  if (!ev.email) { log("subscription with no email — nothing to send", ev); return; }
  const all = ev.tier === "all_access";
  const name = all ? "Unlimited" : `Pro — ${appName(ev.app)}`;

  await sendEmail(
    ev.email,
    `Welcome to ${all ? "Unlimited" : "Pro"}`,
    wrap(`
  <p style="font-size: 16px; line-height: 1.6;">Your <b>${name}</b> subscription is live.</p>
  <p style="font-size: 15px; line-height: 1.7;">
    ${all
      ? "Every question bank in every app is unlocked — all ten exams, full practice sets, and the on-device tutor where your hardware supports it."
      : `The full question bank in ${appName(ev.app)} is unlocked — every practice set, with the reasoning behind each answer, and the on-device tutor where your hardware supports it.`}
    Everything keeps working offline once loaded, and your progress stays on your device.
  </p>
  ${btn(all ? `${SITE}/#apps` : (bySlug.get(ev.app)?.url ?? SITE), "Start studying")}
  <p style="font-size: 15px; line-height: 1.7;">
    Manage or cancel any time from the store — access always runs to the end of
    what you have paid for.
  </p>`)
  );
}

function onSignup(ev) {
  // Supabase already sends the branded confirmation email at signup; a second
  // email here would be noise. Logged so the agent has the full picture.
  log("signup:", ev.email ?? ev.profile_id ?? "unknown");
}

/* ---------------- the server ---------------- */

const server = createServer(async (req, res) => {
  if (req.method === "GET") { res.writeHead(200); return res.end("ok"); }
  if (req.method !== "POST") { res.writeHead(405); return res.end("POST only"); }
  if (req.headers["x-notify-token"] !== TOKEN) { res.writeHead(401); return res.end("nope"); }

  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 65536) req.destroy(); });
  req.on("end", async () => {
    let ev;
    try { ev = JSON.parse(raw); } catch { res.writeHead(400); return res.end("bad json"); }
    log("event:", ev.event ?? "?", ev.email ?? "");
    try {
      if (ev.event === "ebook_purchase") await onEbookPurchase(ev);
      else if (ev.event === "subscription") await onSubscription(ev);
      else if (ev.event === "signup") onSignup(ev);
      else log("unhandled event:", ev);
    } catch (err) {
      // The sender never retries and must never be failed by us; log and move on.
      console.error("handler failed:", err);
    }
    res.writeHead(200);
    res.end("ok");
  });
});

server.listen(PORT, () => {
  log(`agent listener on :${PORT}${RESEND_KEY ? "" : "  (DRY RUN — no RESEND_API_KEY, emails print to this log)"}`);
});
