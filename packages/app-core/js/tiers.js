// js/tiers.js
// Manages subscription tiers on the client side.
// Gates features, shows upgrade prompts, and redirects to Stripe Checkout.

import { getClient, getUser, onAuthChange } from "./supabase-client.js";

// ---- Stripe Checkout URLs ----
// Replace these after creating products in the Stripe Dashboard.
// Each key maps to a Stripe Payment Link or Checkout URL.
// You can create these at: stripe.com/docs/payment-links
const CHECKOUT_URLS = {
  pro_monthly:        "",  // e.g. "https://buy.stripe.com/xxx"
  pro_annual:         "",
  all_access_monthly: "",
  all_access_annual:  "",
};

// ---- Tier state ----
let _tier = { tier: "free", tier_app: null, is_active: true };
const _listeners = new Set();

/* Which app this build is, and which family it belongs to. Each app declares
   both before the modules load:
     <script>window.BH_APP_ID = "casebook-lcsw";
             window.BH_APP_FAMILY = "casebook";</script> */
export const APP_ID     = (typeof window !== "undefined" && window.BH_APP_ID) || null;
export const APP_FAMILY = (typeof window !== "undefined" && window.BH_APP_FAMILY) || null;

export function getTier() { return _tier; }

/* True when the subscription actually covers THIS app.

   all_access covers everything. Pro is scoped by tier_app, and the scope the
   backend writes there is a family ("casebook", "forge") — see PRICE_TO_TIER in
   the Stripe webhook. Matching the slug as well means per-app pricing can be
   introduced by changing only the price mapping, with no client release.

   Without this check any active Pro subscription unlocked every app, so a
   single Pro plan bought the whole catalogue and all-access had nothing to
   sell. A missing tier_app does NOT grant access: fail closed, or the same
   leak comes back through the webhook's unknown-price fallback. */
function _coversThisApp() {
  if (_tier.tier === "all_access") return true;
  if (_tier.tier !== "pro") return false;
  const scope = _tier.tier_app;
  if (!scope) return false;
  return scope === APP_ID || (APP_FAMILY !== null && scope === APP_FAMILY);
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
  ebook:         () => isPro(),
  weak_weight:   () => isPro(),
  tutor:         () => isPro(),
};

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
 * Redirect to Stripe Checkout.
 * @param {'pro_monthly'|'pro_annual'|'all_access_monthly'|'all_access_annual'} plan
 */
export function checkout(plan) {
  const url = CHECKOUT_URLS[plan];
  if (!url) {
    alert("Payment links are not configured yet. Set CHECKOUT_URLS in js/tiers.js.");
    return;
  }

  const user = getUser();
  // Append email as prefill if logged in
  let checkoutUrl = url;
  if (user?.email) {
    const sep = url.includes("?") ? "&" : "?";
    checkoutUrl += `${sep}prefilled_email=${encodeURIComponent(user.email)}`;
  }

  window.open(checkoutUrl, "_blank");
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
