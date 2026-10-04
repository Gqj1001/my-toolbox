-- ============================================================
-- 0007：新增「章」层 + 导入候选表
--
-- 目标层级：  册次(feedback_textbooks) → 章(feedback_sections) → 知识点(feedback_chapters)
--
-- 本迁移**不改动任何现有知识点/关键词数据**：
--   · 现有 272 个 feedback_chapters 行保持原样（其中人教A版 94 个是"未分章"的知识点）
--   · 新增的 section_id 允许为 NULL，表示"未分章"
--
-- 幂等，可重复执行。
-- ============================================================

-- ---------- 1. 章表 ----------
create table if not exists public.feedback_sections (
  id          bigint generated always as identity primary key,
  textbook_id bigint not null references public.feedback_textbooks (id) on delete cascade,
  name        text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (textbook_id, name)
);
create index if not exists feedback_sections_textbook_idx
  on public.feedback_sections (textbook_id, sort_order);

alter table public.feedback_sections enable row level security;

drop policy if exists "feedback_sections readable by authenticated" on public.feedback_sections;
create policy "feedback_sections readable by authenticated"
  on public.feedback_sections for select to authenticated using (true);

-- 写操作拆成三条：insert 只看 with check，update 两者都要，delete 只看 using
drop policy if exists "admins insert feedback_sections" on public.feedback_sections;
create policy "admins insert feedback_sections"
  on public.feedback_sections for insert to authenticated
  with check (public.is_admin());

drop policy if exists "admins update feedback_sections" on public.feedback_sections;
create policy "admins update feedback_sections"
  on public.feedback_sections for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins delete feedback_sections" on public.feedback_sections;
create policy "admins delete feedback_sections"
  on public.feedback_sections for delete to authenticated
  using (public.is_admin());

revoke all on public.feedback_sections from anon;
grant select, insert, update, delete on public.feedback_sections to authenticated;

drop trigger if exists feedback_sections_touch on public.feedback_sections;
create trigger feedback_sections_touch before update on public.feedback_sections
  for each row execute function public.touch_updated_at();

-- ---------- 2. 知识点挂到章 + 批次标记 ----------
-- section_id 可空：NULL = 未分章（兼容现有 272 行，尤其是人教A版的 94 个知识点）
alter table public.feedback_chapters
  add column if not exists section_id bigint references public.feedback_sections (id) on delete set null;
create index if not exists feedback_chapters_section_idx
  on public.feedback_chapters (section_id, sort_order);

-- import_batch_id：记录该行由哪一批导入产生，用于整批回滚
alter table public.feedback_chapters add column if not exists import_batch_id text;
alter table public.feedback_keywords add column if not exists import_batch_id text;
create index if not exists feedback_chapters_batch_idx on public.feedback_chapters (import_batch_id);
create index if not exists feedback_keywords_batch_idx on public.feedback_keywords (import_batch_id);

-- ---------- 3. 导入候选表 ----------
create table if not exists public.feedback_section_candidates (
  id           bigint generated always as identity primary key,
  batch_id     text not null,
  stage        text not null check (stage in ('senior','junior')),
  subject      text not null,
  version      text not null,
  book_name    text not null,
  section_name text not null,
  keywords     jsonb not null default '[]'::jsonb,
  source       text not null default 'ai',
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected')),
  note         text,
  reviewed_by  uuid references auth.users (id) on delete set null,
  reviewed_at  timestamptz,
  promoted_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists feedback_section_candidates_batch_idx
  on public.feedback_section_candidates (batch_id, status);
create index if not exists feedback_section_candidates_scope_idx
  on public.feedback_section_candidates (stage, subject, version, book_name);
create unique index if not exists feedback_section_candidates_uniq
  on public.feedback_section_candidates (batch_id, stage, subject, version, book_name, section_name);

alter table public.feedback_section_candidates enable row level security;

drop policy if exists "candidates readable by authenticated" on public.feedback_section_candidates;
create policy "candidates readable by authenticated"
  on public.feedback_section_candidates for select to authenticated using (true);

drop policy if exists "admins insert candidates" on public.feedback_section_candidates;
create policy "admins insert candidates"
  on public.feedback_section_candidates for insert to authenticated
  with check (public.is_admin());

drop policy if exists "admins update candidates" on public.feedback_section_candidates;
create policy "admins update candidates"
  on public.feedback_section_candidates for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins delete candidates" on public.feedback_section_candidates;
create policy "admins delete candidates"
  on public.feedback_section_candidates for delete to authenticated
  using (public.is_admin());

revoke all on public.feedback_section_candidates from anon;
grant select, insert, update, delete on public.feedback_section_candidates to authenticated;

-- ---------- 4. 自检 ----------
select 'feedback_sections 表' as 项目, to_regclass('public.feedback_sections')::text as 值
union all select '候选表', to_regclass('public.feedback_section_candidates')::text
union all select 'chapters.section_id 列', (select count(*)::text from information_schema.columns
        where table_name='feedback_chapters' and column_name='section_id')
union all select '现有章(应为0)', (select count(*)::text from public.feedback_sections)
union all select '现有知识点(应仍为272)', (select count(*)::text from public.feedback_chapters)
union all select '现有关键词(应仍为658)', (select count(*)::text from public.feedback_keywords);
