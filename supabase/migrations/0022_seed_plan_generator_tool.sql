-- ============================================================
-- 0022：注册「辅导方案生成器（全学科）」
--
-- 工具本体在 public/tools/plan-generator/（多文件结构：index.html + js/ + subjects/），
-- 包装页在 src/app/tools/plan-generator/page.tsx。
-- 本文件只负责在 tools 表登记目录项，dashboard / /tools 会自动出现卡片。
--
-- 与 /tools/math-plan 的关系：**两个独立工具**。
--   · math-plan 是数学专用版（单文件 HTML，数学老师每天在用，本次**一个字没动**）
--   · 本工具是通用版（学科 = 一份配置，物理是第一份；加化学/语文只是再加一个配置文件）
--
-- 幂等：按 route 去重，重复执行不会产生重复行。
-- 注意：本文件只做**首次插入**（where not exists），不更新已存在的行；
--       要改线上已有的行（例如换 min_plan）请另写一条 update 迁移（参照 0011）。
-- ============================================================

insert into public.tools (name, description, route, min_plan, active, sort_order)
select v.name, v.description, v.route, v.min_plan, v.active, v.sort_order
from (
  values
    (
      '辅导方案生成器（全学科）',
      '选学科+学段+年级+学情+总课时，自动生成「一行一模块」的辅导进度表；AI 生成教学目标初稿、老师就地编辑；可导出公司附件3与本工具 Word 模板，也可存入学生档案',
      '/tools/plan-generator',
      'free',
      true,
      2
    )
) as v(name, description, route, min_plan, active, sort_order)
where not exists (
  select 1 from public.tools t where t.route = v.route
);

-- ---------- 自检 ----------
select sort_order, name, route, min_plan, active
from public.tools
where route = '/tools/plan-generator';

-- 全部工具一览（确认新工具已就位、旧工具未受影响）
select sort_order, name, route, min_plan, active
from public.tools
order by sort_order, name;
