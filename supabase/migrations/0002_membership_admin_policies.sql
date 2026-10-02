-- ============================================================
-- 会员系统：管理后台所需的 RLS 策略
-- 在 Supabase Dashboard -> SQL Editor 中整段执行（幂等，可重复执行）
--
-- 背景：建表 SQL 只给了 tools 表「匿名只读」，管理后台需要 admin 能写；
--       user_roles 的旧策略 with check (role in ('admin','user')) 只覆盖 role 字段，
--       这里补上对 plan / expires_at / status 的完整授权。
--
-- 注意：示例工具数据不在此文件中，请执行 0003_seed_tools.sql
--       （它需要先给 tools.route 加唯一约束，on conflict 才有合法目标）
-- ============================================================

-- ---------- 1. tools 表：管理员可读写，所有登录用户可读 ----------
alter table public.tools enable row level security;

-- 1.1 所有登录用户（含匿名）都能读取启用中的工具
drop policy if exists "tools readable by everyone" on public.tools;
create policy "tools readable by everyone"
  on public.tools
  for select
  to anon, authenticated
  using (active = true);

-- 1.2 管理员可读取全部（含 active=false，便于在后台查看已下线工具）
drop policy if exists "admins read all tools" on public.tools;
create policy "admins read all tools"
  on public.tools
  for select
  to authenticated
  using (public.is_admin());

-- 1.3 管理员可新增工具
drop policy if exists "admins insert tools" on public.tools;
create policy "admins insert tools"
  on public.tools
  for insert
  to authenticated
  with check (public.is_admin());

-- 1.4 管理员可修改工具
drop policy if exists "admins update tools" on public.tools;
create policy "admins update tools"
  on public.tools
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 1.5 管理员可删除工具
drop policy if exists "admins delete tools" on public.tools;
create policy "admins delete tools"
  on public.tools
  for delete
  to authenticated
  using (public.is_admin());

grant select on public.tools to anon, authenticated;
grant insert, update, delete on public.tools to authenticated;

create index if not exists tools_active_sort_idx on public.tools (active, sort_order);

-- ---------- 2. user_roles：管理员可完整更新会员字段 ----------
-- 旧策略 "admins update roles" 的 with check 只允许 role in ('admin','user')，
-- 这里补一条不限字段的管理员更新策略。
-- 多条 permissive 策略之间是 OR 关系，因此不会与旧策略冲突。
drop policy if exists "admins update membership" on public.user_roles;
create policy "admins update membership"
  on public.user_roles
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- 管理员可为尚未建行的用户补建 user_roles 记录（开通会员时会用到 upsert）
-- 冲突目标 user_id 是主键，合法。
drop policy if exists "admins insert user roles" on public.user_roles;
create policy "admins insert user roles"
  on public.user_roles
  for insert
  to authenticated
  with check (public.is_admin());

grant select, insert, update on public.user_roles to authenticated;

-- ---------- 3. 执行后自检 ----------
-- 3.1 查看 tools 表策略
-- select policyname, cmd, roles from pg_policies where tablename = 'tools' order by policyname;

-- 3.2 查看 user_roles 表策略
-- select policyname, cmd from pg_policies where tablename = 'user_roles' order by policyname;

-- 3.3 确认 tools.route 的唯一约束（由 0003 创建）
-- select conname, contype from pg_constraint where conrelid = 'public.tools'::regclass;
