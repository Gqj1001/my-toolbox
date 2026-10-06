-- ============================================================
-- 0012：下线 4 个空壳工具（只设 active=false，**不删数据**）
--
-- 下线对象（都是早期占位，点进去没有实际功能）：
--   /tools/json-formatter       JSON 格式化
--   /tools/password-generator   密码生成器
--   /tools/vip-batch            会员专属：批量数据处理（纯占位）
--   /tools/vip-report           会员专属：高级报表导出（纯占位）
--
-- 为什么用 active=false 而不是 delete：
--   · `active` 就是「是否出现在目录里」的开关（见 src/lib/tools-db.ts：
--     `getActiveTools()` 过滤 `.eq("active", true)`）；
--   · 置 false 之后：/dashboard、/tools 不再显示这张卡片；
--     直接访问该网址 → `getToolByRoute()` 也只看 active=true，于是渲染 404「页面不存在」。
--   · 数据与 sort_order 全部保留，以后想恢复只要把 active 改回 true。
--
-- ⚠️ 副作用（重要）：`/admin` **没有**关工具的界面，所以这条是本项目目前唯一的开关方式。
--    执行完之后，/dashboard 上普通用户只剩 3 张卡片：
--      /tools/math-plan、/tools/paper-analysis、/tools/feedback
--    而 tests/paper-regression.test.mjs 里原来断言「json-formatter 能打开占位页」——
--    那一条已经同步改成「应被下线」（同一次提交里改的），否则回归会红。
--
-- 幂等：update 带 `active is distinct from false` 条件，可重复执行。
-- 在 Supabase Dashboard -> SQL Editor 中整段执行。
-- ============================================================

-- ---------- 1. 下线这 4 个工具 ----------
update public.tools
   set active = false
 where route in (
         '/tools/json-formatter',
         '/tools/password-generator',
         '/tools/vip-batch',
         '/tools/vip-report'
       )
   and active is distinct from false;

-- ---------- 2. 自检：这 4 个应全部 active=false ----------
-- 期望：4 行，active 列全为 false
select sort_order, name, route, min_plan, active
from public.tools
where route in (
        '/tools/json-formatter',
        '/tools/password-generator',
        '/tools/vip-batch',
        '/tools/vip-report'
      )
order by sort_order;

-- ---------- 3. 自检：普通用户实际能看到的就是这 3 个 ----------
-- 期望：正好 3 行（math-plan / paper-analysis / feedback），顺序 1、6、15
select sort_order, name, route, min_plan
from public.tools
where active = true
order by sort_order;

-- ---------- 4. 自检：全表一览（确认没有误改其它行）----------
-- 期望：共 7 行，其中 active=true 3 行、active=false 4 行
select sort_order, name, route, min_plan, active
from public.tools
order by sort_order;

-- ---------- 5. 一致性断言 ----------
-- 期望：返回 0 行（说明这 4 个已全部下线）。若仍有行，说明第 1 步没生效。
select route, active
from public.tools
where route in (
        '/tools/json-formatter',
        '/tools/password-generator',
        '/tools/vip-batch',
        '/tools/vip-report'
      )
  and active is distinct from false;

-- ---------- 6. 一致性断言 ----------
-- 期望：返回 3（普通用户可见的工具数）
select count(*) as visible_tools
from public.tools
where active = true;
