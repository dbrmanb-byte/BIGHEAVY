// supabase/functions/notify/index.ts
// Forwards Supabase database-webhook events to the notification channels —
// a Slack incoming webhook for humans, and optionally an agent inbox that
// gets the structured event (so it can send the welcome email).
//
// Purchases already notify from the stripe-webhook function; this covers the
// event that never touches Stripe: a new signup. Wire it in the dashboard —
// Database → Webhooks (or the pg_net trigger in LAUNCH.md §4b) — Create:
//   table  public.profiles, event INSERT
//   URL    https://<project-ref>.supabase.co/functions/v1/notify
//   header x-notify-token: <the NOTIFY_TOKEN secret>
//
// Deploy: supabase functions deploy notify --use-api --no-verify-jwt
// (Database webhooks present no user JWT; the shared token is the gate.
//  Without it this would be a public URL anyone could use to spam the channel.)
//
// Secrets: SLACK_WEBHOOK_URL   where human-readable notices go
//          AGENT_WEBHOOK_URL   optional: where structured JSON goes
//          NOTIFY_TOKEN        any long random string, same value in the header

import { createClient } from "npm:@supabase/supabase-js@2";

const NOTIFY_URL = Deno.env.get("SLACK_WEBHOOK_URL") ?? "";
const AGENT_URL = Deno.env.get("AGENT_WEBHOOK_URL") ?? "";
const TOKEN = Deno.env.get("NOTIFY_TOKEN") ?? "";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (!TOKEN || req.headers.get("x-notify-token") !== TOKEN) {
    return new Response("nope", { status: 401 });
  }
  if (!NOTIFY_URL && !AGENT_URL) return new Response("no channel configured", { status: 200 });

  let text = "Something happened in the database.";
  let agent: Record<string, unknown> | null = null;
  try {
    const p = await req.json();
    // The database webhook payload: { type: "INSERT", table, schema, record, ... }
    if (p?.table === "profiles" && p?.type === "INSERT") {
      const name = p.record?.display_name;
      // The profile row has no email; the auth record does. The service role
      // is injected into every function, so look it up — the welcome an agent
      // sends needs an address, not just a display name.
      let email: string | null = null;
      try {
        const admin = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        );
        const { data } = await admin.auth.admin.getUserById(p.record?.id);
        email = data?.user?.email ?? null;
      } catch { /* the notice still goes out without it */ }
      text = `New signup${name ? `: ${name}` : ""}${email ? ` (${email})` : ""} — profile ${p.record?.id ?? "?"}`;
      agent = {
        event: "signup",
        profile_id: p.record?.id ?? null,
        display_name: name ?? null,
        email,
      };
    } else {
      text = `${p?.type ?? "event"} on ${p?.schema ?? "?"}.${p?.table ?? "?"}`;
      agent = { event: "db", type: p?.type ?? null, table: p?.table ?? null };
    }
  } catch { /* unreadable body still notifies generically */ }

  // Each channel fails on its own; neither failure reaches the caller —
  // 200 regardless, because the webhook must not retry-spam over an outage.
  if (NOTIFY_URL) {
    try {
      await fetch(NOTIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.error("slack forward failed:", err);
    }
  }
  if (AGENT_URL && agent) {
    try {
      await fetch(AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notify-token": TOKEN },
        body: JSON.stringify(agent),
      });
    } catch (err) {
      console.error("agent forward failed:", err);
    }
  }
  return new Response("ok", { status: 200 });
});
