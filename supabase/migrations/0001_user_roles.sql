-- ============================================================
-- My Toolbox 用户角色与权限管理
-- 在 Supabase Dashboard -> SQL Editor 中整段执行
-- 可重复执行（幂等）
-- ============================================================

-- ---------- 1. 角色枚举 ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'user');
  end if;
end
$$;

-- ---------- 2. user_roles 表 ----------
create table if not exists public.user_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       public.user_role not null default 'user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_roles_role_idx on public.user_roles (role);

-- 权限：显式授权给 authenticated（anon 不需要访问该表）
grant select on public.user_roles to authenticated;
grant insert, update on public.user_roles to authenticated;

-- ---------- 3. 判断当前用户是否管理员 ----------
-- SECURITY DEFINER + 锁定 search_path，避免被 RLS 递归影响与搜索路径劫持
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = (select auth.uid())
      and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to authenticated;

-- ---------- 4. 行级安全策略 ----------
alter table public.user_roles enable row level security;

-- 4.1 用户只能读取自己的角色（应用判断权限时使用）
drop policy if exists "users read own role" on public.user_roles;
create policy "users read own role"
  on public.user_roles
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- 4.2 用户只能为自己创建一行，且只能是 'user' 角色（防止自行提权）
drop policy if exists "users insert own role" on public.user_roles;
create policy "users insert own role"
  on public.user_roles
  for insert
  to authenticated
  with check (user_id = (select auth.uid()) and role = 'user');

-- 4.3 管理员可读取所有角色
drop policy if exists "admins read all roles" on public.user_roles;
create policy "admins read all roles"
  on public.user_roles
  for select
  to authenticated
  using (public.is_admin());

-- 4.4 管理员可修改任意用户的角色
--     用 with check 限制新角色只能是 'admin' / 'user'
drop policy if exists "admins update roles" on public.user_roles;
create policy "admins update roles"
  on public.user_roles
  for update
  to authenticated
  using (public.is_admin())
  with check (role in ('admin', 'user'));

-- 4.5 管理员可为他人补建角色记录
drop policy if exists "admins insert roles" on public.user_roles;
create policy "admins insert roles"
  on public.user_roles
  for insert
  to authenticated
  with check (public.is_admin());

-- ---------- 5. updated_at 自动维护 ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_roles_touch_updated_at on public.user_roles;
create trigger user_roles_touch_updated_at
  before update on public.user_roles
  for each row
  execute function public.touch_updated_at();

-- ---------- 6. 管理员专用：列出全部注册用户 ----------
-- 说明：auth.users 受 RLS 保护，SQL 策略无法授权读取，
--       因此用 SECURITY DEFINER 函数承担这一读取，
--       并在函数内部自行校验调用者是否为管理员。
create or replace function public.admin_list_users()
returns table (
  user_id         uuid,
  email           text,
  role            public.user_role,
  created_at      timestamptz,
  last_sign_in_at timestamptz,
  email_confirmed boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- 关键安全检查：非管理员直接报错，不返回任何数据
  if not public.is_admin() then
    raise exception 'permission denied: admin only'
      using errcode = '42501';
  end if;

  return query
    select
      u.id,
      u.email::text,
      coalesce(r.role, 'user'::public.user_role) as role,
      u.created_at,
      u.last_sign_in_at,
      (u.email_confirmed_at is not null) as email_confirmed
    from auth.users u
    left join public.user_roles r on r.user_id = u.id
    order by u.created_at desc;
end;
$$;

revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- ---------- 7. 管理员专用：修改指定用户角色 ----------
create or replace function public.admin_set_user_role(
  p_user_id uuid,
  p_role    public.user_role
)
returns public.user_role
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin_count integer;
  v_current     public.user_role;
begin
  if not public.is_admin() then
    raise exception 'permission denied: admin only'
      using errcode = '42501';
  end if;

  select count(*) into v_admin_count
  from public.user_roles
  where role = 'admin';

  select role into v_current
  from public.user_roles
  where user_id = p_user_id;

  -- 防止把最后一个管理员降级，导致无人能进入后台
  if p_role = 'user'
     and v_current = 'admin'
     and coalesce(v_admin_count, 0) <= 1 then
    raise exception '不能降级最后一个管理员' using errcode = 'P0001';
  end if;

  insert into public.user_roles (user_id, role)
  values (p_user_id, p_role)
  on conflict (user_id) do update
    set role = excluded.role,
        updated_at = now();

  return p_role;
end;
$$;

revoke all on function public.admin_set_user_role(uuid, public.user_role) from public, anon;
grant execute on function public.admin_set_user_role(uuid, public.user_role) to authenticated;

-- ---------- 8. 验证（可选，执行后应看到结果） ----------
-- select * from public.admin_list_users();
