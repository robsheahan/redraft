-- File attachments for tasks and submissions.
--
-- Teachers can attach accompanying materials (photos / PDFs) to a task; students
-- can attach a photo / PDF to their submission. Nothing is done with the files —
-- they are stored and displayed/downloadable only. Files live in a PRIVATE
-- Storage bucket ('attachments'); the api/attachment.ts endpoint mints
-- signed upload URLs (writes) and short-lived signed download URLs (reads) after
-- authorising the caller. The jsonb columns below hold the metadata that is the
-- source of truth for what is attached:
--   [{ path, name, content_type, size }]
--
-- Safe to run multiple times.

-- Private bucket. The service role (used by api/attachment.ts) bypasses RLS, and
-- signed-upload tokens authorise individual writes, so no Storage RLS policies
-- are needed — keeping the bucket private is sufficient.
insert into storage.buckets (id, name, public)
  values ('attachments', 'attachments', false)
  on conflict (id) do nothing;

alter table public.tasks
  add column if not exists teacher_attachments jsonb not null default '[]'::jsonb;

alter table public.submissions
  add column if not exists student_attachments jsonb not null default '[]'::jsonb;
