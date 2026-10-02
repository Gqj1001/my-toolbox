-- ============================================================
-- 示例工具数据（可选，但推荐执行 —— tools 表为空时百宝箱没有卡片）
-- 在 Supabase Dashboard -> SQL Editor 中整段执行（幂等，可重复执行）
--
-- 关于之前的报错：
--   ERROR: 42P10: there is no unique or exclusion constraint
--   matching the ON CONFLICT specification
-- 原因：tools.route 上没有唯一约束（只有 id 是主键），
--       而 on conflict (route) 要求该列存在唯一索引。
-- 本文件改用 insert ... where not exists，不再依赖任何唯一约束，
-- 因此不会出现 42P10；结尾会补上 route 的唯一索引，便于今后用
-- insert ... on conflict (route) 的写法。
--
-- 请先执行 0002_membership_admin_policies.sql（提供 admin 写权限）。
-- ============================================================

-- ---------- 1. 写入示例数据（已存在同 route 则跳过） ----------
insert into public.tools (name, description, route, min_plan, active, sort_order)
select v.name, v.description, v.route, v.min_plan, v.active, v.sort_order
from (
  values
    ('JSON 格式化',           '校验并美化 JSON 文本，支持压缩与转义',       '/tools/json-formatter',     'free', true,  10),
    ('密码生成器',            '生成高强度随机密码，可自定义长度与字符集',   '/tools/password-generator', 'free', true,  20),
    ('高中数学辅导方案生成器', '根据学情参数自动生成高中数学辅导方案',       '/tools/math-plan',          'free', true,  30),
    ('会员专属：批量数据处理', 'VIP 专属，批量清洗与转换数据（占位）',       '/tools/vip-batch',          'vip',  true,  40),
    ('会员专属：高级报表导出', 'VIP 专属，导出多维统计报表（占位）',         '/tools/vip-report',         'vip',  true,  50),
    ('已下线工具（不应显示）', '用于验证 active=false 是否被正确过滤',       '/tools/hidden-demo',        'free', false, 60)
) as v(name, description, route, min_plan, active, sort_order)
where not exists (
  select 1 from public.tools t where t.route = v.route
);

-- ---------- 2. 为 route 补唯一约束 ----------
-- 2.1 先清理可能存在的重复 route（保留 sort_order 最小、再按 id 最小的一条）
delete from public.tools a
using public.tools b
where a.route = b.route
  and (
    a.sort_order > b.sort_order
    or (a.sort_order = b.sort_order and a.id > b.id)
  );

-- 2.2 再创建唯一索引（已存在则跳过）
create unique index if not exists tools_route_key on public.tools (route);

-- ---------- 3. 自检：应看到 6 行，其中 active=true 的 5 行 ----------
select sort_order, name, route, min_plan, active
from public.tools
order by sort_order;

-- ---------- 4. 顺带确认测试账号已进入 user_roles ----------
-- 若下面查询里 rolea / roleb 显示 plan 为 NULL，说明尚未给它们建行，
-- 会员功能将无法用这两个账号测试，请执行：
--
-- insert into public.user_roles (user_id, role, plan, expires_at, status)
-- select id, 'user', 'free', null, 'active' from auth.users
-- where email like 'roleb-%@gmail.com'
-- on conflict (user_id) do update
--   set role = excluded.role, plan = excluded.plan, status = excluded.status;
--
-- select u.email, r.role, r.plan, r.status
-- from public.user_roles r join auth.users u on u.id = r.user_id
-- order by u.email;
