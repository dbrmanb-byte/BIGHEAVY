// supabase/functions/checkout/index.ts
// Creates a Stripe Checkout Session for a signed-in user.
//
// This is the only place a purchase can start: creating a session needs the
// Stripe secret key, which never reaches a browser. The client sends a price
// lookup_key — pro_<slug>, all_access, or ebook_<slug>, the keys
// scripts/setup-stripe.mjs creates — and gets back a URL to redirect to.
// Everything after that is Stripe's checkout page and then the webhook.
//
// The webhook links the Stripe customer to a profile by email, so the session
// is created with the authenticated user's email (or their already-linked
// customer id). The email shown in checkout is therefore the one that gets the
// entitlement — which is exactly what the buyer expects.
//
// Deploy: supabase functions deploy checkout --use-api
// (JWT verification stays ON: an anonymous visitor has no email to entitle.)

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@14";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-12-18.acacia",
});

const ALLOWED_ORIGIN = Deno.env.get("CHECKOUT_ALLOWED_ORIGIN") ?? "*";

// The only keys this function will sell. Anything else in the Stripe account —
// test scraps, future experiments — is not purchasable from the site.
const KEY_SHAPE = /^(pro_[a-z0-9_]{1,40}|all_access|ebook_[a-z0-9_]{1,40})$/;

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN === "*" ? (origin ?? "*") : ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  // Who is buying. The platform has already verified the JWT; this resolves it
  // to a user so the session carries the email the entitlement will land on.
  const url = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  const user = userData?.user;
  if (userErr || !user?.email) {
    return new Response(JSON.stringify({ error: "Sign in before buying — the purchase has to land on an account." }),
      { status: 401, headers });
  }

  let body: { price?: string };
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Body must be JSON." }), { status: 400, headers });
  }
  const key = String(body.price ?? "");
  if (!KEY_SHAPE.test(key)) {
    return new Response(JSON.stringify({ error: "Unknown price." }), { status: 400, headers });
  }

  // Redirects go back to where the buyer came from. With a locked-down origin
  // that value wins; "*" (pre-domain testing) trusts the request's Origin.
  const site = ALLOWED_ORIGIN !== "*" ? ALLOWED_ORIGIN : origin;
  if (!site || !/^https?:\/\//.test(site)) {
    return new Response(JSON.stringify({ error: "No return origin." }), { status: 400, headers });
  }

  try {
    const found = await stripe.prices.list({ lookup_keys: [key], active: true, limit: 1 });
    const price = found.data[0];
    if (!price) {
      console.error("checkout: no active price for lookup_key", key);
      return new Response(JSON.stringify({ error: "That price is not available." }), { status: 404, headers });
    }
    const mode = price.recurring ? "subscription" : "payment";

    // Reuse the profile's Stripe customer if one is already linked, so repeat
    // purchases and upgrades stack on one customer record.
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: profile } = await admin
      .from("profiles").select("stripe_customer_id").eq("id", user.id).maybeSingle();
    const customerId = profile?.stripe_customer_id ?? null;

    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: price.id, quantity: 1 }],
      ...(customerId ? { customer: customerId } : { customer_email: user.email }),
      // One-time payments do not create a Stripe Customer unless told to, and
      // the webhook attributes a purchase through session.customer — so a
      // first-time book buyer would pay and be impossible to grant anything.
      // (Unseen in test mode only because the test account bought a
      // subscription first, which always creates a customer.) Subscription
      // mode rejects this parameter, hence the guard.
      ...(mode === "payment" && !customerId ? { customer_creation: "always" as const } : {}),
      // The ebook discount codes buyers receive are typed here.
      allow_promotion_codes: true,
      success_url: `${site}/thanks.html?bought=${encodeURIComponent(key)}`,
      cancel_url: `${site}/pricing.html`,
      metadata: { supabase_user_id: user.id },
      // Stripe's merchant-of-record program (Managed Payments) is switched on
      // by default on some accounts and rejects any product without a tax
      // code — with no dashboard off switch. This store is its own merchant,
      // so every session opts out explicitly. Harmless on accounts without
      // the program.
      managed_payments: { enabled: false },
    } as unknown as Stripe.Checkout.SessionCreateParams);

    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers });
  } catch (err) {
    console.error("checkout error:", err);
    return new Response(JSON.stringify({ error: "Could not start checkout. Nothing was charged." }),
      { status: 500, headers });
  }
});
