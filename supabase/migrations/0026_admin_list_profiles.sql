-- ============================================================
-- 0026 管理员读取教师资料（姓名/学科/校区）
-- ----------------------------------------------------------------------------
-- 修什么：
--   老师在「个人资料」填了姓名/校区，后台用户列表却一直显示「资料未填」。
--   根因：`user_profiles` 的 RLS 只允许本人读（0021 的设计），而后台用
--   管理员自己的会话直接 `.from("user_profiles").select(...)`，所以只能读到
--   管理员自己那一行，别的老师一律被 RLS 挡掉。
--
-- 为什么不放宽 RLS：
--   `user_profiles` 里还有落款 `sig_teacher`；没必要让“任意 admin 会话”
--   直接扫整张表。这里用 SECURITY DEFINER 函数**只暴露后台需要的四列**
--   （user_id / teacher_name / subject / campus），并在函数内部用
--   `public.is_admin()` 校验调用者。
--
-- 安全性：
--   · SECURITY DEFINER + `set search_path = ''`（防搜索路径劫持）；
--   · 非管理员调用直接 42501，不返回任何行；
--   · 只 revoke public/anon，grant 给 authenticated（函数内部还会再判 admin）；
--   · 不新增表、不改列、不动 0021 的 RLS —— 只是给后台开一个受控读口。
--
-- 重复执行安全（create or replace + 幂等 grant）。
-- 执行后：后台用户列表应立刻显示老师填过的姓名/校区；无需重启服务。
-- ============================================================

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
  -- 关键安全检查：非管理员直接报错，不返回任何数据
  if not public.is_admin() then
    raise exception 'permission denied: admin only'
      using errcode = '42501';
  end if;

  return query
    select p.user_id, p.teacher_name, p.subject, p.campus
    from public.user_profiles p
    order by p.updated_at desc;
end;
$$;

comment on function public.admin_list_profiles() is
  '管理后台专用：返回全部教师资料的姓名/学科/校区（函数内部校验 is_admin，避免放宽 user_profiles 的 RLS）。';

revoke all on function public.admin_list_profiles() from public, anon;
grant execute on function public.admin_list_profiles() to authenticated;
