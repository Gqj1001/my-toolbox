-- ============================================================
-- 0023 新注册用户自动送 15 天会员（VIP 体验期）
-- ----------------------------------------------------------------------------
-- 用户 2026-10 的要求（逐字）：
--   「每个新注册的用户，默认自动获得 15 天的会员（VIP）体验期。」
--   并且明确要求：**不能写在前端或注册页面里，也不能改现有注册接口**
--   （万一用户注册完直接关页面就漏了）⇒ 必须在数据库层面做。
--
-- 做法：在 auth.users 上建一个 **after insert** 触发器。
--   Supabase 的注册（邮箱密码 / 后台建用户 / 未来任何注册方式）最终都会
--   往 auth.users 插一行；插完立刻给这个 user_id 建 user_roles 行：
--     plan='vip', status='active', expires_at=now()+15 days
--
-- ⚠️ 三条兼容性保证（用户特别点名）：
--   1. **不覆盖管理员的手动操作**：只在新用户插入时动手，且
--      `on conflict (user_id) do nothing` —— 如果这一行已经存在（任何原因），
--      原样保留，绝不改写；管理员之后的「开通 / 取消 / 封禁」都是 update，
--      本触发器只监听 insert，不会碰。
--   2. **不回溯老用户**：没有任何 update/backfill；只对执行这条 SQL 之后
--      新注册的人生效。已注册的免费用户不会被自动升级。
--   3. **不能把注册搞崩**：触发器里的异常只 `raise warning` 并放行注册
--      （否则 user_roles 万一缺列/被锁，整个注册会失败）。失败时日志里
--      会有 warning，新用户按免费版处理。
--
-- ⚠️ 这不是“改表结构”：没有 add/drop column、没有 create table；
--    只新增一个函数 + 一个触发器（用户 2026-10 已同意写独立 migrations 文件）。
--
-- 重复执行安全：create or replace function + drop trigger if exists + create trigger。
-- ============================================================

create or replace function public.grant_trial_vip_on_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_roles (
    user_id,
    role,
    plan,
    status,
    expires_at,
    created_at,
    updated_at
  )
  values (
    new.id,
    'user',
    'vip',
    'active',
    now() + interval '15 days',
    now(),
    now()
  )
  on conflict (user_id) do nothing;

  return new;
exception
  when others then
    -- ⚠️ 绝不因为“送会员”失败而让注册失败；只记一条 warning。
    raise warning 'grant_trial_vip_on_signup 失败（不影响注册）：%', sqlerrm;
    return new;
end;
$$;

comment on function public.grant_trial_vip_on_signup() is
  '新注册自动送 15 天 VIP：auth.users 插入后为 new.id 建 user_roles 行；on conflict do nothing 不覆盖已有行；异常只 warning，不阻断注册。';

-- 触发器函数只允许由触发器调用，不给前端直接执行
revoke all on function public.grant_trial_vip_on_signup() from public;
revoke all on function public.grant_trial_vip_on_signup() from anon;
revoke all on function public.grant_trial_vip_on_signup() from authenticated;

drop trigger if exists on_auth_user_created_grant_trial_vip on auth.users;
create trigger on_auth_user_created_grant_trial_vip
  after insert on auth.users
  for each row
  execute function public.grant_trial_vip_on_signup();

-- ============================================================
-- 执行后自检（可手动跑；只读，不改数据）
-- ============================================================
-- 1) 触发器在不在（应看到 on_auth_user_created_grant_trial_vip）
-- select tgname, pg_get_triggerdef(oid)
-- from pg_trigger
-- where tgrelid = 'auth.users'::regclass and not tgisinternal;
--
-- 2) 函数是不是 security definer（prosecdef 应为 true）
-- select proname, prosecdef
-- from pg_proc
-- where proname = 'grant_trial_vip_on_signup';

-- ============================================================
-- 回滚（只在需要撤掉“自动送 15 天”时跑）
-- ----------------------------------------------------------------------------
-- drop trigger if exists on_auth_user_created_grant_trial_vip on auth.users;
-- drop function if exists public.grant_trial_vip_on_signup();
--
-- ⚠️ 回滚只停止“以后”的赠送；**已经发出去的 VIP 行不会自动收回**
--    （要收回去后台逐个取消，或另写 SQL）。
-- ============================================================
