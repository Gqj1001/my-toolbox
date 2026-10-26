-- ============================================================
-- 0030 之后的【测试环境】Test Owner 设置（**只在测试 Supabase 项目跑**）
-- ----------------------------------------------------------------------------
-- 0030 会把除真实 Owner 外的 admin 全部降级。全套测试用 rolea 当管理员，
-- 所以 0030 之后必须在**测试项目**把 rolea 设为 Test Owner，否则 admin 测试会红。
--
-- ⚠️ 生产库绝对不要执行本文件；生产只应有一个 Owner（1502569564@qq.com）。
-- ============================================================

-- 1) 已有 rolea 行 → 升为 Test Owner
update public.user_roles r
set role = 'admin',
    admin_scope = 'owner',
    scope_id = null,
    campus_id = null,
    plan = coalesce(r.plan, 'free'),
    status = coalesce(r.status, 'active'),
    updated_at = now()
from auth.users u
where u.id = r.user_id
  and u.email like 'rolea-%@gmail.com';

-- 2) 没有 rolea 行 → 补一行（通常 0023 送会员时已有）
insert into public.user_roles (user_id, role, plan, status, admin_scope, scope_id, campus_id)
select u.id, 'admin', 'free', 'active', 'owner', null, null
from auth.users u
where u.email like 'rolea-%@gmail.com'
  and not exists (
    select 1 from public.user_roles r where r.user_id = u.id
  );

-- 3) 验证：rolea 应为 admin / owner
select u.email, r.role, r.admin_scope, r.scope_id, r.campus_id
from public.user_roles r
join auth.users u on u.id = r.user_id
where u.email like 'rolea-%@gmail.com';
