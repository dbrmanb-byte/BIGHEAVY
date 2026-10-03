// js/tiers.js
// Manages subscription tiers on the client side.
// Gates features, shows upgrade prompts, and redirects to Stripe Checkout.

import { getClient, getUser, onAuthChange, signOut } from "./supabase-client.js";
import * as Checkout from "./checkout.js";

// Purchases go through checkout.js — the checkout edge function creates the
// Stripe session from a price lookup_key, so no payment link lives in source.
// Cancelling goes through the same module's manage(), Stripe's customer portal.

// ---- Tier state ----
let _tier = { tier: "free", tier_app: null, is_active: true };
const _listeners = new Set();

/* Which app this build is. Entitlement is decided against this and nothing else:
     <script>window.BH_APP_ID = "casebook-lcsw";</script>

   APP_FAMILY is descriptive only — grouping for copy and analytics. It is
   deliberately NOT part of the entitlement check; see _coversThisApp. */
export const APP_ID     = (typeof window !== "undefined" && window.BH_APP_ID) || null;
export const APP_FAMILY = (typeof window !== "undefined" && window.BH_APP_FAMILY) || null;

export function getTier() { return _tier; }

/* True when the subscription actually covers THIS app.

   all_access covers every app. Pro covers exactly ONE, named by tier_app, which
   holds an app slug — not a family. A family match is deliberately not accepted:
   "casebook" would otherwise unlock four apps and "forge" five, for the price of
   one, and all-access would have nothing left to sell.

   A missing tier_app does NOT grant access. Fail closed: an unscoped pro record
   is a misconfiguration, and reading it generously hands over the catalogue. */
function _coversThisApp() {
  if (_tier.tier === "all_access") return true;
  if (_tier.tier !== "pro") return false;
  const scope = _tier.tier_app;
  if (!scope) return false;
  return scope === APP_ID;
}

export function isPro() { return _tier.is_active && _coversThisApp(); }
export function isAllAccess() { return _tier.is_active && _tier.tier === "all_access"; }
export function isFree() { return !isPro(); }

/* Distinguishes "you pay us, but for a different app" from "you do not pay us",
   so the upgrade prompt can say something true. */
export function isPaidElsewhere() {
  return _tier.is_active && _tier.tier === "pro" && !!_tier.tier_app && !_coversThisApp();
}

export function onTierChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _notify() { _listeners.forEach(fn => fn(_tier)); }

// ---- Fetch tier from server ----
export async function refreshTier() {
  const user = getUser();
  const client = getClient();
  if (!user || !client) {
    _tier = { tier: "free", tier_app: null, is_active: true };
    _notify();
    return;
  }
  try {
    const { data, error } = await client.rpc("my_tier");
    if (!error && data) {
      _tier = data;
    }
  } catch (e) {
    console.warn("tier fetch failed:", e);
  }
  _notify();
}

// Re-check tier on auth change
onAuthChange(() => refreshTier());

// ---- Feature gates ----

const GATES = {
  set_50:        () => isPro(),
  set_100:       () => isPro(),
  set_150:       () => isPro(),
  exam_mode:     () => isPro(),
  adaptive:      () => isPro(),
  dashboard:     () => isPro(),
  sync:          () => getUser() !== null,
  weak_weight:   () => isPro(),
  tutor:         () => isPro(),
};
// `ebook` is deliberately absent. Books are sold per title ($9.99) and are not
// part of any plan, so entitlement is ownership — ask ebooks.js ownsBook(slug),
// which reads the purchase table, rather than asking about a tier here.

/**
 * Check if a feature is unlocked.
 * Unknown names are denied, not allowed: a typo in a gate name should fail
 * visibly during development rather than quietly hand out a paid feature.
 * @param {string} feature - one of: set_50, set_100, set_150, exam_mode,
 *   adaptive, dashboard, sync, ebook, weak_weight, tutor
 * @returns {boolean}
 */
export function can(feature) {
  const gate = GATES[feature];
  if (!gate) {
    console.warn(`tiers: unknown feature "${feature}" — denying. Add it to GATES.`);
    return false;
  }
  return gate();
}

// ---- Upgrade flow ----

/**
 * Open the upgrade modal.
 * @param {string} reason - human-readable reason shown in the modal
 */
export function showUpgrade(reason) {
  const modal = document.getElementById("upgradeModal");
  const scrim = document.getElementById("upgradeScrim");
  const msg = document.getElementById("upgradeReason");
  if (!modal || !scrim) return;

  const app = window.CASEBOOK_APP_NAME || "this app";

  // Someone already paying for a different app is not an upsell target for Pro
  // — telling them to "upgrade" when they already subscribe reads as a bug.
  let text = reason || "Upgrade to unlock this feature.";
  if (isPaidElsewhere()) {
    text = `Your Pro subscription covers a different app. All-access unlocks ${app} too.`;
  }
  if (msg) msg.textContent = text;
  scrim.classList.remove("hide");

  const proDesc = document.getElementById("proDesc");
  if (proDesc) proDesc.textContent = `Full access to ${app}`;
}

