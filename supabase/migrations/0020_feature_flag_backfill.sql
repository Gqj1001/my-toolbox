-- ============================================================
-- 0020：给「补录历史材料」登记一个功能开关种子
--
-- 背景：2026-10 第十八批上线了「学员档案 → 补录历史材料」
--       （把工具上线之前的旧试卷分析/辅导方案/课后反馈交给 AI 整理成统一格式后入档）。
--       用户要求：**初版功能一律能在管理后台一键关掉**（见 dsh-work-guide.md 坑 13）。
--
-- ⚠️ 为什么是**新的一条迁移**、而不是改 0018：
--       0018 里那条 seed 用的是 `on conflict (key) do nothing`，
--       所以**再跑一遍 0018 不会补出新 key**（它只建表 + 插 company_export）。
--       新增一个开关就新增一条迁移，这样"跑过哪些"一目了然。
--
-- ⚠️ 三处必须一致（缺一条后台就管不住，见 dsh-work-guide.md 坑 13）：
--       ① `src/lib/feature-flags.ts` 的 FEATURE_FLAG_REGISTRY 里已登记
--          （key / label / note / param=`nobackfill` / tools=[]）；
--       ② **就是本文件**：往表里插一条同 key 的种子；
--       ③ 受影响的页面认这个参数 —— 这里是 `/dashboard`，由它自己调
--          `pageDisables('backfill_materials')` 判断（它不在工具 iframe 里，
--          所以不走"服务端拼 iframe 参数"那条路）。
--
-- ⚠️ 不跑这一段会怎样：**功能照常可用**（读不到开关时一律当"开启"），
--       只是后台「功能开关」区里**看不到这一条**，也就没法一键关掉。
--
-- 幂等：on conflict (key) do nothing —— 重复执行安全。
-- 只往 feature_flags 插一行，**不动任何现有表、不动任何业务数据**。
-- ============================================================

insert into public.feature_flags (key, enabled, label, note) values
  (
    'backfill_materials',
    true,
    '补录历史材料（学员档案）',
    '学员档案详情页的「📥 补录历史材料」面板（把工具上线之前的旧试卷分析/辅导方案/课后反馈整理进档案）。关掉后面板消失；手动补录成绩、档案列表、学情分析等一律照常。'
  )
on conflict (key) do nothing;

-- ============================================================
-- 自检（执行完可以跑这两条确认）
-- ============================================================

-- 1) 应该看到两条开关，且 backfill_materials 是 enabled = true
select key, enabled, label, updated_at
from public.feature_flags
order by key;

-- 2) 表里有没有登记表之外的 key（正常应只有 company_export / backfill_materials）
select key from public.feature_flags
where key not in ('company_export', 'backfill_materials');
