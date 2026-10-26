-- ============================================================
-- 0029 权限 Phase 1 · 数据结构（只建表/加列，不改数据、不改 RLS）
-- ----------------------------------------------------------------------------
-- 用户 2026-10-24 拍板的一期范围：
--   · Owner（唯一）：1502569564@qq.com，只看；
--   · 大区管理者：一期只读（本大区）；
--   · 校区管理者：二期再做，但表结构一次设计到位；
--   · 老师一人只能属于一个校区，不允许跨校区；
--   · 学生档案归属用**快照**，不跟老师调动走；
--   · 历史数据回填后，待确认的由后台手动改。
--
-- ⚠️ 本文件**只做 DDL**：建 regions / campuses、加列、加索引。
--    · 不插入任何大区/校区（用户自己在后台建）；
--    · 不修改任何现有行；
--    · 不改 RLS / RPC / 应用代码。
--    · **执行前请先备份；执行后页面/代码仍按旧逻辑运行，不受影响。**
--
-- 建议执行顺序（本轮只审，不跑）：
--   1) 0029 本文件（安全）
--   2) 0030 回填 + Owner 切换（REVIEW ONLY，见单独文件）
--   3) 下一批代码：RLS / RPC scope / 后台页面 / 测试
--
-- 重复执行安全：create table if not exists / add column if not exists /
-- create index if not exists；类型用 DO 块防重复。
-- ============================================================

-- ------------------------------------------------------------
-- 0. 管理员范围枚举
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'admin_scope'
  ) then
    execute 'create type public.admin_scope as enum (''owner'', ''region'', ''campus'')';
  end if;
end $$;

comment on type public.admin_scope is
  '管理员范围：owner=唯一老板；region=大区管理者；campus=校区管理者（二期）。role 仍是 admin/user，scope 表达范围。';

-- ------------------------------------------------------------
-- 1. 大区
-- ------------------------------------------------------------
create table if not exists public.regions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.regions is
  '机构大区（如燕郊大区/大厂大区）。由 Owner 在后台创建；校区必须归属一个大区。';

-- ------------------------------------------------------------
-- 2. 校区
-- ------------------------------------------------------------
create table if not exists public.campuses (
  id         uuid primary key default gen_random_uuid(),
  region_id  uuid not null references public.regions(id) on delete restrict,
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campuses_region_name_key unique (region_id, name)
);

comment on table public.campuses is
  '机构校区（如燕郊校区/大厂校区）。允许不同大区重名，所以唯一键是 (region_id, name)。';

create index if not exists campuses_region_idx on public.campuses (region_id);

-- ------------------------------------------------------------
-- 3. 老师资料：归属一个大区 + 一个校区
--    ⚠️ 老师只能属于一个校区：用单列 campus_id，不用多对多表。
-- ------------------------------------------------------------
alter table public.user_profiles
  add column if not exists region_id uuid references public.regions(id) on delete set null,
  add column if not exists campus_id uuid references public.campuses(id) on delete set null;

comment on column public.user_profiles.region_id is
  '老师所属机构大区；由 Owner/后台维护。';
comment on column public.user_profiles.campus_id is
  '老师所属机构校区（单值，不允许跨校区）；原 campus text 保留做显示/兼容。';

create index if not exists user_profiles_region_idx on public.user_profiles (region_id);
create index if not exists user_profiles_campus_idx on public.user_profiles (campus_id);

-- ------------------------------------------------------------
-- 4. 学生档案：归属快照 + 真实建档时间
--    ⚠️ 学生归属用快照，老师调动不自动改历史。
--    ⚠️ created_at 先允许 null：老数据回填后再决定是否 not null。
-- ------------------------------------------------------------
alter table public.feedback_students
  add column if not exists region_id uuid references public.regions(id) on delete set null,
  add column if not exists campus_id uuid references public.campuses(id) on delete set null,
  add column if not exists created_at timestamptz;

comment on column public.feedback_students.region_id is
  '学生档案归属大区快照（建档时写入；不随老师调动自动改）。';
comment on column public.feedback_students.campus_id is
  '学生档案归属校区快照（建档时写入；不随老师调动自动改）。';
comment on column public.feedback_students.created_at is
  '真实建档时间；老数据在 0030 回填，未回填前允许 null。';

create index if not exists feedback_students_region_idx on public.feedback_students (region_id);
create index if not exists feedback_students_campus_idx on public.feedback_students (campus_id);
create index if not exists feedback_students_created_idx on public.feedback_students (created_at);

-- ------------------------------------------------------------
-- 5. 管理员范围
--    role 继续用 admin/user；admin_scope + scope_id 表达范围。
--    scope_id 指向 regions.id 或 campuses.id（多态，所以不加单列 FK）。
--    campus_id 冗余给“校区管理者”，便于 RLS 直接判断。
-- ------------------------------------------------------------
alter table public.user_roles
  add column if not exists admin_scope public.admin_scope,
  add column if not exists scope_id uuid,
  add column if not exists campus_id uuid references public.campuses(id) on delete set null;

comment on column public.user_roles.admin_scope is
  'owner=唯一老板；region=大区管理者；campus=校区管理者（二期）；普通教师为 null。';
comment on column public.user_roles.scope_id is
  'owner=null；region=regions.id；campus=campuses.id。多态列，不设单列 FK。';
comment on column public.user_roles.campus_id is
  '校区管理者的校区 ID（冗余，便于 RLS）；普通教师/大区管理员为 null。';

create index if not exists user_roles_scope_idx on public.user_roles (admin_scope, scope_id);
create index if not exists user_roles_campus_idx on public.user_roles (campus_id);

-- ------------------------------------------------------------
-- 6. 自检（执行后可跑；只读）
-- ------------------------------------------------------------
-- 6.1 新表/新列都在
-- select table_name, column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_schema = 'public'
--   and table_name in ('regions','campuses','user_profiles','feedback_students','user_roles')
--   and column_name in ('region_id','campus_id','created_at','admin_scope','scope_id')
-- order by table_name, ordinal_position;
--
-- 6.2 没有任何数据被改（应为 0）
-- select
--   (select count(*) from public.regions) as regions_rows,
--   (select count(*) from public.campuses) as campuses_rows,
--   (select count(*) from public.user_roles where admin_scope is not null) as scoped_roles;
