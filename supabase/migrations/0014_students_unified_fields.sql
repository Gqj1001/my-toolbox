-- ============================================================
-- 0014：把 feedback_students / feedback_history 扩成**全站统一学生档案**
--
-- 背景：三个工具各自存「学生」，形状不同、互不可见：
--   · feedback.html        → 已经在 feedback_students / feedback_history（Supabase）
--   · paper-analysis       → localStorage：paper_analysis_students_v1 / _history_v1
--                            （档案 8 个字段，历史里还带 score/full 分数）
--   · math-plan.html       → **什么都没有**，刷新即丢（纯新增，无历史要迁）
-- 用户要做「跨工具统一学生档案」首页，所以先把公共字段补齐。
--
-- 决策（用户已拍板，2026-10）：
--   ① 表结构用「公共列 + extra jsonb」—— 以后加工具**不改表结构**；
--   ② 迁移冲突按 updated_at 取新，**同一天服务器优先**（学生档案靠 updated_at，
--      它已经存在并且有 touch_updated_at() 触发器在维护）；
--   ③ 迁移必须**弹窗确认**，绝不静默上传（真实学生姓名，用户要知道自己在做什么）。
--
-- ⚠️ 本迁移只做 add column / create index，**不删列、不改列类型、不动任何策略**。
--    这是硬要求：feedback.html 读的就是这两张表的现有字段名，动一下它就静默坏掉
--    （红线 1）。所以下面**没有** drop / alter column / rename。
--
-- 字段归属（哪些进公共列、哪些进 extra）：
--   公共列 = 首页要展示 + 三个工具都可能有：姓名/年级/科目/老师/称呼/态度
--   extra  = 单个工具专属，首页不直接展示：
--            paper-analysis → gender, manager, cls
--            math-plan      → phase, book, exam, campus, score, target
--
-- 幂等：全部 add column if not exists / create index if not exists，可重复执行。
-- 在 Supabase Dashboard -> SQL Editor 中整段执行。
-- ============================================================


-- ============================================================
-- 1. 学生档案：补公共列
-- ============================================================
alter table public.feedback_students
  -- ---- 从 paper-analysis 档案学过来的公共字段 ----
  add column if not exists grade      text,          -- 年级：高三 / 新高二 / 初二 …
  add column if not exists gender     text,          -- 男 / 女
  add column if not exists campus     text,          -- 校区（math-plan 有，paper 没有）
  add column if not exists manager    text,          -- 学管师
  add column if not exists class_name text,          -- 班级（用 class_name 而不是 class：class 在 SQL 里是保留意味很强的词）
  add column if not exists attitude   text;          -- 学习态度 / 学习特点（长文本）

-- 工具专属字段：单独一条，方便加注释
alter table public.feedback_students
  add column if not exists extra jsonb not null default '{}'::jsonb;

comment on column public.feedback_students.extra is
  '工具专属字段（首页不直接展示）。约定：paper→gender/manager/cls；math-plan→phase/book/exam/campus/score/target。加工具时**不需要**改表结构。';

-- 约束：extra 必须是 JSON **对象**（不能是数组/标量），否则 extra->>'' 会报错。
-- 用 DO 块是因为 add constraint 没有 if not exists，重复执行要幂等。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'feedback_students_extra_is_object'
       and conrelid = 'public.feedback_students'::regclass
  ) then
    alter table public.feedback_students
      add constraint feedback_students_extra_is_object
      check (jsonb_typeof(extra) = 'object');
  end if;
end $$;


-- ============================================================
-- 2. 反馈历史 → 全站「学生记录」：补跨工具字段
-- ============================================================
alter table public.feedback_history
  -- 哪个工具写的。默认 'feedback' 让**现有行自动归位**，不需要回填。
  add column if not exists tool text not null default 'feedback',
  -- paper-analysis 的 examName（考试名）落在这里；feedback 的 type_name 保持不动
  add column if not exists title      text,
  -- paper-analysis 历史里的得分 / 满分（feedback 没有这两个，所以可空）
  add column if not exists score      numeric,
  add column if not exists full_score numeric;

comment on column public.feedback_history.tool is
  '归属工具：feedback / paper / math-plan…。默认 feedback 已让历史数据自动归位。';

-- 自检用：只允许已登记的工具名（防止前端拼错字导致数据分不到一起）。
-- 现在只放开 feedback / paper；math-plan 暂时不写历史，将来要加再改这条约束。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'feedback_history_tool_check'
       and conrelid = 'public.feedback_history'::regclass
  ) then
    alter table public.feedback_history
      add constraint feedback_history_tool_check
      check (tool in ('feedback', 'paper'));
  end if;
end $$;


-- ============================================================
-- 3. 索引
-- ============================================================
-- 统一档案首页：按学生名查某人的全部记录（跨工具、按时间倒序）
create index if not exists feedback_history_user_student_idx
  on public.feedback_history (user_id, student_name, created_at desc);

-- 按工具筛选（首页可能要「只看试卷分析」）
create index if not exists feedback_history_tool_idx
  on public.feedback_history (user_id, tool, created_at desc);


-- ============================================================
-- 4. 明确提醒：**不需要**动 RLS / 权限
-- ============================================================
-- 新增的列自动被**已有策略**覆盖（RLS 是行级、grant 是表级，都不区分列），
-- 所以下面这些**故意不写**（写了反而增加出错面）：
--   · 不重新 create policy —— 重建会把 qual 写歪的风险带进来；
--   · 不重新 grant —— 表级授权已经覆盖新列。
-- 验证方式是**行为验证**：用两个测试账号交叉确认互相看不到对方的档案
--（tests/step7-api.test.mjs 已有这类断言；阶段 1 收尾会再跑一遍）。


-- ============================================================
-- 5. 自检（执行后把结果贴回来核对）
-- ============================================================

-- 5.1 列是不是都加上了：期望 9 行（students 7 个新列 + history 4 个新列）
select 'students.' || column_name as 新列, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'feedback_students'
  and column_name in ('grade','gender','campus','manager','class_name','attitude','extra')
union all
select 'history.' || column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'feedback_history'
  and column_name in ('tool','title','score','full_score')
order by 1;

-- 5.2 现有数据的归属：tool 应全部是 'feedback'（不会被漏掉）
select tool, count(*) as 条数
from public.feedback_history
group by tool
order by tool;

-- 5.3 行数没变、没丢数据（执行前后应一致）
select
  (select count(*) from public.feedback_students) as 学生档案行数,
  (select count(*) from public.feedback_history)  as 历史行数;

-- 5.4 约束就位
select conname as 约束名, pg_get_constraintdef(oid) as 定义
from pg_constraint
where conrelid in ('public.feedback_students'::regclass, 'public.feedback_history'::regclass)
  and conname in ('feedback_students_extra_is_object', 'feedback_history_tool_check');
