-- ============================================================
-- 0011：修正「高中数学辅导方案生成器」的会员级别 → free
--
-- 背景（仓库与线上不一致）：
--   · 仓库 0003_seed_tools.sql 里，/tools/math-plan 的 min_plan 写的是 'free'
--   · 但线上 tools 表里它是 'vip'，导致非会员访问 /tools/math-plan 被重定向到 /upgrade
--
-- 漂移原因（重要，别再踩）：
--   0003 用的是 `insert ... where not exists (select 1 ... where route = v.route)`，
--   对**已存在**的 route 直接跳过、不做任何更新。所以 0003 里写的值只对
--   「首次插入」生效；之后无论怎么改 0003 里的 min_plan，线上都不会跟着变。
--
-- 口径：与 feedback、paper-analysis 保持一致 ——
--   **工具本身 free（所有登录用户可打开），只有其中的 AI 功能是 VIP 专属**
--   （对应 /api/math-plan/ai-sections 里的 requireVip()）。
--
-- 幂等：update 可重复执行；结尾自检会打印修正后的结果。
-- 在 Supabase Dashboard -> SQL Editor 中整段执行。
-- ============================================================

-- ---------- 1. 修正会员级别 ----------
update public.tools
   set min_plan = 'free'
 where route = '/tools/math-plan'
   and min_plan <> 'free';

-- ---------- 2. 自检：应看到 math-plan 为 free ----------
select sort_order, name, route, min_plan, active
from public.tools
where route = '/tools/math-plan';

-- ---------- 3. 全部工具一览（确认没有误改其他工具） ----------
-- 期望：vip-batch / vip-report 仍为 vip，其余（含 math-plan、paper-analysis）为 free
select sort_order, name, route, min_plan, active
from public.tools
order by sort_order;

-- ---------- 4. 一致性断言 ----------
-- 若下面这条返回 0 行，说明已与仓库口径一致。
select route, min_plan
from public.tools
where route = '/tools/math-plan' and min_plan <> 'free';
