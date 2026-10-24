-- ============================================================
-- 0027 全机构档案总览（A2：只读总览 + 归属标签纠正）
-- ----------------------------------------------------------------------------
-- 用户 2026-10-24 拍板：
--   · 老板（超级管理员）**只看**，不改别人校区的档案正文；
--   · “校区”指**机构校区**（老师所在校区，如燕郊/大厂），不是学生学校；
--   · 历史档案先按**老师当前校区**推断；推错的，后台可单独纠正这个学生的归属标签；
--   · 目前只有老板一个人要超级权限；不动现有 RLS、不改老师端。
--
-- 本迁移只加两个 SECURITY DEFINER 函数（不加表、不加列、不改 0021 的 RLS）：
--   1. admin_list_all_students(...)  只读总览（搜索 + 按老师/校区筛选 + 分页）
--   2. admin_set_student_campus(...) 只改 feedback_students.extra 里的
--      `institutionCampus` 标签（不改正文、不改分数、不改老师端数据）
--
-- 推断口径（优先级从高到低）：
--   a. 该学生 `extra.institutionCampus`（后台手动纠正过，最高优先）
--   b. 创建该档案的老师在 `user_profiles.campus` 里的机构校区
--   c. 空（显示“未归属”，不猜）
--
-- 安全性：
--   · 两个函数都 SECURITY DEFINER + `set search_path = ''`；
--   · 函数内部 `public.is_admin()` 校验，非管理员直接 42501；
--   · 只 revoke public/anon，grant 给 authenticated（函数内部还会再判 admin）。
--
-- 重复执行安全（create or replace + 幂等 grant）。
-- 执行后：后台首页出现「全机构档案总览」入口，`/admin/archives` 可打开。
-- ============================================================

-- ------------------------------------------------------------
-- 1. 只读总览
-- ------------------------------------------------------------
create or replace function public.admin_list_all_students(
  p_search  text default '',
  p_campus  text default '',
  p_teacher text default '',
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
      s.updated_at
    from public.feedback_students s
    join auth.users u on u.id = s.user_id
    left join public.user_profiles p on p.user_id = s.user_id
  )
  select
    b.id, b.name, b.grade, b.school, b.manager,
    b.teacher_name, b.teacher_campus, b.institution_campus, b.campus_source,
    b.owner_email, b.updated_at,
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
  order by b.updated_at desc nulls last, b.id desc
  limit greatest(1, least(coalesce(p_limit, 200), 1000))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

comment on function public.admin_list_all_students(text, text, text, integer, integer) is
  '管理后台·全机构档案总览：只读；按学生/老师/学校/学管师/邮箱搜索，按机构校区/老师筛选。机构校区优先取 extra.institutionCampus，否则取创建老师 user_profiles.campus。';

revoke all on function public.admin_list_all_students(text, text, text, integer, integer) from public, anon;
grant execute on function public.admin_list_all_students(text, text, text, integer, integer) to authenticated;

-- ------------------------------------------------------------
-- 2. 归属标签纠正（只改 extra.institutionCampus，不碰档案正文）
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
  if not public.is_admin() then
    raise exception 'permission denied: admin only'
      using errcode = '42501';
  end if;

  if v_campus = '' then
    -- 清空 = 恢复“按老师当前校区推断”
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

comment on function public.admin_set_student_campus(bigint, text) is
  '管理后台·归属纠正：只改 feedback_students.extra.institutionCampus（机构校区标签），不改档案正文；空串表示恢复按老师校区推断。';

revoke all on function public.admin_set_student_campus(bigint, text) from public, anon;
grant execute on function public.admin_set_student_campus(bigint, text) to authenticated;
