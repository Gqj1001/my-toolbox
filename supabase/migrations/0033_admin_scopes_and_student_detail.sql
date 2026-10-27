-- 0033：学生详情 + Owner 权限管理页 RPC
-- 只读详情按 scope 校验；管理操作只 Owner。

create or replace function public.admin_get_student_detail(p_student_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.has_archive_scope() then
    raise exception 'permission denied: archive scope required' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'student', jsonb_build_object(
      'id', s.id,
      'name', s.name,
      'subject', s.subject,
      'grade', s.grade,
      'school', s.campus,
      'manager', s.manager,
      'class_name', s.class_name,
      'attitude', s.attitude,
      'extra', coalesce(s.extra, '{}'::jsonb),
      'region_id', s.region_id,
      'campus_id', s.campus_id,
      'teacher_name', p.teacher_name,
      'teacher_campus', p.campus,
      'owner_email', u.email,
      'updated_at', s.updated_at
    ),
    'history', coalesce((
      select jsonb_agg(x.row order by x.created_at desc)
      from (
        select
          jsonb_build_object(
            'id', h.id,
            'student_name', h.student_name,
            'text', h.text,
            'date', h.date,
            'type_name', h.type_name,
            'subject', h.subject,
            'created_at', h.created_at,
            'tool', coalesce(h.tool, 'feedback'),
            'title', h.title,
            'score', h.score,
            'full_score', h.full_score
          ) as row,
          h.created_at
        from public.feedback_history h
        where h.user_id = s.user_id
          and h.student_name = s.name
      ) x
    ), '[]'::jsonb)
  ) into v_result
  from public.feedback_students s
  join auth.users u on u.id = s.user_id
  left join public.user_profiles p on p.user_id = s.user_id
  where s.id = p_student_id
    and (
      public.is_owner()
      or public.is_region_admin(s.region_id)
      or public.is_campus_admin(s.campus_id)
    );

  if v_result is null then
    raise exception 'student not found or no permission' using errcode = '42501';
  end if;

  return v_result;
end;
$$;

create or replace function public.admin_list_managers()
returns table (
  user_id uuid,
  email text,
  teacher_name text,
  role text,
  admin_scope text,
  scope_id uuid,
  scope_name text,
  campus_id uuid,
  campus_name text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_owner() then
    raise exception 'permission denied: owner only' using errcode = '42501';
  end if;

  return query
    select
      ur.user_id,
      u.email::text,
      coalesce(p.teacher_name, ''),
      ur.role::text,
      ur.admin_scope::text,
      ur.scope_id,
      coalesce(r.name, c.name, ''),
      ur.campus_id,
      coalesce(c2.name, ''),
      ur.updated_at
    from public.user_roles ur
    join auth.users u on u.id = ur.user_id
    left join public.user_profiles p on p.user_id = ur.user_id
    left join public.regions r on r.id = ur.scope_id and ur.admin_scope = 'region'
    left join public.campuses c on c.id = ur.scope_id and ur.admin_scope = 'campus'
    left join public.campuses c2 on c2.id = ur.campus_id
    where ur.role = 'admin' or ur.admin_scope is not null
    order by ur.role desc, ur.admin_scope, u.email;
end;
$$;

create or replace function public.admin_set_manager(
  p_email text,
  p_scope text,
  p_scope_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_scope text := lower(btrim(coalesce(p_scope, '')));
  v_scope_id uuid := p_scope_id;
  v_campus_id uuid := null;
  v_role text;
  v_admin_scope text;
begin
  if not public.is_owner() then
    raise exception 'permission denied: owner only' using errcode = '42501';
  end if;

  if v_scope not in ('owner', 'region', 'campus', 'none') then
    raise exception 'invalid scope: %', p_scope using errcode = '22023';
  end if;

  select id into v_user_id
  from auth.users
  where lower(email) = lower(btrim(p_email));

  if v_user_id is null then
    raise exception 'user not found: %', p_email using errcode = 'P0002';
  end if;

  if v_scope = 'owner' then
    v_role := 'admin';
    v_admin_scope := 'owner';
    v_scope_id := null;
    v_campus_id := null;
  elsif v_scope = 'region' then
    if v_scope_id is null or not exists (select 1 from public.regions where id = v_scope_id) then
      raise exception 'region not found' using errcode = 'P0002';
    end if;
    v_role := 'admin';
    v_admin_scope := 'region';
    v_campus_id := null;
  elsif v_scope = 'campus' then
    if v_scope_id is null or not exists (select 1 from public.campuses where id = v_scope_id) then
      raise exception 'campus not found' using errcode = 'P0002';
    end if;
    v_role := 'admin';
    v_admin_scope := 'campus';
    v_campus_id := v_scope_id;
  else
    v_role := 'user';
    v_admin_scope := null;
    v_scope_id := null;
    v_campus_id := null;
  end if;

  insert into public.user_roles (user_id, role, plan, status, admin_scope, scope_id, campus_id)
  values (
    v_user_id,
    v_role::public.user_role,
    'free',
    'active',
    v_admin_scope::public.admin_scope,
    v_scope_id,
    v_campus_id
  )
  on conflict (user_id) do update
    set role = excluded.role,
        admin_scope = excluded.admin_scope,
        scope_id = excluded.scope_id,
        campus_id = excluded.campus_id,
        updated_at = now();
end;
$$;

create or replace function public.admin_create_region(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if not public.is_owner() then
    raise exception 'permission denied: owner only' using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 40 then
    raise exception 'region name must be 2-40 chars' using errcode = '22023';
  end if;

  insert into public.regions (name)
  values (v_name)
  on conflict (name) do update set name = excluded.name
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.admin_create_campus(p_region_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if not public.is_owner() then
    raise exception 'permission denied: owner only' using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 40 then
    raise exception 'campus name must be 2-40 chars' using errcode = '22023';
  end if;
  if not exists (select 1 from public.regions where id = p_region_id) then
    raise exception 'region not found' using errcode = 'P0002';
  end if;

  insert into public.campuses (region_id, name)
  values (p_region_id, v_name)
  on conflict (region_id, name) do update set name = excluded.name
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.admin_get_student_detail(bigint) from public, anon;
revoke all on function public.admin_list_managers() from public, anon;
revoke all on function public.admin_set_manager(text, text, uuid) from public, anon;
revoke all on function public.admin_create_region(text) from public, anon;
revoke all on function public.admin_create_campus(uuid, text) from public, anon;

grant execute on function public.admin_get_student_detail(bigint) to authenticated;
grant execute on function public.admin_list_managers() to authenticated;
grant execute on function public.admin_set_manager(text, text, uuid) to authenticated;
grant execute on function public.admin_create_region(text) to authenticated;
grant execute on function public.admin_create_campus(uuid, text) to authenticated;
