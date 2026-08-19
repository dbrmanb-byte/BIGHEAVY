-- Casebook database schema
-- Run against a Supabase project: supabase db push
-- or paste into the SQL Editor in the Supabase dashboard.

-- ============================================================
-- TABLES
-- ============================================================

-- Extends auth.users with app-specific fields.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per answer. This is the core data asset.
create table public.responses (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  item_id     text not null,          -- matches the q### id in the client DATA
  category    text not null,          -- HBSE, Assessment, Intervention, Ethics, etc.
  correct     boolean not null,
  answer_idx  smallint not null,      -- 0-3, what the user picked
  time_ms     int,                    -- ms spent on this item (null if not tracked)
  session_id  bigint,                 -- FK set after session completes
  created_at  timestamptz not null default now()
);

create index idx_responses_user    on public.responses(user_id, created_at desc);
create index idx_responses_item    on public.responses(item_id);
create index idx_responses_session on public.responses(session_id) where session_id is not null;

-- One row per completed quiz set.
create table public.study_sessions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  length      int not null,           -- how many items in the set
  correct     int not null,
  total       int not null,           -- answered (may be < length if ended early)
  config      jsonb not null default '{}',  -- {hold, timed, weak}
  started_at  timestamptz not null,
  finished_at timestamptz not null default now()
);

create index idx_sessions_user on public.study_sessions(user_id, finished_at desc);

-- ============================================================
-- AUTO-CREATE PROFILE ON SIGNUP
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table public.profiles       enable row level security;
alter table public.responses      enable row level security;
alter table public.study_sessions enable row level security;

-- Profiles: users see and edit only their own.
create policy "Users read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Responses: users insert and read only their own.
create policy "Users insert own responses"
  on public.responses for insert
  with check (auth.uid() = user_id);

create policy "Users read own responses"
  on public.responses for select
  using (auth.uid() = user_id);

-- Sessions: users insert and read only their own.
create policy "Users insert own sessions"
  on public.study_sessions for insert
  with check (auth.uid() = user_id);

create policy "Users read own sessions"
  on public.study_sessions for select
  using (auth.uid() = user_id);

-- ============================================================
-- AGGREGATE VIEWS (for the dashboard)
-- ============================================================

-- Per-category accuracy for the current user.
-- Called from the client: supabase.rpc('my_category_stats')
create or replace function public.my_category_stats()
returns table (
  category    text,
  total       bigint,
  correct     bigint,
  accuracy    numeric,
  last_seen   timestamptz
)
language sql stable security definer as $$
  select
    category,
    count(*)                                    as total,
    count(*) filter (where correct)             as correct,
    round(count(*) filter (where correct)::numeric / greatest(count(*), 1), 3) as accuracy,
    max(created_at)                             as last_seen
  from public.responses
  where user_id = auth.uid()
  group by category
  order by accuracy asc;
$$;

-- Overall accuracy trend by day (last 30 days).
create or replace function public.my_daily_trend()
returns table (
  day       date,
  total     bigint,
  correct   bigint,
  accuracy  numeric
)
language sql stable security definer as $$
  select
    created_at::date                            as day,
    count(*)                                    as total,
    count(*) filter (where correct)             as correct,
    round(count(*) filter (where correct)::numeric / greatest(count(*), 1), 3) as accuracy
  from public.responses
  where user_id = auth.uid()
    and created_at > now() - interval '30 days'
  group by created_at::date
  order by day;
$$;

-- Item difficulty: what % of ALL users get each item right.
-- This powers the adaptive engine's item weighting.
-- No RLS needed: it aggregates across users, no PII exposed.
create or replace function public.item_difficulty()
returns table (
  item_id    text,
  attempts   bigint,
  difficulty numeric   -- 0.0 = everyone gets it right, 1.0 = everyone misses
)
language sql stable security definer as $$
  select
    item_id,
    count(*)                                                   as attempts,
    round(1.0 - count(*) filter (where correct)::numeric / greatest(count(*), 1), 3) as difficulty
  from public.responses
  group by item_id
  having count(*) >= 3   -- need a minimum sample
  order by difficulty desc;
$$;

-- Session history for the current user.
create or replace function public.my_sessions(lim int default 20)
returns table (
  id          bigint,
  length      int,
  correct     int,
  total       int,
  config      jsonb,
  started_at  timestamptz,
  finished_at timestamptz
)
language sql stable security definer as $$
  select id, length, correct, total, config, started_at, finished_at
  from public.study_sessions
  where user_id = auth.uid()
  order by finished_at desc
  limit lim;
$$;

-- Most-missed items for the current user (for recommendations).
create or replace function public.my_weakest_items(lim int default 30)
returns table (
  item_id   text,
  category  text,
  attempts  bigint,
  misses    bigint,
  miss_rate numeric
)
language sql stable security definer as $$
  select
    item_id,
    category,
    count(*)                                          as attempts,
    count(*) filter (where not correct)               as misses,
    round(count(*) filter (where not correct)::numeric / greatest(count(*), 1), 3) as miss_rate
  from public.responses
  where user_id = auth.uid()
  group by item_id, category
  having count(*) filter (where not correct) > 0
  order by miss_rate desc, misses desc
  limit lim;
$$;

-- Streak: consecutive days with at least one response.
create or replace function public.my_streak()
returns int
language sql stable security definer as $$
  with days as (
    select distinct created_at::date as d
    from public.responses
    where user_id = auth.uid()
  ),
  numbered as (
    select d, d - (row_number() over (order by d))::int as grp
    from days
  ),
  streaks as (
    select grp, count(*) as len, max(d) as last_day
    from numbered
    group by grp
  )
  select coalesce(
    (select len from streaks where last_day >= current_date - 1 order by last_day desc limit 1),
    0
  );
$$;
