-- ============================================================
-- 0021 教师个人资料（姓名 / 学科 / 校区）
-- ----------------------------------------------------------------------------
-- 干什么（用户 2026-10 的原始需求，逐字）：
--   「我们能否在注册页面后加入填写信息模块，信息填写就需要填写姓名、科目、校区等
--     你认为必要的，然后未来我们首页这个部分就显示这几个主要信息，然后导出来的档案
--     文件什么的就可以从这里提取信息了，然后别忘了再加入一个修改信息的功能即可」
--
-- 为什么单开一张表（而不是塞进别处）：
--   · 它是**按账号**（一位老师一行）的，而 `feedback_students` 是**按学生**的 —— 两者维度不同；
--   · 它是「导出物的抬头/落款从哪来」的**唯一来源**：以前"郭庆杰"这类名字被写死在代码里
--     13 处（其中 4 处会直接印进导出的 Word）。
--
-- ⚠️ 读不到这张表（迁移没跑 / DB 抖动）时，代码一律走**兜底**：
--    落款用原来的默认值、导出照常 —— **不会因为资料没填就导出空白**。
--    后台/页面上会明确提示要跑哪个迁移（照功能开关表 0018 的先例）。
--
-- 字段：
--   teacher_name  老师姓名（如 郭庆杰）—— 用于落款、导出抬头、档案里的"任课教师"
--   subject       学科 code（math / chinese / …，与工具里的 SUBJECTS 同一套口径）
--   campus        机构校区（⚠️ 是**老师所在的机构校区**，与学生的"学校"不是一回事）
--   sig_teacher   用户手填过的落款（可空；空着就用"学科+姓名"自动拼）
--
-- 重复执行安全（create table if not exists + 幂等策略）。
-- ============================================================

create table if not exists public.user_profiles (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  teacher_name  text not null default '',
  subject       text not null default '',
  campus        text not null default '',
  sig_teacher   text not null default '',
  updated_at    timestamptz not null default now()
);

comment on table public.user_profiles is
  '教师个人资料（按账号一行）：姓名/学科/校区/落款。是"导出物抬头与落款"的唯一来源；读不到时应用走默认值兜底。';
comment on column public.user_profiles.campus is
  '机构校区（老师所在校区）。⚠️ 与 feedback_students.campus（学生就读的学校）不是一回事。';
comment on column public.user_profiles.subject is
  '学科 code，与工具里的 SUBJECTS 同一套：chinese/math/english/physics/chemistry/biology/politics/history/geography/general';

-- RLS：**只有本人**能读写自己那一行（连管理员也不给读别人的资料 —— 后台要显示姓名时
-- 走服务端的 key 白名单查询，不靠放宽这里的策略）。
alter table public.user_profiles enable row level security;

drop policy if exists "own profile readable" on public.user_profiles;
create policy "own profile readable"
  on public.user_profiles for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "own profile writable" on public.user_profiles;
create policy "own profile writable"
  on public.user_profiles for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "own profile updatable" on public.user_profiles;
create policy "own profile updatable"
  on public.user_profiles for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update on public.user_profiles to authenticated;

-- ============================================================
-- 自检（执行完可以跑这两条确认）
-- ============================================================

-- 1) 表建好了、四列都在
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'user_profiles'
order by ordinal_position;

-- 2) RLS 开着、三条策略都在
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'user_profiles'
order by policyname;
