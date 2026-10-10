-- ============================================================
-- 0016：把 feedback_history.tool 的合法值放开到 math-plan
--
-- 背景：0014 建这条 CHECK 时只登记了 `feedback` / `paper` 两个值，
--       并留了一句「math-plan 暂时不写历史，将来要加再改这条约束」。
--       2026-10「学员档案」这个功能要做，用户确认**现在就把这条改掉**
--       （档案页要把辅导方案也收进来）。
--
-- ⚠️ 为什么要单独一条迁移、而不是只改代码：
--       `src/app/api/students/route.ts` 里的 `ALLOWED_TOOLS` 白名单和这条 CHECK
--       **必须一致**，两边缺一不可：
--         · 只改代码 → 写库时撞约束（23514 check_violation）
--         · 只改库   → 接口白名单仍然 400 拒绝
--       所以顺序是：先执行本迁移，再把 `ALLOWED_TOOLS` 加上 "math-plan"。
--
-- ⚠️ 本迁移**只动这一条 CHECK**，不碰表结构、不碰 RLS、不碰数据。
--
-- 幂等：先 drop if exists 再 add，可重复执行。
-- 在 Supabase Dashboard -> SQL Editor 中整段执行。
--
-- ⚠️ 线上**已执行过**：用户 2026-10 在 SQL Editor 里跑过等价 SQL
--    （见 docs/next-session-todo.md「1c」）。本文件是把那次操作**固化进仓库**，
--    免得下个会话不知道这条约束已经变了。重复执行是安全的。
-- ============================================================

alter table public.feedback_history
  drop constraint if exists feedback_history_tool_check;

alter table public.feedback_history
  add constraint feedback_history_tool_check
  check (tool in ('feedback', 'paper', 'math-plan'));

comment on column public.feedback_history.tool is
  '归属工具：feedback / paper / math-plan。默认 feedback 已让老数据自动归位。0016 起允许 math-plan（辅导方案的「存入档案」会写这个值）。';


-- ============================================================
-- 自检（执行完可以跑这几条确认）
-- ============================================================

-- 1) 约束确实变了（期望看到 tool = ANY (ARRAY['feedback','paper','math-plan'])）
select conname, pg_get_constraintdef(oid) as 约束内容
from pg_constraint
where conname = 'feedback_history_tool_check';

-- 2) 现有数据的归属分布（不应因本次迁移而变化）
select tool, count(*) as 条数
from public.feedback_history
group by tool
order by tool;
