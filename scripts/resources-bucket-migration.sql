-- Presentation resources bucket.
--
-- A PUBLIC Storage bucket holding admin-only presentation assets (currently the
-- narrative walkthrough video). It's public so the Resources links on the admin
-- page can point straight at a stable URL:
--   https://<ref>.supabase.co/storage/v1/object/public/resources/<file>
-- Re-uploading a file under the same name updates it on the site with no code
-- change. The links themselves are only rendered on the (admin-gated) admin page.
--
-- Safe to run multiple times.

insert into storage.buckets (id, name, public)
  values ('resources', 'resources', true)
  on conflict (id) do nothing;
