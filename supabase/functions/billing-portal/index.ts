// supabase/functions/billing-portal/index.ts
// Opens Stripe's customer portal for a signed-in user: cancel a subscription,
// update the card, download receipts. The "Manage subscription" buttons on the
// site and in every app land here.
//
// Like checkout, this needs the Stripe secret key, so it is server-only. The
// browser sends its session token and an optional return path; it gets back a
// one-time portal URL. The customer is always the one linked to the caller's
// own profile — a request can never name a different customer.
//
// The portal's settings (what customers may do there) are created here through
// the API the first time it runs, tagged bh_portal=v1, and reused after that.
// No Stripe dashboard step is needed. Bump PORTAL_VERSION to roll out changed
// settings; the old configuration is simply left unused.
//
// Deploy: supabase functions deploy billing-portal --use-api
// (JWT verification stays ON: only a signed-in user has a customer to manage.)
//
// Secrets: STRIPE_SECRET_KEY, CHECKOUT_ALLOWED_ORIGIN (shared with checkout),
//          SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (injected)

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@14";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-12-18.acacia",
});

const ALLOWED_ORIGIN = Deno.env.get("CHECKOUT_ALLOWED_ORIGIN") ?? "*";
const PORTAL_VERSION = "v1";

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN === "*" ? (origin ?? "*") : ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

// Held between invocations so the configuration is looked up once per instance.
let portalConfigId: string | null = null;

/** Find the portal configuration this site made, or make it. */
async function portalConfig(site: string): Promise<string> {
  if (portalConfigId) return portalConfigId;

  for await (const c of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (c.metadata?.bh_portal === PORTAL_VERSION) return (portalConfigId = c.id);
  }

  const created = await stripe.billingPortal.configurations.create({
    business_profile: {
      headline: "BIGHEAVYINK — manage your plan",
      privacy_policy_url: `${site}/privacy.html`,
      terms_of_service_url: `${site}/terms.html`,
    },
    default_return_url: `${site}/library.html`,
    features: {
      // Cancelling stops the next charge; access runs to the end of the period
      // already paid for, exactly as the terms page promises.
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
        cancellation_reason: {
          enabled: true,
          options: ["too_expensive", "unused", "missing_features", "switched_service", "other"],
        },
      },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      // Switching plans stays off: Pro is scoped to one app, and a plan swap in
      // the portal cannot ask which app. Switching goes through the contact form.
      subscription_update: { enabled: false },
      // The account email is what links Stripe to the profile; changing it here
      // would quietly break that link.
      customer_update: { enabled: false },
    },
    metadata: { bh_portal: PORTAL_VERSION },
  });
  console.log("billing-portal: created configuration", created.id);
  return (portalConfigId = created.id);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  const url = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const { data: userData, error: userErr } = await asUser.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) {
    return new Response(JSON.stringify({ error: "Sign in to manage your subscription." }), { status: 401, headers });
  }

  let body: { returnPath?: string } = {};
  try { body = await req.json(); } catch { /* an empty body is fine */ }

  const site = ALLOWED_ORIGIN !== "*" ? ALLOWED_ORIGIN : origin;
  if (!site || !/^https?:\/\//.test(site)) {
    return new Response(JSON.stringify({ error: "No return origin." }), { status: 400, headers });
  }
  // Only a path on this site — never a full URL, so the portal cannot be used
  // to bounce someone to another domain.
  const path = typeof body.returnPath === "string" && /^\/[A-Za-z0-9/_.#-]{0,120}$/.test(body.returnPath)
    ? body.returnPath : "/library.html";

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: profile } = await admin
    .from("profiles").select("stripe_customer_id").eq("id", user.id).maybeSingle();
  const customerId = profile?.stripe_customer_id ?? null;
  if (!customerId) {
    return new Response(JSON.stringify({
      error: "There is no subscription on this account. If you paid, sign in with the email you used at checkout.",
    }), { status: 404, headers });
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: await portalConfig(site),
      return_url: `${site}${path}`,
    });
    return new Response(JSON.stringify({ url: session.url }), { status: 200, headers });
  } catch (err) {
    console.error("billing-portal error:", err);
    return new Response(JSON.stringify({ error: "Could not open subscription settings. Try again, or use the contact form." }),
      { status: 500, headers });
  }
});
