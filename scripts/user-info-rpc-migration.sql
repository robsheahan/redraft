-- Batched auth-user lookups via SQL, replacing the listUsers-everything pattern.
--
-- Before this migration, getUserInfoBatch (lib/user-names.ts) and
-- getSchoolUserRoles (lib/schools.ts) paged through the ENTIRE auth.users
-- table via supabase.auth.admin.listUsers on nearly every hot request
-- (task-detail, marking, markbook, results, class pages, all insights).
-- That cost grows with total platform signups — every new user made every
-- page slower for everyone. These two SECURITY DEFINER functions replace it
-- with indexed queries for exactly the ids (or domains) a request needs.
--
-- The TypeScript callers fall back to the old listUsers path if these
-- functions don't exist yet, so this migration can be applied before or
-- after the code deploy — but the speedup only lands once it has run.
--
-- Run in the Supabase SQL editor.

-- 1) Info for a specific set of user ids (names + role + graduation year).
create or replace function public.get_user_info(ids uuid[])
returns table (
  id uuid,
  email text,
  display_name text,
  role text,
  graduation_year text
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    u.id,
    u.email::text,
    coalesce(
      u.raw_user_meta_data->>'display_name',
      u.raw_user_meta_data->>'full_name',
      u.raw_user_meta_data->>'name'
    ),
    coalesce(u.raw_app_meta_data->>'role', u.raw_user_meta_data->>'role'),
    u.raw_user_meta_data->>'graduation_year'
  from auth.users u
  where u.id = any(ids);
$$;

revoke all on function public.get_user_info(uuid[]) from public;
revoke all on function public.get_user_info(uuid[]) from anon;
revoke all on function public.get_user_info(uuid[]) from authenticated;
grant execute on function public.get_user_info(uuid[]) to service_role;

-- 2) Users whose email domain matches a school's domains (for the
--    email-domain school-membership path). Pass lowercased domains.
create or replace function public.get_users_by_email_domain(domains text[])
returns table (
  id uuid,
  email text,
  role text
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    u.id,
    u.email::text,
    coalesce(u.raw_app_meta_data->>'role', u.raw_user_meta_data->>'role')
  from auth.users u
  where lower(split_part(u.email::text, '@', 2)) = any(domains);
$$;

revoke all on function public.get_users_by_email_domain(text[]) from public;
revoke all on function public.get_users_by_email_domain(text[]) from anon;
revoke all on function public.get_users_by_email_domain(text[]) from authenticated;
grant execute on function public.get_users_by_email_domain(text[]) to service_role;

-- Optional (only worth it at many thousands of users, and requires the SQL
-- editor role to have index rights on auth.users — skip if it errors):
-- create index if not exists users_email_domain_idx
--   on auth.users (lower(split_part(email::text, '@', 2)));
