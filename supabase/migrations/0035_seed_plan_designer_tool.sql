-- 0035：注册「个性化辅导方案设计器（新模板）」
-- 工具页在 src/app/tools/plan-designer，导出服务器模板在 public/templates/plan-designer-template.xlsx。
-- 幂等：按 route 去重。

insert into public.tools (name, description, route, min_plan, active, sort_order)
select v.name, v.description, v.route, v.min_plan, v.active, v.sort_order
from (
  values
    (
      '个性化辅导方案设计器（新）',
      '按新 xlsx 模板生成个性化辅导计划：窗口期、学情关键词、课程模块自由选择与排序，AI 润色分析/目标，导出可直接打印的 Excel',
      '/tools/plan-designer',
      'free',
      true,
      1
    )
) as v(name, description, route, min_plan, active, sort_order)
where not exists (
  select 1 from public.tools t where t.route = v.route
);

select sort_order, name, route, min_plan, active
from public.tools
where route = '/tools/plan-designer';
