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

/* Which app this build is. Pro covers ONE app, so entitlement has to be checked
   against this id — the server returns tier_app naming the app that was paid
   for. Each app declares itself before the modules load:
     <script>window.BH_APP_ID = "keystone";</script> */
export const APP_ID = (typeof window !== "undefined" && window.BH_APP_ID) || null;

export function getTier() { return _tier; }

/* True when the subscription actually covers THIS app. all_access covers every
   app; pro covers only the one named in tier_app. Without this check a single
   $7.99 Pro subscription would unlock all ten apps and there would be no reason
   to buy all-access. A missing tier_app is treated as not covering: fail closed,
   because failing open gives the whole catalogue away. */
function _coversThisApp() {
  if (_tier.tier === "all_access") return true;
  if (_tier.tier !== "pro") return false;
  if (!_tier.tier_app) return false;
  if (!APP_ID) return false;
  return _tier.tier_app === APP_ID;
}

export function isPro() { return _tier.is_active && _coversThisApp(); }
export function isAllAccess() { return _tier.is_active && _tier.tier === "all_access"; }
export function isFree() { return !isPro(); }

/* Distinguishes "you pay us, but for a different app" from "you do not pay us",
   so the upgrade prompt can say something true. */
export function isPaidElsewhere() {
  return _tier.is_active && _tier.tier === "pro" && !!_tier.tier_app && _tier.tier_app !== APP_ID;
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
};

/**
 * Check if a feature is unlocked.
 * @param {string} feature - one of: set_50, set_100, set_150, exam_mode, adaptive, dashboard, sync, ebook, weak_weight
 * @returns {boolean}
 */
export function can(feature) {
  const gate = GATES[feature];
  return gate ? gate() : true;
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
