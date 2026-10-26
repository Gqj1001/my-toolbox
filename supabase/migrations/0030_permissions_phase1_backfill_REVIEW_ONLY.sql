begin;

update public.user_profiles p
set campus_id = c.id,
    region_id = c.region_id,
    updated_at = now()
from public.campuses c
where p.campus_id is null
  and btrim(coalesce(p.campus, '')) = c.name;

with campus_map(old_text, region_name, campus_name) as (
  values
    ('燕郊', '廊坊大区（三河区域）', '燕郊中学校区'),
    ('燕郊校区', '廊坊大区（三河区域）', '燕郊中学校区'),
    ('燕灵路', '廊坊大区（三河区域）', '燕灵路校区'),
    ('八中', '廊坊大区（三河区域）', '八中校区'),
    ('首尔甜城', '廊坊大区（三河区域）', '首尔甜城校区')
)
update public.user_profiles p
set campus_id = c.id,
    region_id = c.region_id,
    updated_at = now()
from campus_map m
join public.campuses c
  on c.name = m.campus_name
join public.regions r
  on r.id = c.region_id
 and r.name = m.region_name
where p.campus_id is null
  and btrim(coalesce(p.campus, '')) = m.old_text;

update public.feedback_students s
set campus_id = coalesce(
      (select c.id
         from public.campuses c
        where c.name = btrim(coalesce(s.extra ->> 'institutionCampus', ''))
        limit 1),
      p.campus_id
    ),
    region_id = coalesce(
      (select c.region_id
         from public.campuses c
        where c.name = btrim(coalesce(s.extra ->> 'institutionCampus', ''))
        limit 1),
      p.region_id
    )
from public.user_profiles p
where p.user_id = s.user_id
  and s.campus_id is null;

update public.feedback_students s
set created_at = coalesce(
  (select min(h.created_at)
     from public.feedback_history h
    where h.user_id = s.user_id
      and h.student_name = s.name),
  s.updated_at
)
where s.created_at is null;

do $$
declare
  v_owner_id uuid;
  v_owner_email constant text := '1502569564@qq.com';
  v_old_admins int;
begin
  select id into v_owner_id
  from auth.users
  where lower(email) = lower(v_owner_email);

  if v_owner_id is null then
    raise exception 'Owner account not found: %', v_owner_email;
  end if;

  select count(*) into v_old_admins
  from public.user_roles
  where role = 'admin' and user_id <> v_owner_id;

  insert into public.user_roles (user_id, role, plan, status, admin_scope, scope_id, campus_id)
  values (v_owner_id, 'admin', 'free', 'active', 'owner', null, null)
  on conflict (user_id) do update
    set role = 'admin',
        admin_scope = 'owner',
        scope_id = null,
        campus_id = null,
        updated_at = now();

  update public.user_roles
  set role = 'user',
      admin_scope = null,
      scope_id = null,
      campus_id = null,
      updated_at = now()
  where role = 'admin' and user_id <> v_owner_id;

  raise notice 'Owner set: %; other admins downgraded: %', v_owner_email, v_old_admins;
end $$;

select count(*) as owner_count
from public.user_roles
where role = 'admin' and admin_scope = 'owner';

select count(*) as other_admin_count
from public.user_roles
where role = 'admin' and (admin_scope is null or admin_scope <> 'owner');

select count(*) as pending_students
from public.feedback_students
where campus_id is null or region_id is null;

commit;