export function hideUpgrade() {
  const scrim = document.getElementById("upgradeScrim");
  if (scrim) scrim.classList.add("hide");
}

/**
 * Start a purchase from the upgrade modal.
 * @param {'pro'|'all_access'} plan  pro covers this app (APP_ID); all_access, every app
 */
export function checkout(plan) {
  if (plan === "all_access") return Checkout.start(Checkout.keyFor.allAccess());
  if (plan === "pro" && APP_ID) return Checkout.start(Checkout.keyFor.pro(APP_ID));
  alert("That plan is not available here. Nothing was charged.");
}

/** Has a paid plan of any kind — the thing a "Manage subscription" button needs. */
export function hasSubscription() {
  return _tier.is_active !== false && (_tier.tier === "pro" || _tier.tier === "all_access");
}

/* ---- Account sheet ----
   What the account button opens once signed in: who you are, what you pay
   for, and the way out — "Manage subscription" opens Stripe's portal, where
   cancelling is one click. Built here so every app gets the same sheet. */
let _sheet = null;

export function openAccount() {
  const user = getUser();
  if (!user) return;
  if (!_sheet) {
    _sheet = document.createElement("div");
    _sheet.id = "bhAccount";
    _sheet.innerHTML = `
      <style>
        #bhAccount{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
          background:rgba(8,15,19,.75);padding:18px;}
        #bhAccount[hidden]{display:none;}
        #bhAccount .box{position:relative;background:var(--surface,#1B2F38);border:1px solid var(--line,#2E4A56);
          border-radius:8px;padding:24px 22px;max-width:380px;width:100%;color:var(--text,#DCE8ED);}
        #bhAccount h3{margin:0 0 4px;font-size:18px;font-weight:800;letter-spacing:-.01em;}
        #bhAccount .who{margin:0 0 14px;font-size:13px;color:var(--text-dim,#8FA8B3);overflow-wrap:anywhere;}
        #bhAccount .plan{margin:0 0 18px;font-size:14.5px;line-height:1.5;}
        #bhAccount .row{display:flex;flex-direction:column;gap:9px;}
        #bhAccount button.b{border-radius:5px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer;
          border:1px solid var(--line,#2E4A56);background:none;color:inherit;}
        #bhAccount button.gold{background:var(--gold,#EBA83A);border-color:var(--gold,#EBA83A);color:#141414;}
        #bhAccount .fine{margin:12px 0 0;font-size:11.5px;line-height:1.5;color:var(--text-dim,#8FA8B3);}
        #bhAccount .x{position:absolute;top:8px;right:12px;background:none;border:none;color:inherit;font-size:22px;cursor:pointer;}
      </style>
      <div class="box" role="dialog" aria-modal="true" aria-label="Your account">
        <button class="x" data-a="close" aria-label="Close">&times;</button>
        <h3>Your account</h3>
        <p class="who"></p>
        <p class="plan"></p>
        <div class="row">
          <button class="b gold" data-a="manage">Manage subscription</button>
          <button class="b" data-a="upgrade">See plans</button>
          <button class="b" data-a="signout">Sign out</button>
        </div>
        <p class="fine">Cancel any time under Manage subscription. Access runs to the end of the month you have paid for, and your study progress is never erased.</p>
      </div>`;
    document.body.appendChild(_sheet);
    _sheet.addEventListener("click", e => {
      const act = e.target === _sheet ? "close" : e.target.dataset?.a;
      if (!act) return;
      if (act === "close") _sheet.hidden = true;
      else if (act === "manage") { e.target.textContent = "Opening…"; Checkout.manage(); }
      else if (act === "upgrade") { _sheet.hidden = true; showUpgrade(); }
      else if (act === "signout") { _sheet.hidden = true; signOut(); }
    });
  }
  const app = window.CASEBOOK_APP_NAME || "this app";
  const paid = hasSubscription();
  const plan = _tier.tier === "all_access" ? "Unlimited — every app is unlocked."
    : isPro() ? `Pro — ${app} is fully unlocked.`
    : isPaidElsewhere() ? "Pro — for a different app. This one is on the free tier."
    : "Free tier.";
  _sheet.querySelector(".who").textContent = user.email || "Signed in";
  _sheet.querySelector(".plan").textContent = plan;
  const manage = _sheet.querySelector('[data-a="manage"]');
  manage.textContent = "Manage subscription";
  manage.hidden = !paid;
  _sheet.querySelector('[data-a="upgrade"]').hidden = _tier.tier === "all_access" && paid;
  _sheet.querySelector(".fine").hidden = !paid;
  _sheet.hidden = false;
}

/**
 * Require a feature gate. If not met, show upgrade and return false.
 * Usage: if (!requireGate('set_150', 'Full-length simulations require Pro.')) return;
 */
export function requireGate(feature, reason) {
  if (can(feature)) return true;

  if (!getUser()) {
    // Not signed in — prompt auth first
    const userBtn = document.getElementById("userBtn");
    if (userBtn) userBtn.click();
    return false;
  }

  showUpgrade(reason);
  return false;
}
