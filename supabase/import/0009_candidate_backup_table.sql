-- ============================================================
-- 候选表备份表（CSV 写回前打快照用）——只需执行一次
--
-- 用途：csv-apply-updates.mjs --apply 时，会先把受影响行的**原始状态**
--       写进本表（带 backup_tag），需要恢复时一条 SQL 即可还原。
--       脚本同时还会在本地写一份 JSON 快照，双保险。
--
-- RLS 说明（重要）：
--   读策略对所有登录用户开放（与其他 feedback_* 表一致），
--   写策略仅 admin。之所以不写成单条 `for all using(is_admin())`：
--   PostgREST 的 insert 带 returning 时需要 SELECT 权限，
--   单条 for all 策略在缺少读权限时会导致 insert 被静默拒绝。
-- ============================================================

create table if not exists public.feedback_section_candidates_backup (
  backup_id     bigint generated always as identity primary key,
  backup_tag    text not null,              -- 每次备份一个标签，恢复时按它筛选
  candidate_id  bigint not null,            -- 对应 feedback_section_candidates.id
  batch_id      text,
  stage         text,
  subject       text,
  version       text,
  book_name     text,
  section_name  text,
  keywords      jsonb,
  status        text,
  note          text,
  reviewed_by   uuid,
  reviewed_at   timestamptz,
  promoted_at   timestamptz,
  backed_up_at  timestamptz not null default now()
);

create index if not exists feedback_section_candidates_backup_tag_idx
  on public.feedback_section_candidates_backup (backup_tag);
create index if not exists feedback_section_candidates_backup_cand_idx
  on public.feedback_section_candidates_backup (candidate_id);

alter table public.feedback_section_candidates_backup enable row level security;

-- 读：所有登录用户
drop policy if exists "candidate backups readable by authenticated" on public.feedback_section_candidates_backup;
create policy "candidate backups readable by authenticated"
  on public.feedback_section_candidates_backup for select to authenticated using (true);

-- 写：仅 admin（拆成三条，insert 看 with check，update 两者都要，delete 只看 using）
drop policy if exists "admins insert candidate backups" on public.feedback_section_candidates_backup;
create policy "admins insert candidate backups"
  on public.feedback_section_candidates_backup for insert to authenticated
  with check (public.is_admin());

drop policy if exists "admins update candidate backups" on public.feedback_section_candidates_backup;
create policy "admins update candidate backups"
  on public.feedback_section_candidates_backup for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admins delete candidate backups" on public.feedback_section_candidates_backup;
create policy "admins delete candidate backups"
  on public.feedback_section_candidates_backup for delete to authenticated
  using (public.is_admin());

-- 清理旧版单条 for all 策略（若之前建过）
drop policy if exists "admins manage candidate backups" on public.feedback_section_candidates_backup;

revoke all on public.feedback_section_candidates_backup from anon;
grant select, insert, update, delete on public.feedback_section_candidates_backup to authenticated;

-- ---------- 自检 ----------
select '备份表' as 项目, to_regclass('public.feedback_section_candidates_backup')::text as 值
union all select '策略数', (select count(*)::text from pg_policies
        where tablename = 'feedback_section_candidates_backup')
union all select '现有备份行(应为0)', (select count(*)::text from public.feedback_section_candidates_backup);
