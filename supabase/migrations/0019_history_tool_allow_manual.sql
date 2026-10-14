-- ============================================================
-- 0019：把 feedback_history.tool 的合法值放开到 manual（老师手动补录的成绩）
--
-- 背景：0014 建这条 CHECK 时只有 feedback / paper，0016 放开 math-plan，
--       0017 放开 analysis。2026-10 第十四批新增功能：**学员档案里可以手动补录一次成绩**
--       （"有时候我们不在这里考试，在其他地方的考试也具备一定参考意义"）——
--       补录的记录以 `tool='manual'` 落库，于是它会自动出现在档案的记录列表里，
--       也自动进入学情分析的**成绩趋势**与 AI 报告（趋势本来就是扫全部带分数的记录，不挑工具）。
--
-- ⚠️ 为什么要单独一条迁移、而不是只改代码：
--       `src/app/api/students/route.ts` 的 `ALLOWED_TOOLS` 与这条 CHECK
--       **必须一致**，两边缺一不可：
--         · 只改代码 → 写库时撞约束（23514 check_violation）
--         · 只改库   → 接口白名单仍然 400 拒绝
--       顺序：先执行本迁移，代码那半已经在同一批里改好了。
--
-- ⚠️ **不跑这一段会怎样**（重要，说清楚）：
--       补录的**其它什么都不受影响**（档案页、记录列表、学情分析统计、三个工具全都照常）；
--       只有"点保存"那一下会失败：接口返回 **409** 并**点名本文件名**，
--       页面上会显示「请先在 Supabase SQL Editor 执行 0019_history_tool_allow_manual.sql」。
--
-- ⚠️ 本迁移**只动这一条 CHECK**：不碰表结构、不碰 RLS、不碰任何数据。
--
-- 幂等：先 drop if exists 再 add，可重复执行。
-- 在 Supabase Dashboard -> SQL Editor 中**整段执行**（只跑这一段，不要多跑别的）。
-- ============================================================

alter table public.feedback_history
  drop constraint if exists feedback_history_tool_check;

alter table public.feedback_history
  add constraint feedback_history_tool_check
  check (tool in ('feedback', 'paper', 'math-plan', 'analysis', 'manual'));

comment on column public.feedback_history.tool is
  '归属工具：feedback / paper / math-plan / analysis / manual。默认 feedback 已让老数据自动归位。0016 放开 math-plan（辅导方案「存入档案」）；0017 放开 analysis（学情分析生成的 AI 报告）；0019 放开 manual（学员档案页老师手动补录的成绩）。';


-- ============================================================
-- 自检（执行完可以跑这几条确认）
-- ============================================================

-- 1) 约束确实变了（期望看到 tool = ANY (ARRAY['feedback','paper','math-plan','analysis','manual'])）
select conname, pg_get_constraintdef(oid) as 约束内容
from pg_constraint
where conname = 'feedback_history_tool_check';

-- 2) 现有数据的归属分布（不应因本次迁移而变化）
select tool, count(*) as 条数
from public.feedback_history
group by tool
order by tool;
