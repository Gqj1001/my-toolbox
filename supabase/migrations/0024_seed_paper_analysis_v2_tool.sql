-- ============================================================
-- 0024：注册「全学科试卷分析工作台（v2）」
--
-- 工具本体：public/tools/paper-analysis-v2/（index.html + app.css + js/app.js + subjects/）
-- 包装页：src/app/tools/paper-analysis-v2/page.tsx
--
-- ⚠️ 老数学版 /tools/paper-analysis **不动**：它只把纯逻辑脚本的引用路径
--    改到 js/core/，流程与界面一行未改。本工具是新的界面壳。
--
-- 幂等：按 route 去重；重复执行不会产生重复行。
-- ============================================================

insert into public.tools (name, description, route, min_plan, active, sort_order)
select v.name, v.description, v.route, v.min_plan, v.active, v.sort_order
from (
  values
    (
      '全学科试卷分析工作台',
      '全学科（数学/物理/英语/语文 × 初高中）试卷分析：学科网报告/整卷识别 → 逐题录分与考点 → 一次录入、三档导出公司附件1/2；AI 题干摘要与附件1三段归因初稿（需老师确认）',
      '/tools/paper-analysis-v2',
      'free',
      true,
      7
    )
) as v(name, description, route, min_plan, active, sort_order)
where not exists (
  select 1 from public.tools t where t.route = v.route
);

-- ---------- 自检 ----------
select sort_order, name, route, min_plan, active
from public.tools
where route in ('/tools/paper-analysis', '/tools/paper-analysis-v2')
order by sort_order;
