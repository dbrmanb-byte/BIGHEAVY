-- Close three ways a signed-in reader could give themselves a paid plan.
--
-- 1. "Users update own profile" allowed an UPDATE of every column, and the
--    profile row is where the tier lives. Anyone signed in could run, from the
--    browser console with the public key:
--      profiles.update({ tier: 'all_access', tier_valid_until: null })
--    and the content function would serve them every paid bank. Readers may
--    now change their display name and nothing else; the tier, Stripe ids and
--    validity date are written only by the webhook through the service role.
--
-- 2. set_tier and link_stripe_customer are SECURITY DEFINER and Postgres grants
--    EXECUTE on new functions to PUBLIC by default, so both were callable by
--    anyone holding the public key. Together they grant any tier to any
--    account. link_stripe_customer also answered "is this email registered?"
--    with the account's id, and could overwrite another reader's Stripe link
--    given only their email. Both are now service-role only, like grant_ebook.
--
-- 3. ebook_count_for_customer was open the same way (a smaller leak: how many
--    books a given Stripe customer bought). Also service-role only now.
--
-- The webhook, checkout, billing-portal and content functions all use the
-- service role, so none of them change behaviour.

-- ---- 1. profile writes: display name only --------------------------------
revoke update on public.profiles from anon, authenticated;
grant update (display_name, updated_at) on public.profiles to authenticated;

-- ---- 2 and 3. server-only functions ---------------------------------------
revoke all on function public.set_tier(text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.link_stripe_customer(text, text)               from public, anon, authenticated;
revoke all on function public.ebook_count_for_customer(text)                from public, anon, authenticated;
grant execute on function public.set_tier(text, text, text, text, timestamptz) to service_role;
grant execute on function public.link_stripe_customer(text, text)               to service_role;
grant execute on function public.ebook_count_for_customer(text)                to service_role;
grant execute on function public.grant_ebook(text, text, text, integer)         to service_role;

-- ---- hardening: pin search_path on the definer functions that lacked it ----
-- A SECURITY DEFINER function that resolves names through the caller's
-- search_path can be pointed at look-alike objects. Pinning it removes that.
alter function public.handle_new_user()                                     set search_path = public;
alter function public.my_tier()                                             set search_path = public;
alter function public.set_tier(text, text, text, text, timestamptz)         set search_path = public;
alter function public.link_stripe_customer(text, text)                      set search_path = public;
alter function public.my_category_stats()                                   set search_path = public;
alter function public.my_daily_trend()                                      set search_path = public;
alter function public.item_difficulty()                                    set search_path = public;
alter function public.my_sessions(int)                                      set search_path = public;
alter function public.my_weakest_items(int)                                 set search_path = public;
alter function public.my_streak()                                           set search_path = public;
