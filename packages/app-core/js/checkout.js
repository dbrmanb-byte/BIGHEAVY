// js/checkout.js
// Start a Stripe Checkout from the browser.
//
// start("pro_casebook") / start("all_access") / start("ebook_keystone"):
// makes sure someone is signed in — the entitlement lands on an account, so
// there is no anonymous checkout — then asks the checkout edge function for a
// session URL and redirects. If the visitor is signed out, a small overlay
// handles sign in / sign up in place and the purchase resumes by itself.
//
// No Stripe code runs here. The browser only ever sees a redirect URL.

import * as SB from "./supabase-client.js";

const CFG = () => ({
  url: (typeof window !== "undefined" && window.BH_SUPABASE_URL) || "",
  key: (typeof window !== "undefined" && window.BH_SUPABASE_KEY) || "",
});

export function available() {
  const { url, key } = CFG();
  return !!(url && key);
}

/** Begin a purchase. Resolves when the redirect is underway; throws on failure. */
export async function start(lookupKey) {
  const { url, key } = CFG();
  if (!url || !key) {
    alert("The store is not connected on this build — nothing can be purchased yet.");
    return;
  }
  // The auth client loads from a CDN on first use. If that fetch fails —
  // offline, blocked network — the click must say so, not silently do nothing.
  try {
    await SB.init(url, key);
  } catch (err) {
    console.error("checkout: auth client failed to load", err);
    alert("Could not reach the sign-in service — check your connection and try again. Nothing was charged.");
    return;
  }

  if (!SB.getUser()) {
    const signedIn = await askForAccount(lookupKey);
    if (!signedIn) return;                       // they closed the box; not an error
  }

  const { data } = await SB.getClient().auth.getSession();
  const token = data?.session?.access_token;
  if (!token) { alert("Sign-in did not stick — try again."); return; }

  const res = await fetch(`${url}/functions/v1/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: key,
    },
    body: JSON.stringify({ price: lookupKey }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.url) {
    alert(out.error || "Checkout could not start. Nothing was charged.");
    return;
  }
  window.location.assign(out.url);
}

/* ---------------- the sign-in overlay ---------------- */

let overlay = null;

function askForAccount() {
  ensureOverlay();
  overlay.hidden = false;
  overlay.querySelector("input").focus();
  return new Promise(resolve => { overlay._resolve = resolve; });
}

function ensureOverlay() {
  if (overlay) return;
  const el = document.createElement("div");
  el.id = "bhAuth";
  el.hidden = true;
  el.innerHTML = `
    <style>
      #bhAuth{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;
        background:rgba(0,0,0,.55);padding:18px;}
      #bhAuth[hidden]{display:none;}
      #bhAuth .box{background:var(--surface,#1B2F38);border:1px solid var(--line,#2E4A56);border-radius:8px;
        padding:24px 22px;max-width:390px;width:100%;color:var(--text,#DCE8ED);}
      #bhAuth h3{margin:0 0 6px;font-size:18px;font-weight:800;letter-spacing:-.01em;}
      #bhAuth p{margin:0 0 16px;font-size:14px;line-height:1.5;color:var(--text-dim,#8FA8B3);}
      #bhAuth label{display:block;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
        color:var(--text-dim,#8FA8B3);margin:0 0 5px;}
      #bhAuth input{width:100%;box-sizing:border-box;background:var(--ground,#132229);color:inherit;
        border:1px solid var(--line,#2E4A56);border-radius:5px;padding:10px 12px;font:inherit;margin-bottom:12px;}
      #bhAuth input:focus{border-color:var(--gold,#EBA83A);outline:none;}
      #bhAuth .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
      #bhAuth .go{background:var(--gold,#EBA83A);color:#141414;border:none;border-radius:5px;
        padding:11px 18px;font:inherit;font-weight:600;cursor:pointer;}
      #bhAuth .alt{background:none;border:none;color:var(--text-dim,#8FA8B3);text-decoration:underline;
        font:inherit;font-size:12.5px;cursor:pointer;padding:0;}
      #bhAuth .msg{min-height:1.2em;font-size:12px;margin-top:10px;}
      #bhAuth .msg.err{color:#D9455F;}
      #bhAuth .msg.ok{color:var(--good,#5FB86B);}
      #bhAuth .x{position:absolute;top:10px;right:14px;background:none;border:none;color:inherit;
        font-size:22px;cursor:pointer;}
      #bhAuth .box{position:relative;}
    </style>
    <div class="box" role="dialog" aria-modal="true" aria-label="Sign in to continue">
      <button class="x" data-a="close" aria-label="Close">&times;</button>
      <h3>Sign in to continue</h3>
      <p>The purchase attaches to your account, so it works on any device you sign into. New here? The same form creates the account.</p>
      <label for="bhEmail">Email</label>
      <input id="bhEmail" type="email" autocomplete="email">
      <label for="bhPw">Password</label>
      <input id="bhPw" type="password" autocomplete="current-password">
      <div class="row">
        <button class="go" data-a="signin">Sign in</button>
        <button class="alt" data-a="signup">Create account</button>
        <button class="alt" data-a="magic">Email me a link</button>
      </div>
      <p class="msg" aria-live="polite"></p>
    </div>`;
  document.body.appendChild(el);
  overlay = el;

  const msg = (t, kind) => {
    const m = el.querySelector(".msg");
    m.className = "msg" + (kind ? " " + kind : "");
    m.textContent = t;
  };

  el.addEventListener("click", async e => {
    if (e.target === el || e.target.dataset.a === "close") {
      el.hidden = true; el._resolve?.(false); return;
    }
    const act = e.target.dataset.a;
    if (!act || act === "close") return;
    const email = el.querySelector("#bhEmail").value.trim();
    const pw = el.querySelector("#bhPw").value;

    try {
      if (act === "signin") {
        if (!email || !pw) return msg("Email and password, please.", "err");
        msg("Signing in…");
        await SB.signIn(email, pw);
      } else if (act === "signup") {
        if (!email || !pw) return msg("Email and password, please.", "err");
        if (pw.length < 8) return msg("Password needs at least 8 characters.", "err");
        msg("Creating your account…");
        await SB.signUp(email, pw);
        if (!SB.getUser()) return msg("Check your inbox to confirm the account, then come back and sign in.", "ok");
      } else if (act === "magic") {
        if (!email) return msg("Enter your email first.", "err");
        msg("Sending…");
        await SB.signInMagicLink(email);
        return msg("Check your inbox for the sign-in link, then come back and try again.", "ok");
      }
      if (SB.getUser()) { el.hidden = true; el._resolve?.(true); }
    } catch (err) {
      msg(err.message || "That did not work.", "err");
    }
  });
}

/** The lookup_key convention the Stripe catalogue was created with. */
export const keyFor = {
  pro: slug => "pro_" + String(slug).replace(/-/g, "_"),
  allAccess: () => "all_access",
  ebook: slug => "ebook_" + String(slug).replace(/-/g, "_"),
};
