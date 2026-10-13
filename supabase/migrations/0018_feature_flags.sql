-- ============================================================================
-- 0018 功能开关（feature flags）
-- ----------------------------------------------------------------------------
-- 干什么：给"初版功能"一个**后台能一键关掉**的开关。
--   关掉后：对应入口消失（工具页 iframe 会带上关闭参数），**代码与数据都不变**，
--   最多 30 秒全站生效（进程内缓存，与 tools 表同一套做法）——**不用重新部署**。
--
-- 谁读它：
--   · 管理后台 /admin「功能开关」区（管理员可切换）
--   · `src/lib/feature-flags.ts` 的服务端读取（`ToolPageShell` 用它把关闭参数拼到 iframe src 上）
--   · 工具页那份开关（如 `COMPANY_EXPORT_ENABLED` / `?nocompanyexport=1`）是**前端兜底**，
--     优先级：URL 参数（含本表拼出来的）> 代码常量。所以这里关掉＝一定关。
--
-- ⚠️ 读不到这张表（迁移没跑 / DB 抖动）时，代码一律**当"开启"**处理 ——
--    一个数据库小抖动不该悄悄把功能干掉；后台会明确显示"表还没建 + 要跑哪个迁移"。
--
-- 重复执行安全（create table if not exists + on conflict do nothing）。
-- ============================================================================

create table if not exists public.feature_flags (
  key        text primary key,
  enabled    boolean not null default true,
  label      text not null default '',
  note       text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text
);

comment on table public.feature_flags is
  '功能开关：后台可一键关掉初版功能。代码侧的"开关登记表"在 src/lib/feature-flags.ts 的 FEATURE_FLAG_REGISTRY（key 必须两边一致）。';

-- 读：所有登录用户都能读（工具页渲染时要读它判断入口是否显示）；
-- 写：只有管理员（与 tools 表同一套策略写法，is_admin() 来自 0001）。
alter table public.feature_flags enable row level security;

drop policy if exists "feature_flags readable by authenticated" on public.feature_flags;
create policy "feature_flags readable by authenticated"
  on public.feature_flags for select to authenticated
  using (true);

drop policy if exists "admins write feature_flags" on public.feature_flags;
create policy "admins write feature_flags"
  on public.feature_flags for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select, insert, update, delete on public.feature_flags to authenticated;

-- 种子：公司模板导出的开关（默认开）。
-- 关掉它 = 试卷分析「③ 生成报告」页的「🏢 公司模板导出」面板消失（其它功能照常）。
insert into public.feature_flags (key, enabled, label, note) values
  (
    'company_export',
    true,
    '公司模板导出（试卷分析）',
    '试卷分析「③ 生成报告」页的「🏢 公司模板导出」面板（附件1/附件2）。关掉后面板消失、按钮点不动，其它功能一律照常。'
  )
on conflict (key) do nothing;
