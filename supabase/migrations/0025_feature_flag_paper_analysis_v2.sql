-- ============================================================
-- 0025：功能开关种子 —— 全学科试卷分析（v2）
--
-- 代码侧登记：src/lib/feature-flags.ts 的 FEATURE_FLAG_REGISTRY
--   key = paper_analysis_v2, param = nopaperv2, tools = ["paper-analysis-v2"]
--
-- 关掉后：/tools/paper-analysis-v2 的 iframe 会带上 ?nopaperv2=1，
--         新工具显示「该功能暂时关闭」；老数学版 /tools/paper-analysis 不受影响。
--
-- 幂等：on conflict (key) do nothing；重复执行安全。
-- ============================================================

insert into public.feature_flags (key, enabled, label, note) values
  (
    'paper_analysis_v2',
    true,
    '全学科试卷分析（v2）',
    '新的全学科试卷分析工作台（/tools/paper-analysis-v2）。关掉后工具页显示「该功能暂时关闭」，老的数学版 /tools/paper-analysis 完全不受影响。'
  )
on conflict (key) do nothing;

select key, enabled, label
from public.feature_flags
where key = 'paper_analysis_v2';
