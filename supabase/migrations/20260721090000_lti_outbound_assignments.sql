alter table public.lti_course_mappings
  add column if not exists lti_lineitems_url text;

update public.lti_course_mappings as course_map
set lti_lineitems_url = task.lti_ags_lineitems_url
from public.tasks as task
where task.class_id = course_map.class_id
  and task.lti_platform_id = course_map.platform_id
  and task.lti_ags_lineitems_url is not null
  and course_map.lti_lineitems_url is null;
