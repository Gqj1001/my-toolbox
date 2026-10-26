-- ============================================================
-- 0032 修正：Owner 的个人档案直读仍只看自己
-- ----------------------------------------------------------------------------
-- 0031 的 `can_read_student()` 把 `is_owner()` 也算进“可读”，导致：
--   · Owner 直接 `from("feedback_students")` 能读到所有老师的学生；
--   · `/api/students` 的合并逻辑按**姓名**装配，同名学生会被后读到的行覆盖；
--   · 全量回归 `students-unified` 出现“Owner 的 A 被老师的同名 B 覆盖”。
--
-- 正确边界：
--   · Owner 的**全量**档案/大盘只走 SECURITY DEFINER 的 `admin_*` RPC；
--   · Owner 的个人 `/api/students`、档案页仍只读/写**自己创建的**学生；
--   · 大区/校区管理员通过 RLS 读范围内的学生（页面/RPC）。
--
-- 本文件只替换 `can_read_student()` 和 `students read by scope` 策略；
-- 不改表、不改数据；`admin_list_all_students` / `admin_archive_stats` 内部仍显式用 is_owner()，所以 Owner 的大盘不受影响。
-- ============================================================

create or replace function public.can_read_student(
  p_owner_id uuid,
  p_region_id uuid,
  p_campus_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_owner_id = (select auth.uid())
    -- ⚠️ 故意**不包含** is_owner()：
    --    Owner 的全量读取只走 admin RPC；个人 /api/students 仍按本人隔离。
    or public.is_region_admin(p_region_id)
    or public.is_campus_admin(p_campus_id);
$$;

grant execute on function public.can_read_student(uuid, uuid, uuid) to authenticated;

drop policy if exists "students read by scope" on public.feedback_students;
create policy "students read by scope"
  on public.feedback_students for select to authenticated
  using (public.can_read_student(user_id, region_id, campus_id));

-- 自检（执行后）：Owner 直接查 feedback_students 只应看到自己的；
-- 全量请用 admin_list_all_students()。
-- select count(*) from public.feedback_students;
