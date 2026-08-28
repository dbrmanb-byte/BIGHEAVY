// supabase/functions/notify/index.ts
// Forwards Supabase database-webhook events to the notification channel —
// a Slack incoming webhook, or any inbound URL an agent listens on.
//
// Purchases already notify from the stripe-webhook function; this covers the
// event that never touches Stripe: a new signup. Wire it in the dashboard —
// Database → Webhooks → Create:
//   table  public.profiles, event INSERT
//   URL    https://<project-ref>.supabase.co/functions/v1/notify
//   header x-notify-token: <the NOTIFY_TOKEN secret>
//
// Deploy: supabase functions deploy notify --use-api --no-verify-jwt
// (Database webhooks present no user JWT; the shared token is the gate.
//  Without it this would be a public URL anyone could use to spam the channel.)
//
// Secrets: SLACK_WEBHOOK_URL   where notices go
//          NOTIFY_TOKEN        any long random string, same value in the header

const NOTIFY_URL = Deno.env.get("SLACK_WEBHOOK_URL") ?? "";
const TOKEN = Deno.env.get("NOTIFY_TOKEN") ?? "";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (!TOKEN || req.headers.get("x-notify-token") !== TOKEN) {
    return new Response("nope", { status: 401 });
  }
  if (!NOTIFY_URL) return new Response("no channel configured", { status: 200 });

  let text = "Something happened in the database.";
  try {
    const p = await req.json();
    // The database webhook payload: { type: "INSERT", table, schema, record, ... }
    if (p?.table === "profiles" && p?.type === "INSERT") {
      const name = p.record?.display_name;
      text = `New signup${name ? `: ${name}` : ""} — profile ${p.record?.id ?? "?"}`;
    } else {
      text = `${p?.type ?? "event"} on ${p?.schema ?? "?"}.${p?.table ?? "?"}`;
    }
  } catch { /* unreadable body still notifies generically */ }

  try {
    await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("forward failed:", err);
    // 200 regardless: the webhook must not retry-spam over a channel outage.
  }
  return new Response("ok", { status: 200 });
});
