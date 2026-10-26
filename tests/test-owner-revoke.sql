-- ============================================================
-- 测试账号降级（跑完全套后立即执行）
-- ----------------------------------------------------------------------------
-- 只把 rolea 测试账号降回普通 user；不改会员 plan/status/expires_at。
-- 生产库如果临时提权过 rolea，也必须用本文件收口，确保线上只有真实 Owner。
-- ============================================================

update public.user_roles r
set role = 'user',
    admin_scope = null,
    scope_id = null,
    campus_id = null,
    updated_at = now()
from auth.users u
where u.id = r.user_id
  and u.email like 'rolea-%@gmail.com';

select u.email, r.role, r.admin_scope, r.scope_id, r.campus_id
from public.user_roles r
join auth.users u on u.id = r.user_id
where u.email like 'rolea-%@gmail.com';
