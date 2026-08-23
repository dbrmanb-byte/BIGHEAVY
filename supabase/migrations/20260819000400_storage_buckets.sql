-- The two private buckets holding everything people pay for.
--
-- These are created here rather than by the setup script because the Supabase
-- CLI has no bucket command — `supabase storage` only does ls/cp/mv/rm — and
-- because a bucket's privacy is not a thing to leave to a click. Splitting the
-- paid banks out of the app bundles is the entire content-protection story; a
-- public bucket undoes it silently and completely.
--
--   ebooks   <slug>.pdf            served watermarked, after an ownership check
--   content  <slug>/bank.json      served without answer keys, after a tier check
--
-- Both are reached only by the edge functions, which use the service role key
-- and so bypass row-level security. No policy on storage.objects is added on
-- purpose: with none, and public = false, anon and authenticated clients can
-- read nothing directly.

insert into storage.buckets (id, name, public)
values
  ('ebooks',  'ebooks',  false),
  ('content', 'content', false)
on conflict (id) do update
  -- Re-assert privacy on every push. If someone flips a bucket public in the
  -- dashboard, the next deploy puts it back rather than leaving the catalogue
  -- exposed until somebody happens to notice.
  set public = false;
