-- ============================================================
-- 0017：把 feedback_history.tool 的合法值放开到 analysis（学情报告）
--
-- 背景：0014 建这条 CHECK 时只有 feedback / paper，0016 放开了 math-plan。
--       2026-10 第三批做「学情分析」：AI 生成的**整体学情报告**会以
--       `tool='analysis'` 落库成一条历史记录（用户明确要"落库成一条记录"）。
--       报告本身写在 `text` 列，`title` 形如「学情报告 · 10月8日 15:04」。
--
-- ⚠️ 为什么要单独一条迁移、而不是只改代码：
--       `src/app/api/students/route.ts` 的 `ALLOWED_TOOLS` 与这条 CHECK
--       **必须一致**，两边缺一不可：
--         · 只改代码 → 写库时撞约束（23514 check_violation）
--         · 只改库   → 接口白名单仍然 400 拒绝
--       顺序：先执行本迁移，代码那半已经在同一批里改好了。
--
-- ⚠️ **不跑这一段会怎样**（重要，说清楚）：
--       学情报告的**生成**仍然成功（AI 那一步没问题），但**保存会失败** ——
--       接口会返回 409 并明确写出本文件名，前端会提示「报告已生成，但没能存进档案」，
--       并把报告正文照常显示出来（不会白花一次 AI 调用）。
--       页面上免费看到的统计部分完全不受影响。
--
-- ⚠️ 本迁移**只动这一条 CHECK**：不碰表结构、不碰 RLS、不碰任何数据。
--
-- 幂等：先 drop if exists 再 add，可重复执行。
-- 在 Supabase Dashboard -> SQL Editor 中**整段执行**（只跑这一段，不要多跑别的）。
--
-- ⚠️ 线上**已执行过**：用户 2026-10 在 SQL Editor 里跑过本段 SQL
--    （自检第 2 条当时返回 feedback=5 等分布，与执行前一致 ⇒ 只放宽了约束、没动数据）。
--    本文件是把那次操作**固化进仓库**，免得下个会话不知道这条约束已经变了。重复执行安全。
--    ➡️ 执行之后 `tests/student-analysis.test.mjs` 从 19 项变成 **21 项**：
--       落库分支（saved:true + 读回 tool='analysis'）与「报告不吃自己」两条开始生效。
-- ============================================================

alter table public.feedback_history
  drop constraint if exists feedback_history_tool_check;

alter table public.feedback_history
  add constraint feedback_history_tool_check
  check (tool in ('feedback', 'paper', 'math-plan', 'analysis'));

comment on column public.feedback_history.tool is
  '归属工具：feedback / paper / math-plan / analysis。默认 feedback 已让老数据自动归位。0016 放开 math-plan（辅导方案「存入档案」）；0017 放开 analysis（学情分析生成的 AI 报告）。';


-- ============================================================
-- 自检（执行完可以跑这几条确认）
-- ============================================================

-- 1) 约束确实变了（期望看到 tool = ANY (ARRAY['feedback','paper','math-plan','analysis'])）
select conname, pg_get_constraintdef(oid) as 约束内容
from pg_constraint
where conname = 'feedback_history_tool_check';

-- 2) 现有数据的归属分布（不应因本次迁移而变化）
select tool, count(*) as 条数
from public.feedback_history
group by tool
order by tool;
