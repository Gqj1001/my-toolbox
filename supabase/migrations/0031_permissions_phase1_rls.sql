-- ============================================================
-- 0031 权限 Phase 1 · RLS + RPC scope（**代码批次，先审后跑**）
-- ----------------------------------------------------------------------------
-- 前提：0029 已执行（表/列已建），0030 **尚未执行**。
-- 本文件只做“读范围”：
--   · Owner（含 0030 前的 legacy admin）看全部；
--   · 大区管理者只看本大区；
--   · 校区管理者（二期）只看本校区；
--   · 普通教师仍只看自己创建的档案；
--   · 大区/校区管理者**只读**，不能改学生档案/老师资料/角色。
--
-- ⚠️ 0030 未执行时，`admin_scope is null` 的 admin 仍按 legacy Owner 处理，
--    这样现有 rolea 管理员和回归测试不会被锁死。0030 执行后，其他 admin 降级，
--    只有 admin_scope='owner' 的账号会命中 is_owner()。
--
-- 本文件会：
--   1. 新建 scope 判断函数 + 档案读取函数；
--   2. 重定义 is_admin()（只认 Owner/legacy，不再“所有 admin 都是超级管理员”）；
--   3. 重写 0026–0028 四个 RPC 的 scope 过滤；
--   4. 给 regions/campuses/user_profiles/feedback_students/feedback_history 加 RLS；
--   5. 加“学生建档快照”触发器（新学生自动带 region_id/campus_id/created_at）。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 范围判断函数
-- ------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid())
      and r.role = 'admin'
      and (r.admin_scope = 'owner' or r.admin_scope is null)
  );
$$;

create or replace function public.is_region_admin(p_region_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid())
      and r.role = 'admin'
      and r.admin_scope = 'region'
      and r.scope_id = p_region_id
  );
$$;

create or replace function public.is_campus_admin(p_campus_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid())
      and r.role = 'admin'
      and r.admin_scope = 'campus'
      and r.scope_id = p_campus_id
  );
$$;

/** 是否有后台档案总览的任一读范围（legacy admin / owner / region / campus） */
create or replace function public.has_archive_scope()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid())
      and r.role = 'admin'
      and (r.admin_scope is null or r.admin_scope in ('owner', 'region', 'campus'))
  );
$$;

/** 老师本人、Owner、本大区管理员、本校区管理员 → 可读该学生 */
create or replace function public.can_read_student(
  p_owner_id uuid,
  p_region_id uuid,
  p_campus_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_owner_id = (select auth.uid())
    or public.is_owner()
    or public.is_region_admin(p_region_id)
    or public.is_campus_admin(p_campus_id);
$$;

grant execute on function public.is_owner() to authenticated;
grant execute on function public.is_region_admin(uuid) to authenticated;
grant execute on function public.is_campus_admin(uuid) to authenticated;
grant execute on function public.has_archive_scope() to authenticated;
grant execute on function public.can_read_student(uuid, uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. is_admin() 收口：Owner/legacy 才叫 admin
--    ⚠️ 这会让“大区/校区管理者”不再命中旧 admin 策略，
--       他们只通过新 RPC / RLS 读档案，不能改全局配置/角色。
-- ------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid())
      and r.role = 'admin'
      and (r.admin_scope = 'owner' or r.admin_scope is null)
  );
$$;

-- ------------------------------------------------------------
-- 3. 学生建档快照触发器
--    新学生：从创建老师的 user_profiles 带出 region_id/campus_id；
--    created_at 默认 now()。更新时不覆盖已有快照（只填 null）。
-- ------------------------------------------------------------
create or replace function public.snapshot_student_campus()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_region uuid;
  v_campus uuid;
begin
  if new.region_id is null or new.campus_id is null then
    select p.region_id, p.campus_id
      into v_region, v_campus
      from public.user_profiles p
     where p.user_id = new.user_id;

    if new.region_id is null then new.region_id := v_region; end if;
    if new.campus_id is null then new.campus_id := v_campus; end if;
  end if;

  if new.created_at is null then
    new.created_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists snapshot_student_campus_trg on public.feedback_students;
