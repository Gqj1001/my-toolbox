-- ============================================================
-- 0010：注册「试卷分析工作台」
--
-- 工具本体在 public/tools/paper-analysis/（多文件结构），
-- 包装页在 src/app/tools/paper-analysis/page.tsx。
-- 本文件只负责在 tools 表登记目录项，dashboard 会自动出现卡片。
--
-- 幂等：按 route 去重，重复执行不会产生重复行。
-- ============================================================

insert into public.tools (name, description, route, min_plan, active, sort_order)
select v.name, v.description, v.route, v.min_plan, v.active, v.sort_order
from (
  values
    (
      '试卷分析工作台',
      '上传试卷分析报告（docx/pdf/图片），自动生成逐题分析、题型分布与教学辅导建议',
      '/tools/paper-analysis',
      'free',
      true,
      6
    )
) as v(name, description, route, min_plan, active, sort_order)
where not exists (
  select 1 from public.tools t where t.route = v.route
);

-- ---------- 自检 ----------
select sort_order, name, route, min_plan, active
from public.tools
where route = '/tools/paper-analysis';

-- 全部工具一览（确认新工具已就位、旧工具未受影响）
select sort_order, name, route, min_plan, active
from public.tools
order by sort_order;
