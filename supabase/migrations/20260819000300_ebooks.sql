-- Ebook ownership.
-- Books are sold standalone ($9.99), so ownership is per title and completely
-- independent of subscription tier. Run after 002_tiers.sql.

-- ============================================================
-- PURCHASES
-- ============================================================

create table if not exists public.ebook_purchases (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  ebook_slug             text not null,              -- matches registry apps[].slug
  stripe_customer_id     text,
  stripe_session_id      text,                       -- the checkout that paid for it
  amount_cents           integer,
  currency               text default 'usd',
  created_at             timestamptz not null default now(),

  -- Buying the same book twice is a support problem, not two entitlements.
  unique (user_id, ebook_slug)
);

create index if not exists idx_ebook_purchases_user
  on public.ebook_purchases(user_id);

create index if not exists idx_ebook_purchases_customer
  on public.ebook_purchases(stripe_customer_id)
  where stripe_customer_id is not null;

-- Stripe can deliver the same event more than once; make replays harmless.
create unique index if not exists idx_ebook_purchases_session
  on public.ebook_purchases(stripe_session_id, ebook_slug)
  where stripe_session_id is not null;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.ebook_purchases enable row level security;

-- A reader may see their own purchases and nothing else. There is deliberately
-- no insert/update/delete policy: only the webhook (service_role, which bypasses
-- RLS) may grant a book, so no client can award itself one.
drop policy if exists "own purchases are readable" on public.ebook_purchases;
create policy "own purchases are readable"
  on public.ebook_purchases for select
  using (auth.uid() = user_id);

-- ============================================================
-- WHAT DO I OWN  (called from the client)
-- ============================================================

create or replace function public.my_ebooks()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(ebook_slug order by created_at), '[]'::jsonb)
  from public.ebook_purchases
  where user_id = auth.uid();
$$;

-- ============================================================
-- GRANT A BOOK  (called from the webhook with the service_role key)
-- ============================================================

create or replace function public.grant_ebook(
  p_stripe_customer_id text,
  p_ebook_slug         text,
  p_stripe_session_id  text default null,
  p_amount_cents       integer default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid;
  v_id      uuid;
begin
  select id into v_user_id
  from public.profiles
  where stripe_customer_id = p_stripe_customer_id
  limit 1;

  if v_user_id is null then
    -- The webhook links the customer by email before calling this, so landing
    -- here means an unlinked customer: raise rather than swallow it, otherwise
    -- someone pays and silently receives nothing.
    raise exception 'no profile for stripe_customer_id %', p_stripe_customer_id;
  end if;

  insert into public.ebook_purchases
    (user_id, ebook_slug, stripe_customer_id, stripe_session_id, amount_cents)
  values
    (v_user_id, p_ebook_slug, p_stripe_customer_id, p_stripe_session_id, p_amount_cents)
  on conflict (user_id, ebook_slug) do update
    set stripe_session_id = coalesce(public.ebook_purchases.stripe_session_id, excluded.stripe_session_id)
  returning id into v_id;

  return v_id;
end;
$$;

-- ============================================================
-- HOW MANY BOOKS  (drives the subscription discount)
-- ============================================================

create or replace function public.ebook_count_for_customer(p_stripe_customer_id text)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.ebook_purchases
  where stripe_customer_id = p_stripe_customer_id;
$$;

-- The client needs its own count to decide which offer to show.
create or replace function public.my_ebook_count()
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.ebook_purchases
  where user_id = auth.uid();
$$;

-- ============================================================
-- PERMISSIONS
-- ============================================================

revoke all on function public.grant_ebook(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.my_ebooks()      to authenticated;
grant execute on function public.my_ebook_count() to authenticated;