create trigger snapshot_student_campus_trg
  before insert or update on public.feedback_students
  for each row
  execute function public.snapshot_student_campus();

-- ------------------------------------------------------------
-- 4. RPC：学生总览（scope 在函数内部判断，不信前端参数）
-- ------------------------------------------------------------
create or replace function public.admin_list_all_students(
  p_search  text default '',
  p_campus  text default '',
  p_teacher text default '',
  p_month   text default '',
  p_limit   integer default 200,
  p_offset  integer default 0
)
returns table (
  id                 bigint,
  name               text,
  grade              text,
  school             text,
  manager            text,
  teacher_name       text,
  teacher_campus     text,
  institution_campus text,
  campus_source      text,
  owner_email        text,
  updated_at         timestamptz,
  last_activity_at   timestamptz,
  total_count        bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_archive_scope() then
    raise exception 'permission denied: archive scope required'
      using errcode = '42501';
  end if;

  return query
  with base as (
    select
      s.id,
      s.user_id,
      s.name,
      coalesce(s.grade, '') as grade,
      coalesce(s.campus, '') as school,
      coalesce(s.manager, '') as manager,
      coalesce(p.teacher_name, '') as teacher_name,
      coalesce(p.campus, '') as teacher_campus,
      coalesce(
        nullif(btrim(coalesce(s.extra ->> 'institutionCampus', '')), ''),
        nullif(btrim(coalesce(p.campus, '')), ''),
        ''
      ) as institution_campus,
      case
        when nullif(btrim(coalesce(s.extra ->> 'institutionCampus', '')), '') is not null then 'manual'
        when nullif(btrim(coalesce(p.campus, '')), '') is not null then 'teacher'
        else 'none'
      end as campus_source,
      coalesce(u.email::text, '') as owner_email,
      s.updated_at,
      s.region_id,
      s.campus_id,
      greatest(
        s.updated_at,
        coalesce(
          (select max(h.created_at) from public.feedback_history h
            where h.user_id = s.user_id and h.student_name = s.name),
          s.updated_at
        )
      ) as last_activity_at
    from public.feedback_students s
    join auth.users u on u.id = s.user_id
    left join public.user_profiles p on p.user_id = s.user_id
    where public.is_owner()
       or public.is_region_admin(s.region_id)
       or public.is_campus_admin(s.campus_id)
  )
  select
    b.id, b.name, b.grade, b.school, b.manager,
    b.teacher_name, b.teacher_campus, b.institution_campus, b.campus_source,
    b.owner_email, b.updated_at, b.last_activity_at,
    count(*) over() as total_count
  from base b
  where (
    coalesce(btrim(p_search), '') = ''
    or b.name ilike '%' || btrim(p_search) || '%'
    or b.teacher_name ilike '%' || btrim(p_search) || '%'
    or b.school ilike '%' || btrim(p_search) || '%'
    or b.manager ilike '%' || btrim(p_search) || '%'
    or b.owner_email ilike '%' || btrim(p_search) || '%'
  )
  and (
    coalesce(btrim(p_campus), '') = ''
    or b.institution_campus = btrim(p_campus)
  )
  and (
    coalesce(btrim(p_teacher), '') = ''
    or b.teacher_name = btrim(p_teacher)
  )
  and (
    coalesce(btrim(p_month), '') = ''
    or exists (
      select 1 from public.feedback_history h
      where h.user_id = b.user_id
        and h.student_name = b.name
        and to_char(coalesce(h.date::timestamptz, h.created_at), 'YYYY-MM') = btrim(p_month)
    )
  )
  order by b.last_activity_at desc nulls last, b.id desc
  limit greatest(1, least(coalesce(p_limit, 200), 1000))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.admin_list_all_students(text, text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_all_students(text, text, text, text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- 5. RPC：教师资料（Owner 全部；大区本区；校区本校）
-- ------------------------------------------------------------
create or replace function public.admin_list_profiles()
returns table (
  user_id      uuid,
  teacher_name text,
  subject      text,
  campus       text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_archive_scope() then
    raise exception 'permission denied: archive scope required'
      using errcode = '42501';
  end if;

  return query
    select p.user_id, p.teacher_name, p.subject, p.campus
    from public.user_profiles p
    where public.is_owner()
       or public.is_region_admin(p.region_id)
       or public.is_campus_admin(p.campus_id)
    order by p.updated_at desc;
end;
$$;

revoke all on function public.admin_list_profiles() from public, anon;
grant execute on function public.admin_list_profiles() to authenticated;

-- ------------------------------------------------------------
-- 6. RPC：大盘（scope 内聚合）
-- ------------------------------------------------------------
create or replace function public.admin_archive_stats()
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
    raise exception 'permission denied: archive scope required'
      using errcode = '42501';
  end if;

  with base as (
    select
      s.id,
      s.user_id,
      s.name,
      s.updated_at,
      s.region_id,
      s.campus_id,
      coalesce(
        (select min(h.created_at) from public.feedback_history h
          where h.user_id = s.user_id and h.student_name = s.name),
        s.updated_at
      ) as first_seen_at,
      coalesce(
        nullif(btrim(coalesce(s.extra ->> 'institutionCampus', '')), ''),
        nullif(btrim(coalesce(p.campus, '')), ''),
        '未归属'
      ) as campus
    from public.feedback_students s
    left join public.user_profiles p on p.user_id = s.user_id
    where public.is_owner()
       or public.is_region_admin(s.region_id)
       or public.is_campus_admin(s.campus_id)
  ),
  campus_counts as (
    select campus, count(*)::int as count
    from base
    group by campus
    order by count desc, campus
  ),
  new_month as (
    select count(*)::int as count
    from base
    where first_seen_at >= date_trunc('month', now())
  ),
  feedback_month as (
    select count(*)::int as count
    from public.feedback_history h
    join public.feedback_students s
      on s.user_id = h.user_id and s.name = h.student_name
    where h.tool = 'feedback'
      and h.created_at >= date_trunc('month', now())
      and (public.is_owner()
        or public.is_region_admin(s.region_id)
        or public.is_campus_admin(s.campus_id))
  ),
  active_plans as (
    select count(distinct s.id)::int as count
    from public.feedback_students s
    where (public.is_owner()
        or public.is_region_admin(s.region_id)
        or public.is_campus_admin(s.campus_id))
      and exists (
        select 1 from public.feedback_history h
        where h.user_id = s.user_id
          and h.student_name = s.name
          and h.tool = 'math-plan'
          and h.created_at >= now() - interval '90 days'
      )
  ),
  monthly_trend as (
    select
      to_char(date_trunc('month', coalesce(h.date::timestamptz, h.created_at)), 'YYYY-MM') as month,
      round(avg(h.score * 100.0 / h.full_score)::numeric, 1)::float8 as avg_percent,
      count(*)::int as count
    from public.feedback_history h
    join public.feedback_students s
      on s.user_id = h.user_id and s.name = h.student_name
    where h.score is not null
      and h.full_score is not null
      and h.full_score > 0
      and coalesce(h.date::timestamptz, h.created_at) >= date_trunc('month', now()) - interval '5 months'
      and (public.is_owner()
        or public.is_region_admin(s.region_id)
        or public.is_campus_admin(s.campus_id))
    group by 1
    order by 1
  )
  select jsonb_build_object(
    'totalStudents', (select count(*)::int from base),
    'newThisMonth', (select count from new_month),
    'feedbackThisMonth', (select count from feedback_month),
    'estimatedHoursThisMonth', (select count * 2 from feedback_month),
    'activePlans', (select count from active_plans),
    'campusDistribution', (
      select coalesce(jsonb_agg(jsonb_build_object('campus', campus, 'count', count)), '[]'::jsonb)
      from campus_counts
    ),
    'monthlyTrend', (
      select coalesce(jsonb_agg(jsonb_build_object('month', month, 'avgPercent', avg_percent, 'count', count) order by month), '[]'::jsonb)
      from monthly_trend
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.admin_archive_stats() from public, anon;
grant execute on function public.admin_archive_stats() to authenticated;

-- ------------------------------------------------------------
-- 7. RPC：归属纠正（**只 Owner**；大区/校区管理者只读）
-- ------------------------------------------------------------
create or replace function public.admin_set_student_campus(
  p_student_id bigint,
  p_campus     text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campus text := btrim(coalesce(p_campus, ''));
begin
  if not public.is_owner() then
    raise exception 'permission denied: owner only'
      using errcode = '42501';
  end if;

  if v_campus = '' then
    update public.feedback_students
       set extra = coalesce(extra, '{}'::jsonb) - 'institutionCampus',
           updated_at = now()
     where id = p_student_id;
  else
    update public.feedback_students
       set extra = coalesce(extra, '{}'::jsonb)
                   || jsonb_build_object('institutionCampus', v_campus),
           updated_at = now()
     where id = p_student_id;
  end if;

  if not found then
    raise exception 'student not found'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.admin_set_student_campus(bigint, text) from public, anon;
grant execute on function public.admin_set_student_campus(bigint, text) to authenticated;

-- ------------------------------------------------------------
-- 8. RLS：大区/校区
-- ------------------------------------------------------------
alter table public.regions enable row level security;
alter table public.campuses enable row level security;

drop policy if exists "regions readable by authenticated" on public.regions;
create policy "regions readable by authenticated"
  on public.regions for select to authenticated
  using (true);

drop policy if exists "regions owner write" on public.regions;
create policy "regions owner write"
  on public.regions for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

drop policy if exists "campuses readable by authenticated" on public.campuses;
create policy "campuses readable by authenticated"
  on public.campuses for select to authenticated
  using (true);

drop policy if exists "campuses owner write" on public.campuses;
create policy "campuses owner write"
  on public.campuses for all to authenticated
  using (public.is_owner())
  with check (public.is_owner());

-- ------------------------------------------------------------
-- 9. RLS：教师资料（本人 + Owner/大区/校区范围）
-- ------------------------------------------------------------
drop policy if exists "profiles read by scope" on public.user_profiles;
create policy "profiles read by scope"
  on public.user_profiles for select to authenticated
  using (
    public.is_owner()
    or public.is_region_admin(region_id)
    or public.is_campus_admin(campus_id)
  );

-- ------------------------------------------------------------
-- 10. RLS：学生档案（本人 + Owner/大区/校区范围；管理员只读）
-- ------------------------------------------------------------
drop policy if exists "students read by scope" on public.feedback_students;
create policy "students read by scope"
  on public.feedback_students for select to authenticated
  using (public.can_read_student(user_id, region_id, campus_id));

-- ------------------------------------------------------------
-- 11. RLS：历史（通过学生归属判断；本人/管理员只读）
-- ------------------------------------------------------------
drop policy if exists "history read by scope" on public.feedback_history;
create policy "history read by scope"
  on public.feedback_history for select to authenticated
  using (
    exists (
      select 1
      from public.feedback_students s
      where s.user_id = feedback_history.user_id
        and s.name = feedback_history.student_name
        and public.can_read_student(s.user_id, s.region_id, s.campus_id)
    )
  );

-- ------------------------------------------------------------
-- 12. 自检（执行后）
-- ------------------------------------------------------------
-- 12.1 函数在
-- select proname from pg_proc
-- where pronamespace = 'public'::regnamespace
--   and proname in ('is_owner','is_region_admin','is_campus_admin','has_archive_scope','can_read_student');
--
-- 12.2 RLS 策略
-- select tablename, policyname, cmd from pg_policies
-- where schemaname = 'public'
--   and tablename in ('regions','campuses','user_profiles','feedback_students','feedback_history')
-- order by tablename, policyname;
