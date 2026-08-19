-- Casebook/Forge schema migration: subscription tiers
-- Run after the base schema.sql

-- ============================================================
-- ADD TIER COLUMNS TO PROFILES
-- ============================================================

alter table public.profiles
  add column if not exists tier text not null default 'free'
    check (tier in ('free', 'pro', 'all_access')),
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists tier_valid_until timestamptz,
  add column if not exists tier_app text;  -- 'casebook', 'forge', or null (all_access)

create index if not exists idx_profiles_stripe
  on public.profiles(stripe_customer_id)
  where stripe_customer_id is not null;

-- ============================================================
-- FUNCTION: CHECK TIER (called from client)
-- ============================================================

create or replace function public.my_tier()
returns jsonb
language sql stable security definer as $$
  select jsonb_build_object(
    'tier', tier,
    'tier_app', tier_app,
    'tier_valid_until', tier_valid_until,
    'is_active', (
      tier = 'free'
      or tier_valid_until is null
      or tier_valid_until > now()
    )
  )
  from public.profiles
  where id = auth.uid();
$$;

-- ============================================================
-- FUNCTION: UPDATE TIER (called from webhook edge function)
-- Uses service_role key, not anon key
-- ============================================================

create or replace function public.set_tier(
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_tier text,
  p_tier_app text default null,
  p_valid_until timestamptz default null
)
returns void
language plpgsql security definer as $$
begin
  update public.profiles
  set
    tier = p_tier,
    stripe_customer_id = p_stripe_customer_id,
    stripe_subscription_id = p_stripe_subscription_id,
    tier_app = p_tier_app,
    tier_valid_until = p_valid_until,
    updated_at = now()
  where stripe_customer_id = p_stripe_customer_id;

  -- If no row matched by stripe_customer_id (first purchase),
  -- try matching by the email from the Stripe customer
  if not found then
    -- This case is handled in the edge function by looking up
    -- the user by email first and setting stripe_customer_id
    raise notice 'No profile found for stripe_customer_id %', p_stripe_customer_id;
  end if;
end;
$$;

-- ============================================================
-- FUNCTION: LINK STRIPE CUSTOMER TO PROFILE (by email)
-- Called from webhook on first checkout
-- ============================================================

create or replace function public.link_stripe_customer(
  p_email text,
  p_stripe_customer_id text
)
returns uuid
language plpgsql security definer as $$
declare
  v_user_id uuid;
begin
  -- Find the auth user by email
  select id into v_user_id
  from auth.users
  where email = p_email
  limit 1;

  if v_user_id is not null then
    update public.profiles
    set stripe_customer_id = p_stripe_customer_id,
        updated_at = now()
    where id = v_user_id;
  end if;

  return v_user_id;
end;
$$;
