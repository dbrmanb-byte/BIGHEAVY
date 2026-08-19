// supabase/functions/stripe-webhook/index.ts
// Handles Stripe webhook events for subscription management.
//
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt
//
// Environment variables (set in Supabase dashboard → Edge Functions → Secrets):
//   STRIPE_SECRET_KEY     - sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET - whsec_... from the Stripe webhook endpoint config
//   SUPABASE_SERVICE_ROLE_KEY - auto-injected by Supabase

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-12-18.acacia",
});

const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// How a Stripe price becomes an entitlement.
//
// Preferred: put metadata on the Price (or its Product) in Stripe —
//   tier = pro | all_access
//   app  = casebook | forge | <app slug>   (omit for all_access)
// Metadata travels with the price, so a new product needs no redeploy here.
//
// PRICE_TO_TIER below is an optional override for prices that predate the
// metadata convention. The ids in it must be real Stripe price ids
// (price_1ABC...); the placeholder names that shipped here never matched
// anything, so every subscription fell through to the fallback path.
const PRICE_TO_TIER: Record<string, { tier: string; app: string | null }> = {
  // "price_1ABCxyz...": { tier: "pro", app: "casebook" },
};

type Entitlement = { tier: string; app: string | null };

/** Resolve an entitlement from price metadata, then the override map.
    Subscription events arrive with price.product as a bare id, so the product
    is fetched when the price itself carries no tier metadata. */
async function resolveEntitlement(price: Stripe.Price | undefined): Promise<Entitlement | null> {
  if (!price) return null;

  const override = PRICE_TO_TIER[price.id];
  if (override) return override;

  let product: Stripe.Product | null =
    typeof price.product === "object" ? price.product as Stripe.Product : null;

  if (!product && !price.metadata?.tier && typeof price.product === "string") {
    try {
      product = await stripe.products.retrieve(price.product);
    } catch (err) {
      console.error("Could not load product for price", price.id, err);
    }
  }

  const meta = { ...(product?.metadata ?? {}), ...(price.metadata ?? {}) };

  const tier = meta.tier;
  if (tier === "all_access") return { tier, app: null };
  if (tier === "pro") {
    // Pro must name what it covers. Pro with no scope would either lock the
    // customer out or unlock the whole catalogue, depending on the client —
    // neither is acceptable, so treat it as unconfigured.
    return meta.app ? { tier, app: meta.app } : null;
  }
  return null;
}

serve(async (req: Request) => {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature")!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return new Response("Invalid signature", { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutComplete(supabase, session);
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionChange(supabase, subscription);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        console.log("Payment failed for customer:", invoice.customer);
        // Stripe handles dunning automatically.
        // The subscription.updated event will fire when status changes.
        break;
      }

      default:
        console.log("Unhandled event type:", event.type);
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
    return new Response("Internal error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

async function handleCheckoutComplete(
  supabase: any,
  session: Stripe.Checkout.Session
) {
  const customerId = session.customer as string;
  const customerEmail = session.customer_details?.email;
  const subscriptionId = session.subscription as string;

  if (!customerId || !subscriptionId) {
    console.log("No customer or subscription in session, skipping");
    return;
  }

  // Link Stripe customer to profile by email if not already linked
  if (customerEmail) {
    await supabase.rpc("link_stripe_customer", {
      p_email: customerEmail,
      p_stripe_customer_id: customerId,
    });
  }

  // Fetch subscription to get price and period
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price.product"],
  });
  await applySubscription(supabase, customerId, subscription);
}

async function handleSubscriptionChange(
  supabase: any,
  subscription: Stripe.Subscription
) {
  const customerId = subscription.customer as string;

  if (subscription.status === "canceled" || subscription.status === "unpaid") {
    // Downgrade to free
    await supabase.rpc("set_tier", {
      p_stripe_customer_id: customerId,
      p_stripe_subscription_id: subscription.id,
      p_tier: "free",
      p_tier_app: null,
      p_valid_until: new Date(subscription.current_period_end * 1000).toISOString(),
    });
    console.log("Downgraded to free:", customerId);
    return;
  }

  if (subscription.status === "active" || subscription.status === "trialing") {
    await applySubscription(supabase, customerId, subscription);
  }
}

async function applySubscription(
  supabase: any,
  customerId: string,
  subscription: Stripe.Subscription
) {
  const price = subscription.items.data[0]?.price;
  const mapping = await resolveEntitlement(price);

  if (!mapping) {
    // Do not guess. Granting "pro" with no scope used to happen here, which
    // either unlocks every app or none depending on the client — both are
    // wrong, and a silent over-grant is invisible while it costs revenue.
    // Leave the tier untouched and make the misconfiguration loud: the fix is
    // to add tier/app metadata to this price in Stripe and replay the event.
    console.error(
      "UNMAPPED PRICE — entitlement not granted.",
      "price:", price?.id,
      "customer:", customerId,
      "subscription:", subscription.id,
      "| Set metadata tier=pro|all_access (and app=<family|slug> for pro) on this price, then resend the event from the Stripe dashboard."
    );
    return;
  }

  await supabase.rpc("set_tier", {
    p_stripe_customer_id: customerId,
    p_stripe_subscription_id: subscription.id,
    p_tier: mapping.tier,
    p_tier_app: mapping.app,
    p_valid_until: new Date(subscription.current_period_end * 1000).toISOString(),
  });

  console.log("Tier set:", mapping.tier, "for customer:", customerId);
}
