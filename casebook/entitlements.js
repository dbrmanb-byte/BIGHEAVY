/* Entitlements — the single source of truth for what a visitor may use.
   Written to be lifted into packages/entitlements in the monorepo unchanged:
   every vertical sets APP_ID, imports this, and asks can(). Nothing in here is
   app-specific except the default APP_ID at the bottom.

   Offline-first by design. The tier is cached locally, so a paid user on a plane
   keeps everything that was already unlocked. The cache is a convenience, not a
   security boundary — see the note on enforcement below.

   Enforcement note: this is a SOFT gate. All content ships inside the static
   bundle, so a determined user can read it from source. That is an accepted
   trade for keeping the apps offline-capable. If hard gating is ever needed,
   premium content moves behind the entitlement API and stops being bundled. */

(function (root) {
  "use strict";

  var KEY = "bh.ent";                      // shared across every vertical
  var TIERS = ["free", "pro", "unlimited"];

  /* What each tier grants. Free deliberately keeps the acquisition hooks —
     the glossary and the spaced-repetition drills — fully open. */
  var GRANTS = {
    free:      ["quiz.short"],
    pro:       ["quiz.short", "quiz.full", "exam.sim", "tutor", "stats.weak"],
    unlimited: ["quiz.short", "quiz.full", "exam.sim", "tutor", "stats.weak"]
  };

  var FREE_QUIZ_LIMIT = 10;                // the one free set length

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || TIERS.indexOf(v.tier) < 0) return null;
      if (!Array.isArray(v.apps)) v.apps = [];
      return v;
    } catch (e) { return null; }
  }

  function write(v) {
    try { localStorage.setItem(KEY, JSON.stringify(v)); }
    catch (e) { root.__bhEnt = v; }        // private mode / storage disabled
  }

  var Ent = {
    /* Each vertical declares itself before loading this file:
         <script>window.__BH_APP_ID = "casebook";</script>
       Pro covers one app, so this id is what a Pro record is matched against. */
    APP_ID: root.__BH_APP_ID || "app",
    FREE_QUIZ_LIMIT: FREE_QUIZ_LIMIT,

    /* The stored record, or a free default. */
    state: function () {
      return read() || root.__bhEnt || { tier: "free", apps: [], updated: 0 };
    },

    tier: function () { return this.state().tier; },

    /* Pro covers ONE app, so the app id has to be in the record.
       Unlimited covers every app. */
    coversThisApp: function () {
      var s = this.state();
      if (s.tier === "unlimited") return true;
      if (s.tier === "pro") return s.apps.indexOf(this.APP_ID) >= 0;
      return false;
    },

    can: function (feature) {
      var s = this.state();
      var granted = GRANTS[s.tier] || GRANTS.free;
      if (granted.indexOf(feature) < 0) return false;
      // Everything beyond the free set also requires this app to be covered.
      if (GRANTS.free.indexOf(feature) >= 0) return true;
      return this.coversThisApp();
    },

    isPaid: function () { return this.tier() !== "free" && this.coversThisApp(); },

    /* Set by the billing webhook check once a backend exists. Exposed now so the
       gating can be exercised end to end before that lands. */
    set: function (tier, apps) {
      if (TIERS.indexOf(tier) < 0) return false;
      write({ tier: tier, apps: apps || [], updated: Date.now() });
      return true;
    },

    clear: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      root.__bhEnt = null;
    }
  };

  /* Testing hook: ?tier=pro / ?tier=unlimited / ?tier=free
     Lets the gating be verified without a billing backend. Harmless to ship —
     it only ever writes to this browser, and the gate is soft anyway. */
  try {
    var q = new URLSearchParams(root.location.search).get("tier");
    if (q) {
      if (q === "free") Ent.clear();
      else Ent.set(q, [root.__BH_APP_ID || "casebook"]);
    }
  } catch (e) {}

  root.Entitlements = Ent;
})(window);
