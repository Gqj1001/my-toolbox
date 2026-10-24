-- ============================================================
-- 0028 机构数据大盘：统计 + 档案总览的“月份下钻”
-- ----------------------------------------------------------------------------
-- 依据用户 2026-10-24 的任务：
--   · `/admin/archives` 顶部要有核心指标与图表；
--   · 点击图表（校区饼图 / 提分趋势折线）能过滤下方档案列表；
--   · 仍然只读、仍然只有 admin 能调用；不动 RLS / 老师端 / 表结构。
--
-- 本迁移做两件事：
--   1. `admin_archive_stats()`：一次返回大盘需要的聚合 JSON（KPI + 校区分布 + 月度趋势）
--   2. 重建 `admin_list_all_students(...)`：新增 `p_month` 与 `last_activity_at`
--      （月份下钻：只看该月有成绩/记录的学生）
--
-- ⚠️ 指标口径（页面也会写明，避免把估算当精确值）：
--   · 总学员数：feedback_students 行数；
--   · 本月新增：该学生最早一条历史记录的 created_at（没有历史时退回档案 updated_at）；
--   · 本月消耗课时：**按本月课后反馈条数 × 2 课时估算**（系统暂无逐次考勤，页面标“约”）；
--   · 进行中方案：最近 90 天内有过 math-plan 记录的学生数（没有“结课”字段，页面标口径）。
--
-- 重复执行安全：先 drop 旧签名再 create（函数返回列变了，不能用 create or replace）。
-- ============================================================

drop function if exists public.admin_list_all_students(text, text, text, integer, integer);

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
  if not public.is_admin() then
    raise exception 'permission denied: admin only'
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

comment on function public.admin_list_all_students(text, text, text, text, integer, integer) is
  '管理后台·全机构档案总览：只读；搜索 + 机构校区/老师/月份筛选。月份=该月有成绩或记录。';

revoke all on function public.admin_list_all_students(text, text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_all_students(text, text, text, text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- 大盘聚合（一次返回 JSON，避免前端多次查询）
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
  if not public.is_admin() then
    raise exception 'permission denied: admin only'
      using errcode = '42501';
  end if;

  with base as (
    select
      s.id,
      s.user_id,
      s.name,
      s.updated_at,
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
    from public.feedback_history
    where tool = 'feedback' and created_at >= date_trunc('month', now())
  ),
  active_plans as (
    select count(distinct s.id)::int as count
    from public.feedback_students s
    where exists (
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
    where h.score is not null
      and h.full_score is not null
      and h.full_score > 0
      and coalesce(h.date::timestamptz, h.created_at) >= date_trunc('month', now()) - interval '5 months'
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
      select coalesce(jsonb_agg(jsonb_build_object('month', month, 'avgPercent', avg_percent, 'count', count)), '[]'::jsonb)
      from monthly_trend
    )
  ) into v_result;

  return v_result;
end;
$$;

comment on function public.admin_archive_stats() is
  '管理后台·机构数据大盘：总学员/本月新增/本月反馈估算课时/进行中方案/校区分布/月度提分趋势（只读，内部校验 is_admin）。';

revoke all on function public.admin_archive_stats() from public, anon;
grant execute on function public.admin_archive_stats() to authenticated;
