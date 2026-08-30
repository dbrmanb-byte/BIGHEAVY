# The Agent OS listener

A small always-on service for the Linux box (gx10-d0b7). Supabase POSTs it
every signup and sale as structured JSON (the `AGENT_WEBHOOK_URL` half of
LAUNCH.md §4b), and it acts on them:

- **Ebook purchase** → thank-you email naming the books, a button to the
  library, and the earned discount code — the code Stripe creates but never
  emails.
- **Subscription** → welcome email for Pro (naming the app) or Unlimited.
- **Signup** → logged only. Supabase already sends the branded confirmation
  email; a second email at signup would be noise.

It is the *optional* half of notifications by design: Slack notices and the
purchases themselves never depend on it. Machine off → the functions log
"agent notice failed" and everything else carries on.

## Setup on the box, in order

Each step works before the next exists, so you can stop and test anywhere.

**1. Node and the repo**

```bash
sudo apt install -y nodejs npm git     # Node 18+ required: node --version
git clone https://github.com/dbrmanb-byte/BIGHEAVY.git ~/BIGHEAVY
```

(The repo is public — cloning needs no login.)

**2. The env file** (never in the repo — it holds secrets)

```bash
cp ~/BIGHEAVY/agent/.env.example ~/.bigheavyink-agent.env
nano ~/.bigheavyink-agent.env      # fill in NOTIFY_TOKEN; leave RESEND_API_KEY empty for now
```

`NOTIFY_TOKEN` must be the exact string stored as the Supabase secret of the
same name.

**3. First run — dry-run mode**

```bash
cd ~/BIGHEAVY && set -a && . ~/.bigheavyink-agent.env && set +a && node agent/listener.mjs
```

In a second terminal, prove the door and the lock both work:

```bash
curl localhost:8787                                   # -> ok
curl -X POST localhost:8787 -H "x-notify-token: WRONG" -d '{}'   # -> nope
curl -X POST localhost:8787 \
  -H "x-notify-token: $NOTIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"event":"ebook_purchase","email":"you@example.com","ebooks":["forge-security"],"amount_cents":999,"discount_code":"TESTCODE"}'
```

The listener log should print the full thank-you email it *would* send.

**4. A public URL — Tailscale Funnel** (free; survives reboots; no router
port-forwarding)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                      # sign in with any account in the browser it opens
sudo tailscale funnel --bg 8787
tailscale funnel status                # shows the public https URL
```

The URL looks like `https://gx10-d0b7.<something>.ts.net` and stays stable.

**5. Point Supabase at it** — on the laptop:

```bash
npx --yes supabase secrets set AGENT_WEBHOOK_URL=https://<the-funnel-url>
```

From this moment every signup and sale reaches the box. Test with a
throwaway signup at bigheavyink.com and watch the listener log.

**6. Real email — Resend**

1. Create a free account at resend.com
2. Domains → Add `bigheavyink.com` → add the DNS records it shows in
   Netlify (Domains → bigheavyink.com → DNS records) → wait for Verified
3. API Keys → create one → put it in `~/.bigheavyink-agent.env` as
   `RESEND_API_KEY`
4. Restart the listener — the "DRY RUN" note disappears from its startup line

**7. Survive reboots — systemd**

```bash
sudo cp ~/BIGHEAVY/agent/bigheavyink-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bigheavyink-agent
journalctl -u bigheavyink-agent -f      # live logs
```

## Updating

```bash
cd ~/BIGHEAVY && git pull && sudo systemctl restart bigheavyink-agent
```

## Turning it off

Unset the secret and the functions stop posting (Slack notices continue):

```bash
npx --yes supabase secrets unset AGENT_WEBHOOK_URL
```
