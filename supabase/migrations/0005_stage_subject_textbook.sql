-- ============================================================
-- 第 7 步：扩展支持 学段 × 科目 × 教材 × 章节
-- 在 Supabase SQL Editor 整段执行（幂等，可重复执行）
-- 前置：0004_feedback_tables.sql 已执行
--
-- 内容：
--   1. 新增 feedback_categories（8 个通用分类，stage 留空 = 全学段通用）
--   2. 新增 feedback_textbooks / feedback_chapters
--   3. feedback_keywords 加 stage / textbook_id / chapter_id / chapter_name
--   4. 现有 470 条统一补 stage='senior'（一条不删，除下面第 6 节的 24 条重名）
--   5. 教材/章节种子（41 本 / 272 章）
--   6. 删除与章节知识点重名的旧词（先查后删，精确匹配）
--   7. 数学高中人教A版 6 册 94 章 → 188 条章节关键词
-- ============================================================

-- ---------- 1. 通用分类表（框架入库，不硬编码）----------
create table if not exists public.feedback_categories (
  id         bigint generated always as identity primary key,
  name       text not null,
  sort_order integer not null default 0,
  stage      text check (stage is null or stage in ('senior','junior')),
  subject    text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.feedback_categories enable row level security;

drop policy if exists "feedback_categories readable by authenticated" on public.feedback_categories;
create policy "feedback_categories readable by authenticated"
  on public.feedback_categories for select to authenticated using (true);

drop policy if exists "admins write feedback_categories" on public.feedback_categories;
create policy "admins write feedback_categories"
  on public.feedback_categories for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.feedback_categories from anon;
grant select, insert, update, delete on public.feedback_categories to authenticated;

drop trigger if exists feedback_categories_touch on public.feedback_categories;
create trigger feedback_categories_touch before update on public.feedback_categories
  for each row execute function public.touch_updated_at();

-- 初始 8 个分类：stage 留空（全学段通用），uniqueness 用表达式索引
create unique index if not exists feedback_categories_uniq
  on public.feedback_categories (coalesce(stage,''), coalesce(subject,''), name);

insert into public.feedback_categories (name, sort_order, stage, subject)
select v.name, v.sort_order, null, null
from (values
  ('课堂内容', 10),
  ('课堂表现（正面）', 20),
  ('课堂表现（需改进）', 30),
  ('知识掌握评价', 40),
  ('改进建议', 50),
  ('分层建议', 60),
  ('作业布置', 70),
  ('下节课内容', 80)
) as v(name, sort_order)
where not exists (
  select 1 from public.feedback_categories c
  where c.name = v.name and c.stage is null and c.subject is null
);

-- ---------- 2. 教材表 / 章节表 ----------
create table if not exists public.feedback_textbooks (
  id         bigint generated always as identity primary key,
  stage      text not null check (stage in ('senior','junior')),
  subject    text not null,
  version    text not null default '-',
  name       text not null default '-',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stage, subject, version, name)
);

create table if not exists public.feedback_chapters (
  id          bigint generated always as identity primary key,
  textbook_id bigint not null references public.feedback_textbooks (id) on delete cascade,
  name        text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (textbook_id, name)
);
create index if not exists feedback_chapters_textbook_idx on public.feedback_chapters (textbook_id, sort_order);

alter table public.feedback_textbooks enable row level security;
alter table public.feedback_chapters  enable row level security;

-- select：所有登录用户可读
drop policy if exists "feedback_textbooks readable by authenticated" on public.feedback_textbooks;
create policy "feedback_textbooks readable by authenticated"
  on public.feedback_textbooks for select to authenticated using (true);
drop policy if exists "feedback_chapters readable by authenticated" on public.feedback_chapters;
create policy "feedback_chapters readable by authenticated"
  on public.feedback_chapters for select to authenticated using (true);

-- insert：仅 admin
drop policy if exists "admins insert feedback_textbooks" on public.feedback_textbooks;
create policy "admins insert feedback_textbooks"
  on public.feedback_textbooks for insert to authenticated
  with check (public.is_admin());
drop policy if exists "admins insert feedback_chapters" on public.feedback_chapters;
create policy "admins insert feedback_chapters"
  on public.feedback_chapters for insert to authenticated
  with check (public.is_admin());

-- update：仅 admin（using 与 with check 都限制，避免把行改成非管理员可见状态）
drop policy if exists "admins update feedback_textbooks" on public.feedback_textbooks;
create policy "admins update feedback_textbooks"
  on public.feedback_textbooks for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins update feedback_chapters" on public.feedback_chapters;
create policy "admins update feedback_chapters"
  on public.feedback_chapters for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- delete：仅 admin
drop policy if exists "admins delete feedback_textbooks" on public.feedback_textbooks;
create policy "admins delete feedback_textbooks"
  on public.feedback_textbooks for delete to authenticated
  using (public.is_admin());
drop policy if exists "admins delete feedback_chapters" on public.feedback_chapters;
create policy "admins delete feedback_chapters"
  on public.feedback_chapters for delete to authenticated
  using (public.is_admin());

-- 清理旧的合并式策略（0005 早期版本可能已创建）
drop policy if exists "admins write feedback_textbooks" on public.feedback_textbooks;
drop policy if exists "admins write feedback_chapters"  on public.feedback_chapters;

revoke all on public.feedback_textbooks from anon;
revoke all on public.feedback_chapters  from anon;
grant select, insert, update, delete on public.feedback_textbooks to authenticated;
grant select, insert, update, delete on public.feedback_chapters  to authenticated;

drop trigger if exists feedback_textbooks_touch on public.feedback_textbooks;
create trigger feedback_textbooks_touch before update on public.feedback_textbooks
  for each row execute function public.touch_updated_at();
drop trigger if exists feedback_chapters_touch on public.feedback_chapters;
create trigger feedback_chapters_touch before update on public.feedback_chapters
  for each row execute function public.touch_updated_at();

-- ---------- 3. feedback_keywords 加归类列 ----------
alter table public.feedback_keywords add column if not exists stage        text;
alter table public.feedback_keywords add column if not exists textbook_id  bigint references public.feedback_textbooks (id) on delete set null;
alter table public.feedback_keywords add column if not exists chapter_id   bigint references public.feedback_chapters (id) on delete set null;
alter table public.feedback_keywords add column if not exists chapter_name text;
-- 软删除标记：被归档的关键词不参与渲染，但数据仍在、可恢复
alter table public.feedback_keywords add column if not exists archived_at  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'feedback_keywords_stage_check') then
    alter table public.feedback_keywords
      add constraint feedback_keywords_stage_check check (stage is null or stage in ('senior','junior'));
  end if;
end $$;

create index if not exists feedback_keywords_scope_idx
  on public.feedback_keywords (subject, category, stage, textbook_id, chapter_id, sort_order);
create index if not exists feedback_keywords_archived_idx
  on public.feedback_keywords (archived_at);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'feedback_keywords_scope_uniq') then
    alter table public.feedback_keywords
      add constraint feedback_keywords_scope_uniq unique nulls not distinct
        (subject, category, stage, textbook_id, chapter_id, keyword);
  end if;
end $$;

-- ---------- 4. 现有数据补 stage（一条不删）----------
update public.feedback_keywords set stage = 'senior' where stage is null;

-- ---------- 5. 教材与章节种子 ----------
-- version = 版本（人教A版/人教版/统编版…）；name = 册次（'-' 表示无册次之分）
insert into public.feedback_textbooks (stage, subject, version, name, sort_order)
select v.stage, v.subject, v.version, v.name, v.sort_order
from (values
  ('senior', 'math', '人教A版', '必修第一册', 10),
  ('senior', 'math', '人教A版', '必修第二册', 20),
  ('senior', 'math', '人教A版', '选择性必修第一册', 30),
  ('senior', 'math', '人教A版', '选择性必修第二册', 40),
  ('senior', 'math', '人教A版', '选择性必修第三册', 50),
  ('senior', 'math', '人教A版', '高考专题与真题', 60),
  ('senior', 'math', '人教B版', '-', 20),
  ('senior', 'math', '北师大版', '-', 30),
  ('senior', 'math', '苏教版', '-', 40),
  ('senior', 'math', '湘教版', '-', 50),
  ('junior', 'math', '人教版', '-', 10),
  ('junior', 'math', '北师大版', '-', 20),
  ('junior', 'math', '苏科版', '-', 30),
  ('senior', 'chinese', '统编版', '-', 10),
  ('junior', 'chinese', '统编版', '-', 10),
  ('senior', 'english', '人教版', '-', 10),
  ('senior', 'english', '外研版', '-', 20),
  ('senior', 'english', '译林版', '-', 30),
  ('junior', 'english', '人教版', '-', 10),
  ('junior', 'english', '外研版', '-', 20),
  ('junior', 'english', '译林版', '-', 30),
  ('senior', 'physics', '人教版', '-', 10),
  ('senior', 'physics', '教科版', '-', 20),
  ('junior', 'physics', '人教版', '-', 10),
  ('junior', 'physics', '教科版', '-', 20),
  ('senior', 'chemistry', '人教版', '-', 10),
  ('senior', 'chemistry', '苏科版', '-', 20),
  ('senior', 'chemistry', '鲁科版', '-', 30),
  ('junior', 'chemistry', '人教版', '-', 10),
  ('junior', 'chemistry', '鲁科版', '-', 20),
  ('senior', 'biology', '人教版', '-', 10),
  ('senior', 'biology', '苏教版', '-', 20),
  ('junior', 'biology', '人教版', '-', 10),
  ('junior', 'biology', '苏教版', '-', 20),
  ('senior', 'politics', '统编版', '-', 10),
  ('senior', 'history', '统编版', '-', 10),
  ('junior', 'history', '统编版', '-', 10),
  ('senior', 'geography', '人教版', '-', 10),
  ('senior', 'geography', '湘教版', '-', 20),
  ('junior', 'geography', '人教版', '-', 10),
  ('junior', 'geography', '湘教版', '-', 20)
) as v(stage, subject, version, name, sort_order)
where not exists (
  select 1 from public.feedback_textbooks t
  where t.stage = v.stage and t.subject = v.subject
    and t.version = v.version and t.name = v.name
);

insert into public.feedback_chapters (textbook_id, name, sort_order)
select t.id, v.chapter, v.sort_order
from (values
  ('senior', 'math', '人教A版', '必修第一册', '集合的概念与关系', 10),
  ('senior', 'math', '人教A版', '必修第一册', '集合的基本运算', 20),
  ('senior', 'math', '人教A版', '必修第一册', '充分条件与必要条件', 30),
  ('senior', 'math', '人教A版', '必修第一册', '全称量词与存在量词', 40),
  ('senior', 'math', '人教A版', '必修第一册', '等式与不等式性质', 50),
  ('senior', 'math', '人教A版', '必修第一册', '基本不等式', 60),
  ('senior', 'math', '人教A版', '必修第一册', '二次函数与方程、不等式', 70),
  ('senior', 'math', '人教A版', '必修第一册', '函数概念与表示', 80),
  ('senior', 'math', '人教A版', '必修第一册', '函数的单调性、奇偶性、周期性', 90),
  ('senior', 'math', '人教A版', '必修第一册', '幂函数', 100),
  ('senior', 'math', '人教A版', '必修第一册', '函数的应用（一）', 110),
  ('senior', 'math', '人教A版', '必修第一册', '指数与对数运算', 120),
  ('senior', 'math', '人教A版', '必修第一册', '指数函数', 130),
  ('senior', 'math', '人教A版', '必修第一册', '对数函数', 140),
  ('senior', 'math', '人教A版', '必修第一册', '函数的应用（二）', 150),
  ('senior', 'math', '人教A版', '必修第一册', '任意角与弧度制', 160),
  ('senior', 'math', '人教A版', '必修第一册', '三角函数概念', 170),
  ('senior', 'math', '人教A版', '必修第一册', '诱导公式', 180),
  ('senior', 'math', '人教A版', '必修第一册', '三角函数图像与性质', 190),
  ('senior', 'math', '人教A版', '必修第一册', '三角恒等变换', 200),
  ('senior', 'math', '人教A版', '必修第一册', '函数 y=Asin(ωx+φ) 模型及其应用', 210),
  ('senior', 'math', '人教A版', '必修第二册', '平面向量的概念及运算', 10),
  ('senior', 'math', '人教A版', '必修第二册', '平面向量基本定理与坐标表示', 20),
  ('senior', 'math', '人教A版', '必修第二册', '平面向量的应用', 30),
  ('senior', 'math', '人教A版', '必修第二册', '正弦定理、余弦定理', 40),
  ('senior', 'math', '人教A版', '必修第二册', '解三角形常见题型-极值最值', 50),
  ('senior', 'math', '人教A版', '必修第二册', '解三角形常见题型-角平分线与中线', 60),
  ('senior', 'math', '人教A版', '必修第二册', '复数概念', 70),
  ('senior', 'math', '人教A版', '必修第二册', '复数四则运算', 80),
  ('senior', 'math', '人教A版', '必修第二册', '基本立体图形及其直观图', 90),
  ('senior', 'math', '人教A版', '必修第二册', '斜二测画法', 100),
  ('senior', 'math', '人教A版', '必修第二册', '空间几何体的表面积、体积', 110),
  ('senior', 'math', '人教A版', '必修第二册', '空间点、线、面之间的位置关系', 120),
  ('senior', 'math', '人教A版', '必修第二册', '线面平行与垂直判定', 130),
  ('senior', 'math', '人教A版', '必修第二册', '面面平行与垂直判定', 140),
  ('senior', 'math', '人教A版', '必修第二册', '随机抽样', 150),
  ('senior', 'math', '人教A版', '必修第二册', '用样本估计总体', 160),
  ('senior', 'math', '人教A版', '必修第二册', '随机事件与概率', 170),
  ('senior', 'math', '人教A版', '必修第二册', '事件独立性', 180),
  ('senior', 'math', '人教A版', '必修第二册', '频率与概率', 190),
  ('senior', 'math', '人教A版', '选择性必修第一册', '空间向量运算', 10),
  ('senior', 'math', '人教A版', '选择性必修第一册', '空间向量及其运算的坐标表示', 20),
  ('senior', 'math', '人教A版', '选择性必修第一册', '空间向量的应用', 30),
  ('senior', 'math', '人教A版', '选择性必修第一册', '直线的方程', 40),
  ('senior', 'math', '人教A版', '选择性必修第一册', '圆的方程', 50),
  ('senior', 'math', '人教A版', '选择性必修第一册', '直线与圆的位置关系', 60),
  ('senior', 'math', '人教A版', '选择性必修第一册', '椭圆', 70),
  ('senior', 'math', '人教A版', '选择性必修第一册', '双曲线', 80),
  ('senior', 'math', '人教A版', '选择性必修第一册', '抛物线', 90),
  ('senior', 'math', '人教A版', '选择性必修第一册', '直线与圆锥曲线的综合应用', 100),
  ('senior', 'math', '人教A版', '选择性必修第一册', '圆锥曲线定点定值', 110),
  ('senior', 'math', '人教A版', '选择性必修第一册', '圆锥曲线范围最值', 120),
  ('senior', 'math', '人教A版', '选择性必修第二册', '数列的概念与简单表示', 10),
  ('senior', 'math', '人教A版', '选择性必修第二册', '等差数列及其前n项和', 20),
  ('senior', 'math', '人教A版', '选择性必修第二册', '等比数列及其前n项和', 30),
  ('senior', 'math', '人教A版', '选择性必修第二册', '数列求和', 40),
  ('senior', 'math', '人教A版', '选择性必修第二册', '裂项相消', 50),
  ('senior', 'math', '人教A版', '选择性必修第二册', '错位相减', 60),
  ('senior', 'math', '人教A版', '选择性必修第二册', '数列与不等式综合', 70),
  ('senior', 'math', '人教A版', '选择性必修第二册', '导数概念与几何意义', 80),
  ('senior', 'math', '人教A版', '选择性必修第二册', '导数运算', 90),
  ('senior', 'math', '人教A版', '选择性必修第二册', '导数的应用——函数的单调性', 100),
  ('senior', 'math', '人教A版', '选择性必修第二册', '导数的应用——函数的极值', 110),
  ('senior', 'math', '人教A版', '选择性必修第二册', '导数的应用——函数的最值', 120),
  ('senior', 'math', '人教A版', '选择性必修第二册', '导数恒成立问题', 130),
  ('senior', 'math', '人教A版', '选择性必修第二册', '导数零点问题', 140),
  ('senior', 'math', '人教A版', '选择性必修第二册', '导数隐零点与极值点偏移', 150),
  ('senior', 'math', '人教A版', '选择性必修第三册', '分类加法与分步乘法计数原理', 10),
  ('senior', 'math', '人教A版', '选择性必修第三册', '排列与组合', 20),
  ('senior', 'math', '人教A版', '选择性必修第三册', '二项式定理', 30),
  ('senior', 'math', '人教A版', '选择性必修第三册', '条件概率与全概率公式', 40),
  ('senior', 'math', '人教A版', '选择性必修第三册', '离散型随机变量', 50),
  ('senior', 'math', '人教A版', '选择性必修第三册', '二项分布', 60),
  ('senior', 'math', '人教A版', '选择性必修第三册', '超几何分布', 70),
  ('senior', 'math', '人教A版', '选择性必修第三册', '正态分布', 80),
  ('senior', 'math', '人教A版', '选择性必修第三册', '相关关系', 90),
  ('senior', 'math', '人教A版', '选择性必修第三册', '回归分析', 100),
  ('senior', 'math', '人教A版', '选择性必修第三册', '独立性检验', 110),
  ('senior', 'math', '人教A版', '高考专题与真题', '近五年高考真题精讲', 10),
  ('senior', 'math', '人教A版', '高考专题与真题', '历年高考卷选择题', 20),
  ('senior', 'math', '人教A版', '高考专题与真题', '历年高考卷大题', 30),
  ('senior', 'math', '人教A版', '高考专题与真题', '周测卷讲解', 40),
  ('senior', 'math', '人教A版', '高考专题与真题', '月考试题讲解分析', 50),
  ('senior', 'math', '人教A版', '高考专题与真题', '一模试卷讲解', 60),
  ('senior', 'math', '人教A版', '高考专题与真题', '二模试卷讲解', 70),
  ('senior', 'math', '人教A版', '高考专题与真题', '省市级模拟卷精讲', 80),
  ('senior', 'math', '人教A版', '高考专题与真题', '选填压轴题专项', 90),
  ('senior', 'math', '人教A版', '高考专题与真题', '多选题专项', 100),
  ('senior', 'math', '人教A版', '高考专题与真题', '解答题规范书写', 110),
  ('senior', 'math', '人教A版', '高考专题与真题', '答题时间分配与取舍', 120),
  ('senior', 'math', '人教A版', '高考专题与真题', '极化恒等式', 130),
  ('senior', 'math', '人教A版', '高考专题与真题', '等和线', 140),
  ('senior', 'math', '人教A版', '高考专题与真题', '外接球与内切球', 150),
  ('senior', 'math', '人教A版', '高考专题与真题', '错题总结与重做', 160),
  ('senior', 'math', '人教B版', '-', '必修第一册', 10),
  ('senior', 'math', '人教B版', '-', '必修第二册', 20),
  ('senior', 'math', '人教B版', '-', '必修第三册', 30),
  ('senior', 'math', '人教B版', '-', '必修第四册', 40),
  ('senior', 'math', '人教B版', '-', '选择性必修第一册', 50),
  ('senior', 'math', '人教B版', '-', '选择性必修第二册', 60),
  ('senior', 'math', '人教B版', '-', '选择性必修第三册', 70),
  ('senior', 'math', '北师大版', '-', '必修第一册', 10),
  ('senior', 'math', '北师大版', '-', '必修第二册', 20),
  ('senior', 'math', '北师大版', '-', '选择性必修第一册', 30),
  ('senior', 'math', '北师大版', '-', '选择性必修第二册', 40),
  ('senior', 'math', '苏教版', '-', '必修第一册', 10),
  ('senior', 'math', '苏教版', '-', '必修第二册', 20),
  ('senior', 'math', '苏教版', '-', '选择性必修第一册', 30),
  ('senior', 'math', '苏教版', '-', '选择性必修第二册', 40),
  ('senior', 'math', '湘教版', '-', '必修第一册', 10),
  ('senior', 'math', '湘教版', '-', '必修第二册', 20),
  ('senior', 'math', '湘教版', '-', '选择性必修第一册', 30),
  ('senior', 'math', '湘教版', '-', '选择性必修第二册', 40),
  ('junior', 'math', '人教版', '-', '七年级上册', 10),
  ('junior', 'math', '人教版', '-', '七年级下册', 20),
  ('junior', 'math', '人教版', '-', '八年级上册', 30),
  ('junior', 'math', '人教版', '-', '八年级下册', 40),
  ('junior', 'math', '人教版', '-', '九年级上册', 50),
  ('junior', 'math', '人教版', '-', '九年级下册', 60),
  ('junior', 'math', '北师大版', '-', '七年级上册', 10),
  ('junior', 'math', '北师大版', '-', '七年级下册', 20),
  ('junior', 'math', '北师大版', '-', '八年级上册', 30),
  ('junior', 'math', '北师大版', '-', '八年级下册', 40),
  ('junior', 'math', '北师大版', '-', '九年级上册', 50),
  ('junior', 'math', '北师大版', '-', '九年级下册', 60),
  ('junior', 'math', '苏科版', '-', '七年级上册', 10),
  ('junior', 'math', '苏科版', '-', '七年级下册', 20),
  ('junior', 'math', '苏科版', '-', '八年级上册', 30),
  ('junior', 'math', '苏科版', '-', '八年级下册', 40),
  ('junior', 'math', '苏科版', '-', '九年级上册', 50),
  ('junior', 'math', '苏科版', '-', '九年级下册', 60),
  ('senior', 'chinese', '统编版', '-', '必修上册', 10),
  ('senior', 'chinese', '统编版', '-', '必修下册', 20),
  ('senior', 'chinese', '统编版', '-', '选择性必修上册', 30),
  ('senior', 'chinese', '统编版', '-', '选择性必修中册', 40),
  ('senior', 'chinese', '统编版', '-', '选择性必修下册', 50),
  ('junior', 'chinese', '统编版', '-', '七年级上册', 10),
  ('junior', 'chinese', '统编版', '-', '七年级下册', 20),
  ('junior', 'chinese', '统编版', '-', '八年级上册', 30),
  ('junior', 'chinese', '统编版', '-', '八年级下册', 40),
  ('junior', 'chinese', '统编版', '-', '九年级上册', 50),
  ('junior', 'chinese', '统编版', '-', '九年级下册', 60),
  ('senior', 'english', '人教版', '-', '必修一', 10),
  ('senior', 'english', '人教版', '-', '必修二', 20),
  ('senior', 'english', '人教版', '-', '必修三', 30),
  ('senior', 'english', '人教版', '-', '选择性必修一', 40),
  ('senior', 'english', '人教版', '-', '选择性必修二', 50),
  ('senior', 'english', '人教版', '-', '选择性必修三', 60),
  ('senior', 'english', '人教版', '-', '选择性必修四', 70),
  ('senior', 'english', '外研版', '-', '必修一', 10),
  ('senior', 'english', '外研版', '-', '必修二', 20),
  ('senior', 'english', '外研版', '-', '必修三', 30),
  ('senior', 'english', '外研版', '-', '选择性必修一', 40),
  ('senior', 'english', '外研版', '-', '选择性必修二', 50),
  ('senior', 'english', '外研版', '-', '选择性必修三', 60),
  ('senior', 'english', '外研版', '-', '选择性必修四', 70),
  ('senior', 'english', '译林版', '-', '必修一', 10),
  ('senior', 'english', '译林版', '-', '必修二', 20),
  ('senior', 'english', '译林版', '-', '必修三', 30),
  ('senior', 'english', '译林版', '-', '选择性必修一', 40),
  ('senior', 'english', '译林版', '-', '选择性必修二', 50),
  ('senior', 'english', '译林版', '-', '选择性必修三', 60),
  ('senior', 'english', '译林版', '-', '选择性必修四', 70),
  ('junior', 'english', '人教版', '-', '七年级上册', 10),
  ('junior', 'english', '人教版', '-', '七年级下册', 20),
  ('junior', 'english', '人教版', '-', '八年级上册', 30),
  ('junior', 'english', '人教版', '-', '八年级下册', 40),
  ('junior', 'english', '人教版', '-', '九年级全一册', 50),
  ('junior', 'english', '外研版', '-', '七年级上册', 10),
  ('junior', 'english', '外研版', '-', '七年级下册', 20),
  ('junior', 'english', '外研版', '-', '八年级上册', 30),
  ('junior', 'english', '外研版', '-', '八年级下册', 40),
  ('junior', 'english', '外研版', '-', '九年级上册', 50),
  ('junior', 'english', '外研版', '-', '九年级下册', 60),
  ('junior', 'english', '译林版', '-', '七年级上册', 10),
  ('junior', 'english', '译林版', '-', '七年级下册', 20),
  ('junior', 'english', '译林版', '-', '八年级上册', 30),
  ('junior', 'english', '译林版', '-', '八年级下册', 40),
  ('junior', 'english', '译林版', '-', '九年级上册', 50),
  ('junior', 'english', '译林版', '-', '九年级下册', 60),
  ('senior', 'physics', '人教版', '-', '必修第一册', 10),
  ('senior', 'physics', '人教版', '-', '必修第二册', 20),
  ('senior', 'physics', '人教版', '-', '必修第三册', 30),
  ('senior', 'physics', '人教版', '-', '选择性必修第一册', 40),
  ('senior', 'physics', '人教版', '-', '选择性必修第二册', 50),
  ('senior', 'physics', '人教版', '-', '选择性必修第三册', 60),
  ('senior', 'physics', '教科版', '-', '必修第一册', 10),
  ('senior', 'physics', '教科版', '-', '必修第二册', 20),
  ('senior', 'physics', '教科版', '-', '必修第三册', 30),
  ('senior', 'physics', '教科版', '-', '选择性必修第一册', 40),
  ('senior', 'physics', '教科版', '-', '选择性必修第二册', 50),
  ('senior', 'physics', '教科版', '-', '选择性必修第三册', 60),
  ('junior', 'physics', '人教版', '-', '八年级上册', 10),
  ('junior', 'physics', '人教版', '-', '八年级下册', 20),
  ('junior', 'physics', '人教版', '-', '九年级全一册', 30),
  ('junior', 'physics', '教科版', '-', '八年级上册', 10),
  ('junior', 'physics', '教科版', '-', '八年级下册', 20),
  ('junior', 'physics', '教科版', '-', '九年级上册', 30),
  ('junior', 'physics', '教科版', '-', '九年级下册', 40),
  ('senior', 'chemistry', '人教版', '-', '必修第一册', 10),
  ('senior', 'chemistry', '人教版', '-', '必修第二册', 20),
  ('senior', 'chemistry', '人教版', '-', '选择性必修1 化学反应原理', 30),
  ('senior', 'chemistry', '人教版', '-', '选择性必修2 物质结构与性质', 40),
  ('senior', 'chemistry', '人教版', '-', '选择性必修3 有机化学基础', 50),
  ('senior', 'chemistry', '苏科版', '-', '必修第一册', 10),
  ('senior', 'chemistry', '苏科版', '-', '必修第二册', 20),
  ('senior', 'chemistry', '苏科版', '-', '选择性必修1 化学反应原理', 30),
  ('senior', 'chemistry', '苏科版', '-', '选择性必修2 物质结构与性质', 40),
  ('senior', 'chemistry', '苏科版', '-', '选择性必修3 有机化学基础', 50),
  ('senior', 'chemistry', '鲁科版', '-', '必修第一册', 10),
  ('senior', 'chemistry', '鲁科版', '-', '必修第二册', 20),
  ('senior', 'chemistry', '鲁科版', '-', '选择性必修1 化学反应原理', 30),
  ('senior', 'chemistry', '鲁科版', '-', '选择性必修2 物质结构与性质', 40),
  ('senior', 'chemistry', '鲁科版', '-', '选择性必修3 有机化学基础', 50),
  ('junior', 'chemistry', '人教版', '-', '九年级上册', 10),
  ('junior', 'chemistry', '人教版', '-', '九年级下册', 20),
  ('junior', 'chemistry', '鲁科版', '-', '九年级上册', 10),
  ('junior', 'chemistry', '鲁科版', '-', '九年级下册', 20),
  ('senior', 'biology', '人教版', '-', '必修1 分子与细胞', 10),
  ('senior', 'biology', '人教版', '-', '必修2 遗传与进化', 20),
  ('senior', 'biology', '人教版', '-', '选择性必修1 稳态与调节', 30),
  ('senior', 'biology', '人教版', '-', '选择性必修2 生物与环境', 40),
  ('senior', 'biology', '人教版', '-', '选择性必修3 生物技术与工程', 50),
  ('senior', 'biology', '苏教版', '-', '必修1 分子与细胞', 10),
  ('senior', 'biology', '苏教版', '-', '必修2 遗传与进化', 20),
  ('senior', 'biology', '苏教版', '-', '选择性必修1 稳态与调节', 30),
  ('senior', 'biology', '苏教版', '-', '选择性必修2 生物与环境', 40),
  ('senior', 'biology', '苏教版', '-', '选择性必修3 生物技术与工程', 50),
  ('junior', 'biology', '人教版', '-', '七年级上册', 10),
  ('junior', 'biology', '人教版', '-', '七年级下册', 20),
  ('junior', 'biology', '人教版', '-', '八年级上册', 30),
  ('junior', 'biology', '人教版', '-', '八年级下册', 40),
  ('junior', 'biology', '苏教版', '-', '七年级上册', 10),
  ('junior', 'biology', '苏教版', '-', '七年级下册', 20),
  ('junior', 'biology', '苏教版', '-', '八年级上册', 30),
  ('junior', 'biology', '苏教版', '-', '八年级下册', 40),
  ('senior', 'politics', '统编版', '-', '必修1 中国特色社会主义', 10),
  ('senior', 'politics', '统编版', '-', '必修2 经济与社会', 20),
  ('senior', 'politics', '统编版', '-', '必修3 政治与法治', 30),
  ('senior', 'politics', '统编版', '-', '必修4 哲学与文化', 40),
  ('senior', 'politics', '统编版', '-', '选择性必修1 当代国际政治与经济', 50),
  ('senior', 'politics', '统编版', '-', '选择性必修2 法律与生活', 60),
  ('senior', 'politics', '统编版', '-', '选择性必修3 逻辑与思维', 70),
  ('senior', 'history', '统编版', '-', '中外历史纲要（上）', 10),
  ('senior', 'history', '统编版', '-', '中外历史纲要（下）', 20),
  ('senior', 'history', '统编版', '-', '选择性必修1 国家制度与社会治理', 30),
  ('senior', 'history', '统编版', '-', '选择性必修2 经济与社会生活', 40),
  ('senior', 'history', '统编版', '-', '选择性必修3 文化交流与传播', 50),
  ('junior', 'history', '统编版', '-', '七年级上册', 10),
  ('junior', 'history', '统编版', '-', '七年级下册', 20),
  ('junior', 'history', '统编版', '-', '八年级上册', 30),
  ('junior', 'history', '统编版', '-', '八年级下册', 40),
  ('junior', 'history', '统编版', '-', '九年级上册', 50),
  ('junior', 'history', '统编版', '-', '九年级下册', 60),
  ('senior', 'geography', '人教版', '-', '必修第一册', 10),
  ('senior', 'geography', '人教版', '-', '必修第二册', 20),
  ('senior', 'geography', '人教版', '-', '选择性必修1 自然地理基础', 30),
  ('senior', 'geography', '人教版', '-', '选择性必修2 区域发展', 40),
  ('senior', 'geography', '人教版', '-', '选择性必修3 资源、环境与国家安全', 50),
  ('senior', 'geography', '湘教版', '-', '必修第一册', 10),
  ('senior', 'geography', '湘教版', '-', '必修第二册', 20),
  ('senior', 'geography', '湘教版', '-', '选择性必修1 自然地理基础', 30),
  ('senior', 'geography', '湘教版', '-', '选择性必修2 区域发展', 40),
  ('senior', 'geography', '湘教版', '-', '选择性必修3 资源、环境与国家安全', 50),
  ('junior', 'geography', '人教版', '-', '七年级上册', 10),
  ('junior', 'geography', '人教版', '-', '七年级下册', 20),
  ('junior', 'geography', '人教版', '-', '八年级上册', 30),
  ('junior', 'geography', '人教版', '-', '八年级下册', 40),
  ('junior', 'geography', '湘教版', '-', '七年级上册', 10),
  ('junior', 'geography', '湘教版', '-', '七年级下册', 20),
  ('junior', 'geography', '湘教版', '-', '八年级上册', 30),
  ('junior', 'geography', '湘教版', '-', '八年级下册', 40)
) as v(stage, subject, version, book_name, chapter, sort_order)
join public.feedback_textbooks t
  on t.stage = v.stage and t.subject = v.subject
 and t.version = v.version and t.name = v.book_name
where not exists (
  select 1 from public.feedback_chapters c
  where c.textbook_id = t.id and c.name = v.chapter
);

-- ---------- 6. 归档与章节知识点重名的旧词（软删除，可恢复）----------
-- 执行前先看会命中哪些（应正好 24 条：全部属于 math 的「课堂内容」/「下节课内容」，
-- 且 chapter_id 为空 —— 与第 7 步插入的 188 条新行互不干扰）
select k.id, k.category, k.keyword
from public.feedback_keywords k
where k.subject = 'math'
  and k.chapter_id is null
  and k.archived_at is null
  and k.keyword in (
  ('集合的概念与关系'),
  ('集合的基本运算'),
  ('充分条件与必要条件'),
  ('全称量词与存在量词'),
  ('等式与不等式性质'),
  ('基本不等式'),
  ('二次函数与方程、不等式'),
  ('函数概念与表示'),
  ('函数的单调性、奇偶性、周期性'),
  ('幂函数'),
  ('函数的应用（一）'),
  ('指数与对数运算'),
  ('指数函数'),
  ('对数函数'),
  ('函数的应用（二）'),
  ('任意角与弧度制'),
  ('三角函数概念'),
  ('诱导公式'),
  ('三角函数图像与性质'),
  ('三角恒等变换'),
  ('函数 y=Asin(ωx+φ) 模型及其应用'),
  ('平面向量的概念及运算'),
  ('平面向量基本定理与坐标表示'),
  ('平面向量的应用'),
  ('正弦定理、余弦定理'),
  ('解三角形常见题型-极值最值'),
  ('解三角形常见题型-角平分线与中线'),
  ('复数概念'),
  ('复数四则运算'),
  ('基本立体图形及其直观图'),
  ('斜二测画法'),
  ('空间几何体的表面积、体积'),
  ('空间点、线、面之间的位置关系'),
  ('线面平行与垂直判定'),
  ('面面平行与垂直判定'),
  ('随机抽样'),
  ('用样本估计总体'),
  ('随机事件与概率'),
  ('事件独立性'),
  ('频率与概率'),
  ('空间向量运算'),
  ('空间向量及其运算的坐标表示'),
  ('空间向量的应用'),
  ('直线的方程'),
  ('圆的方程'),
  ('直线与圆的位置关系'),
  ('椭圆'),
  ('双曲线'),
  ('抛物线'),
  ('直线与圆锥曲线的综合应用'),
  ('圆锥曲线定点定值'),
  ('圆锥曲线范围最值'),
  ('数列的概念与简单表示'),
  ('等差数列及其前n项和'),
  ('等比数列及其前n项和'),
  ('数列求和'),
  ('裂项相消'),
  ('错位相减'),
  ('数列与不等式综合'),
  ('导数概念与几何意义'),
  ('导数运算'),
  ('导数的应用——函数的单调性'),
  ('导数的应用——函数的极值'),
  ('导数的应用——函数的最值'),
  ('导数恒成立问题'),
  ('导数零点问题'),
  ('导数隐零点与极值点偏移'),
  ('分类加法与分步乘法计数原理'),
  ('排列与组合'),
  ('二项式定理'),
  ('条件概率与全概率公式'),
  ('离散型随机变量'),
  ('二项分布'),
  ('超几何分布'),
  ('正态分布'),
  ('相关关系'),
  ('回归分析'),
  ('独立性检验'),
  ('近五年高考真题精讲'),
  ('历年高考卷选择题'),
  ('历年高考卷大题'),
  ('周测卷讲解'),
  ('月考试题讲解分析'),
  ('一模试卷讲解'),
  ('二模试卷讲解'),
  ('省市级模拟卷精讲'),
  ('选填压轴题专项'),
  ('多选题专项'),
  ('解答题规范书写'),
  ('答题时间分配与取舍'),
  ('极化恒等式'),
  ('等和线'),
  ('外接球与内切球'),
  ('错题总结与重做')
  )
order by k.category, k.keyword;

-- 执行归档（软删除：仅打 archived_at 标记，stage 保持 'senior'，可随时恢复）
-- 第 7 步插入的新行 chapter_id 不为空，因此不会被这里的条件命中
update public.feedback_keywords k
set archived_at = now()
where k.subject = 'math'
  and k.chapter_id is null
  and k.archived_at is null
  and k.keyword in (
  ('集合的概念与关系'),
  ('集合的基本运算'),
  ('充分条件与必要条件'),
  ('全称量词与存在量词'),
  ('等式与不等式性质'),
  ('基本不等式'),
  ('二次函数与方程、不等式'),
  ('函数概念与表示'),
  ('函数的单调性、奇偶性、周期性'),
  ('幂函数'),
  ('函数的应用（一）'),
  ('指数与对数运算'),
  ('指数函数'),
  ('对数函数'),
  ('函数的应用（二）'),
  ('任意角与弧度制'),
  ('三角函数概念'),
  ('诱导公式'),
  ('三角函数图像与性质'),
  ('三角恒等变换'),
  ('函数 y=Asin(ωx+φ) 模型及其应用'),
  ('平面向量的概念及运算'),
  ('平面向量基本定理与坐标表示'),
  ('平面向量的应用'),
  ('正弦定理、余弦定理'),
  ('解三角形常见题型-极值最值'),
  ('解三角形常见题型-角平分线与中线'),
  ('复数概念'),
  ('复数四则运算'),
  ('基本立体图形及其直观图'),
  ('斜二测画法'),
  ('空间几何体的表面积、体积'),
  ('空间点、线、面之间的位置关系'),
  ('线面平行与垂直判定'),
  ('面面平行与垂直判定'),
  ('随机抽样'),
  ('用样本估计总体'),
  ('随机事件与概率'),
  ('事件独立性'),
  ('频率与概率'),
  ('空间向量运算'),
  ('空间向量及其运算的坐标表示'),
  ('空间向量的应用'),
  ('直线的方程'),
  ('圆的方程'),
  ('直线与圆的位置关系'),
  ('椭圆'),
  ('双曲线'),
  ('抛物线'),
  ('直线与圆锥曲线的综合应用'),
  ('圆锥曲线定点定值'),
  ('圆锥曲线范围最值'),
  ('数列的概念与简单表示'),
  ('等差数列及其前n项和'),
  ('等比数列及其前n项和'),
  ('数列求和'),
  ('裂项相消'),
  ('错位相减'),
  ('数列与不等式综合'),
  ('导数概念与几何意义'),
  ('导数运算'),
  ('导数的应用——函数的单调性'),
  ('导数的应用——函数的极值'),
  ('导数的应用——函数的最值'),
  ('导数恒成立问题'),
  ('导数零点问题'),
  ('导数隐零点与极值点偏移'),
  ('分类加法与分步乘法计数原理'),
  ('排列与组合'),
  ('二项式定理'),
  ('条件概率与全概率公式'),
  ('离散型随机变量'),
  ('二项分布'),
  ('超几何分布'),
  ('正态分布'),
  ('相关关系'),
  ('回归分析'),
  ('独立性检验'),
  ('近五年高考真题精讲'),
  ('历年高考卷选择题'),
  ('历年高考卷大题'),
  ('周测卷讲解'),
  ('月考试题讲解分析'),
  ('一模试卷讲解'),
  ('二模试卷讲解'),
  ('省市级模拟卷精讲'),
  ('选填压轴题专项'),
  ('多选题专项'),
  ('解答题规范书写'),
  ('答题时间分配与取舍'),
  ('极化恒等式'),
  ('等和线'),
  ('外接球与内切球'),
  ('错题总结与重做')
  );

-- ---------- 7. 数学高中人教A版：章节知识点 ----------
-- 每个章节同时作为「课堂内容」与「下节课内容」的关键词
insert into public.feedback_keywords (subject, category, keyword, sort_order, stage, textbook_id, chapter_id, chapter_name)
select v.subject, v.category, v.keyword, v.sort_order, v.stage, c.textbook_id, c.id, c.name
from (values
  ('math', '课堂内容', '集合的概念与关系', 'senior', '必修第一册', '集合的概念与关系', 10),
  ('math', '课堂内容', '集合的基本运算', 'senior', '必修第一册', '集合的基本运算', 20),
  ('math', '课堂内容', '充分条件与必要条件', 'senior', '必修第一册', '充分条件与必要条件', 30),
  ('math', '课堂内容', '全称量词与存在量词', 'senior', '必修第一册', '全称量词与存在量词', 40),
  ('math', '课堂内容', '等式与不等式性质', 'senior', '必修第一册', '等式与不等式性质', 50),
  ('math', '课堂内容', '基本不等式', 'senior', '必修第一册', '基本不等式', 60),
  ('math', '课堂内容', '二次函数与方程、不等式', 'senior', '必修第一册', '二次函数与方程、不等式', 70),
  ('math', '课堂内容', '函数概念与表示', 'senior', '必修第一册', '函数概念与表示', 80),
  ('math', '课堂内容', '函数的单调性、奇偶性、周期性', 'senior', '必修第一册', '函数的单调性、奇偶性、周期性', 90),
  ('math', '课堂内容', '幂函数', 'senior', '必修第一册', '幂函数', 100),
  ('math', '课堂内容', '函数的应用（一）', 'senior', '必修第一册', '函数的应用（一）', 110),
  ('math', '课堂内容', '指数与对数运算', 'senior', '必修第一册', '指数与对数运算', 120),
  ('math', '课堂内容', '指数函数', 'senior', '必修第一册', '指数函数', 130),
  ('math', '课堂内容', '对数函数', 'senior', '必修第一册', '对数函数', 140),
  ('math', '课堂内容', '函数的应用（二）', 'senior', '必修第一册', '函数的应用（二）', 150),
  ('math', '课堂内容', '任意角与弧度制', 'senior', '必修第一册', '任意角与弧度制', 160),
  ('math', '课堂内容', '三角函数概念', 'senior', '必修第一册', '三角函数概念', 170),
  ('math', '课堂内容', '诱导公式', 'senior', '必修第一册', '诱导公式', 180),
  ('math', '课堂内容', '三角函数图像与性质', 'senior', '必修第一册', '三角函数图像与性质', 190),
  ('math', '课堂内容', '三角恒等变换', 'senior', '必修第一册', '三角恒等变换', 200),
  ('math', '课堂内容', '函数 y=Asin(ωx+φ) 模型及其应用', 'senior', '必修第一册', '函数 y=Asin(ωx+φ) 模型及其应用', 210),
  ('math', '课堂内容', '平面向量的概念及运算', 'senior', '必修第二册', '平面向量的概念及运算', 10),
  ('math', '课堂内容', '平面向量基本定理与坐标表示', 'senior', '必修第二册', '平面向量基本定理与坐标表示', 20),
  ('math', '课堂内容', '平面向量的应用', 'senior', '必修第二册', '平面向量的应用', 30),
  ('math', '课堂内容', '正弦定理、余弦定理', 'senior', '必修第二册', '正弦定理、余弦定理', 40),
  ('math', '课堂内容', '解三角形常见题型-极值最值', 'senior', '必修第二册', '解三角形常见题型-极值最值', 50),
  ('math', '课堂内容', '解三角形常见题型-角平分线与中线', 'senior', '必修第二册', '解三角形常见题型-角平分线与中线', 60),
  ('math', '课堂内容', '复数概念', 'senior', '必修第二册', '复数概念', 70),
  ('math', '课堂内容', '复数四则运算', 'senior', '必修第二册', '复数四则运算', 80),
  ('math', '课堂内容', '基本立体图形及其直观图', 'senior', '必修第二册', '基本立体图形及其直观图', 90),
  ('math', '课堂内容', '斜二测画法', 'senior', '必修第二册', '斜二测画法', 100),
  ('math', '课堂内容', '空间几何体的表面积、体积', 'senior', '必修第二册', '空间几何体的表面积、体积', 110),
  ('math', '课堂内容', '空间点、线、面之间的位置关系', 'senior', '必修第二册', '空间点、线、面之间的位置关系', 120),
  ('math', '课堂内容', '线面平行与垂直判定', 'senior', '必修第二册', '线面平行与垂直判定', 130),
  ('math', '课堂内容', '面面平行与垂直判定', 'senior', '必修第二册', '面面平行与垂直判定', 140),
  ('math', '课堂内容', '随机抽样', 'senior', '必修第二册', '随机抽样', 150),
  ('math', '课堂内容', '用样本估计总体', 'senior', '必修第二册', '用样本估计总体', 160),
  ('math', '课堂内容', '随机事件与概率', 'senior', '必修第二册', '随机事件与概率', 170),
  ('math', '课堂内容', '事件独立性', 'senior', '必修第二册', '事件独立性', 180),
  ('math', '课堂内容', '频率与概率', 'senior', '必修第二册', '频率与概率', 190),
  ('math', '课堂内容', '空间向量运算', 'senior', '选择性必修第一册', '空间向量运算', 10),
  ('math', '课堂内容', '空间向量及其运算的坐标表示', 'senior', '选择性必修第一册', '空间向量及其运算的坐标表示', 20),
  ('math', '课堂内容', '空间向量的应用', 'senior', '选择性必修第一册', '空间向量的应用', 30),
  ('math', '课堂内容', '直线的方程', 'senior', '选择性必修第一册', '直线的方程', 40),
  ('math', '课堂内容', '圆的方程', 'senior', '选择性必修第一册', '圆的方程', 50),
  ('math', '课堂内容', '直线与圆的位置关系', 'senior', '选择性必修第一册', '直线与圆的位置关系', 60),
  ('math', '课堂内容', '椭圆', 'senior', '选择性必修第一册', '椭圆', 70),
  ('math', '课堂内容', '双曲线', 'senior', '选择性必修第一册', '双曲线', 80),
  ('math', '课堂内容', '抛物线', 'senior', '选择性必修第一册', '抛物线', 90),
  ('math', '课堂内容', '直线与圆锥曲线的综合应用', 'senior', '选择性必修第一册', '直线与圆锥曲线的综合应用', 100),
  ('math', '课堂内容', '圆锥曲线定点定值', 'senior', '选择性必修第一册', '圆锥曲线定点定值', 110),
  ('math', '课堂内容', '圆锥曲线范围最值', 'senior', '选择性必修第一册', '圆锥曲线范围最值', 120),
  ('math', '课堂内容', '数列的概念与简单表示', 'senior', '选择性必修第二册', '数列的概念与简单表示', 10),
  ('math', '课堂内容', '等差数列及其前n项和', 'senior', '选择性必修第二册', '等差数列及其前n项和', 20),
  ('math', '课堂内容', '等比数列及其前n项和', 'senior', '选择性必修第二册', '等比数列及其前n项和', 30),
  ('math', '课堂内容', '数列求和', 'senior', '选择性必修第二册', '数列求和', 40),
  ('math', '课堂内容', '裂项相消', 'senior', '选择性必修第二册', '裂项相消', 50),
  ('math', '课堂内容', '错位相减', 'senior', '选择性必修第二册', '错位相减', 60),
  ('math', '课堂内容', '数列与不等式综合', 'senior', '选择性必修第二册', '数列与不等式综合', 70),
  ('math', '课堂内容', '导数概念与几何意义', 'senior', '选择性必修第二册', '导数概念与几何意义', 80),
  ('math', '课堂内容', '导数运算', 'senior', '选择性必修第二册', '导数运算', 90),
  ('math', '课堂内容', '导数的应用——函数的单调性', 'senior', '选择性必修第二册', '导数的应用——函数的单调性', 100),
  ('math', '课堂内容', '导数的应用——函数的极值', 'senior', '选择性必修第二册', '导数的应用——函数的极值', 110),
  ('math', '课堂内容', '导数的应用——函数的最值', 'senior', '选择性必修第二册', '导数的应用——函数的最值', 120),
  ('math', '课堂内容', '导数恒成立问题', 'senior', '选择性必修第二册', '导数恒成立问题', 130),
  ('math', '课堂内容', '导数零点问题', 'senior', '选择性必修第二册', '导数零点问题', 140),
  ('math', '课堂内容', '导数隐零点与极值点偏移', 'senior', '选择性必修第二册', '导数隐零点与极值点偏移', 150),
  ('math', '课堂内容', '分类加法与分步乘法计数原理', 'senior', '选择性必修第三册', '分类加法与分步乘法计数原理', 10),
  ('math', '课堂内容', '排列与组合', 'senior', '选择性必修第三册', '排列与组合', 20),
  ('math', '课堂内容', '二项式定理', 'senior', '选择性必修第三册', '二项式定理', 30),
  ('math', '课堂内容', '条件概率与全概率公式', 'senior', '选择性必修第三册', '条件概率与全概率公式', 40),
  ('math', '课堂内容', '离散型随机变量', 'senior', '选择性必修第三册', '离散型随机变量', 50),
  ('math', '课堂内容', '二项分布', 'senior', '选择性必修第三册', '二项分布', 60),
  ('math', '课堂内容', '超几何分布', 'senior', '选择性必修第三册', '超几何分布', 70),
  ('math', '课堂内容', '正态分布', 'senior', '选择性必修第三册', '正态分布', 80),
  ('math', '课堂内容', '相关关系', 'senior', '选择性必修第三册', '相关关系', 90),
  ('math', '课堂内容', '回归分析', 'senior', '选择性必修第三册', '回归分析', 100),
  ('math', '课堂内容', '独立性检验', 'senior', '选择性必修第三册', '独立性检验', 110),
  ('math', '课堂内容', '近五年高考真题精讲', 'senior', '高考专题与真题', '近五年高考真题精讲', 10),
  ('math', '课堂内容', '历年高考卷选择题', 'senior', '高考专题与真题', '历年高考卷选择题', 20),
  ('math', '课堂内容', '历年高考卷大题', 'senior', '高考专题与真题', '历年高考卷大题', 30),
  ('math', '课堂内容', '周测卷讲解', 'senior', '高考专题与真题', '周测卷讲解', 40),
  ('math', '课堂内容', '月考试题讲解分析', 'senior', '高考专题与真题', '月考试题讲解分析', 50),
  ('math', '课堂内容', '一模试卷讲解', 'senior', '高考专题与真题', '一模试卷讲解', 60),
  ('math', '课堂内容', '二模试卷讲解', 'senior', '高考专题与真题', '二模试卷讲解', 70),
  ('math', '课堂内容', '省市级模拟卷精讲', 'senior', '高考专题与真题', '省市级模拟卷精讲', 80),
  ('math', '课堂内容', '选填压轴题专项', 'senior', '高考专题与真题', '选填压轴题专项', 90),
  ('math', '课堂内容', '多选题专项', 'senior', '高考专题与真题', '多选题专项', 100),
  ('math', '课堂内容', '解答题规范书写', 'senior', '高考专题与真题', '解答题规范书写', 110),
  ('math', '课堂内容', '答题时间分配与取舍', 'senior', '高考专题与真题', '答题时间分配与取舍', 120),
  ('math', '课堂内容', '极化恒等式', 'senior', '高考专题与真题', '极化恒等式', 130),
  ('math', '课堂内容', '等和线', 'senior', '高考专题与真题', '等和线', 140),
  ('math', '课堂内容', '外接球与内切球', 'senior', '高考专题与真题', '外接球与内切球', 150),
  ('math', '课堂内容', '错题总结与重做', 'senior', '高考专题与真题', '错题总结与重做', 160),
  ('math', '下节课内容', '集合的概念与关系', 'senior', '必修第一册', '集合的概念与关系', 10),
  ('math', '下节课内容', '集合的基本运算', 'senior', '必修第一册', '集合的基本运算', 20),
  ('math', '下节课内容', '充分条件与必要条件', 'senior', '必修第一册', '充分条件与必要条件', 30),
  ('math', '下节课内容', '全称量词与存在量词', 'senior', '必修第一册', '全称量词与存在量词', 40),
  ('math', '下节课内容', '等式与不等式性质', 'senior', '必修第一册', '等式与不等式性质', 50),
  ('math', '下节课内容', '基本不等式', 'senior', '必修第一册', '基本不等式', 60),
  ('math', '下节课内容', '二次函数与方程、不等式', 'senior', '必修第一册', '二次函数与方程、不等式', 70),
  ('math', '下节课内容', '函数概念与表示', 'senior', '必修第一册', '函数概念与表示', 80),
  ('math', '下节课内容', '函数的单调性、奇偶性、周期性', 'senior', '必修第一册', '函数的单调性、奇偶性、周期性', 90),
  ('math', '下节课内容', '幂函数', 'senior', '必修第一册', '幂函数', 100),
  ('math', '下节课内容', '函数的应用（一）', 'senior', '必修第一册', '函数的应用（一）', 110),
  ('math', '下节课内容', '指数与对数运算', 'senior', '必修第一册', '指数与对数运算', 120),
  ('math', '下节课内容', '指数函数', 'senior', '必修第一册', '指数函数', 130),
  ('math', '下节课内容', '对数函数', 'senior', '必修第一册', '对数函数', 140),
  ('math', '下节课内容', '函数的应用（二）', 'senior', '必修第一册', '函数的应用（二）', 150),
  ('math', '下节课内容', '任意角与弧度制', 'senior', '必修第一册', '任意角与弧度制', 160),
  ('math', '下节课内容', '三角函数概念', 'senior', '必修第一册', '三角函数概念', 170),
  ('math', '下节课内容', '诱导公式', 'senior', '必修第一册', '诱导公式', 180),
  ('math', '下节课内容', '三角函数图像与性质', 'senior', '必修第一册', '三角函数图像与性质', 190),
  ('math', '下节课内容', '三角恒等变换', 'senior', '必修第一册', '三角恒等变换', 200),
  ('math', '下节课内容', '函数 y=Asin(ωx+φ) 模型及其应用', 'senior', '必修第一册', '函数 y=Asin(ωx+φ) 模型及其应用', 210),
  ('math', '下节课内容', '平面向量的概念及运算', 'senior', '必修第二册', '平面向量的概念及运算', 10),
  ('math', '下节课内容', '平面向量基本定理与坐标表示', 'senior', '必修第二册', '平面向量基本定理与坐标表示', 20),
  ('math', '下节课内容', '平面向量的应用', 'senior', '必修第二册', '平面向量的应用', 30),
  ('math', '下节课内容', '正弦定理、余弦定理', 'senior', '必修第二册', '正弦定理、余弦定理', 40),
  ('math', '下节课内容', '解三角形常见题型-极值最值', 'senior', '必修第二册', '解三角形常见题型-极值最值', 50),
  ('math', '下节课内容', '解三角形常见题型-角平分线与中线', 'senior', '必修第二册', '解三角形常见题型-角平分线与中线', 60),
  ('math', '下节课内容', '复数概念', 'senior', '必修第二册', '复数概念', 70),
  ('math', '下节课内容', '复数四则运算', 'senior', '必修第二册', '复数四则运算', 80),
  ('math', '下节课内容', '基本立体图形及其直观图', 'senior', '必修第二册', '基本立体图形及其直观图', 90),
  ('math', '下节课内容', '斜二测画法', 'senior', '必修第二册', '斜二测画法', 100),
  ('math', '下节课内容', '空间几何体的表面积、体积', 'senior', '必修第二册', '空间几何体的表面积、体积', 110),
  ('math', '下节课内容', '空间点、线、面之间的位置关系', 'senior', '必修第二册', '空间点、线、面之间的位置关系', 120),
  ('math', '下节课内容', '线面平行与垂直判定', 'senior', '必修第二册', '线面平行与垂直判定', 130),
  ('math', '下节课内容', '面面平行与垂直判定', 'senior', '必修第二册', '面面平行与垂直判定', 140),
  ('math', '下节课内容', '随机抽样', 'senior', '必修第二册', '随机抽样', 150),
  ('math', '下节课内容', '用样本估计总体', 'senior', '必修第二册', '用样本估计总体', 160),
  ('math', '下节课内容', '随机事件与概率', 'senior', '必修第二册', '随机事件与概率', 170),
  ('math', '下节课内容', '事件独立性', 'senior', '必修第二册', '事件独立性', 180),
  ('math', '下节课内容', '频率与概率', 'senior', '必修第二册', '频率与概率', 190),
  ('math', '下节课内容', '空间向量运算', 'senior', '选择性必修第一册', '空间向量运算', 10),
  ('math', '下节课内容', '空间向量及其运算的坐标表示', 'senior', '选择性必修第一册', '空间向量及其运算的坐标表示', 20),
  ('math', '下节课内容', '空间向量的应用', 'senior', '选择性必修第一册', '空间向量的应用', 30),
  ('math', '下节课内容', '直线的方程', 'senior', '选择性必修第一册', '直线的方程', 40),
  ('math', '下节课内容', '圆的方程', 'senior', '选择性必修第一册', '圆的方程', 50),
  ('math', '下节课内容', '直线与圆的位置关系', 'senior', '选择性必修第一册', '直线与圆的位置关系', 60),
  ('math', '下节课内容', '椭圆', 'senior', '选择性必修第一册', '椭圆', 70),
  ('math', '下节课内容', '双曲线', 'senior', '选择性必修第一册', '双曲线', 80),
  ('math', '下节课内容', '抛物线', 'senior', '选择性必修第一册', '抛物线', 90),
  ('math', '下节课内容', '直线与圆锥曲线的综合应用', 'senior', '选择性必修第一册', '直线与圆锥曲线的综合应用', 100),
  ('math', '下节课内容', '圆锥曲线定点定值', 'senior', '选择性必修第一册', '圆锥曲线定点定值', 110),
  ('math', '下节课内容', '圆锥曲线范围最值', 'senior', '选择性必修第一册', '圆锥曲线范围最值', 120),
  ('math', '下节课内容', '数列的概念与简单表示', 'senior', '选择性必修第二册', '数列的概念与简单表示', 10),
  ('math', '下节课内容', '等差数列及其前n项和', 'senior', '选择性必修第二册', '等差数列及其前n项和', 20),
  ('math', '下节课内容', '等比数列及其前n项和', 'senior', '选择性必修第二册', '等比数列及其前n项和', 30),
  ('math', '下节课内容', '数列求和', 'senior', '选择性必修第二册', '数列求和', 40),
  ('math', '下节课内容', '裂项相消', 'senior', '选择性必修第二册', '裂项相消', 50),
  ('math', '下节课内容', '错位相减', 'senior', '选择性必修第二册', '错位相减', 60),
  ('math', '下节课内容', '数列与不等式综合', 'senior', '选择性必修第二册', '数列与不等式综合', 70),
  ('math', '下节课内容', '导数概念与几何意义', 'senior', '选择性必修第二册', '导数概念与几何意义', 80),
  ('math', '下节课内容', '导数运算', 'senior', '选择性必修第二册', '导数运算', 90),
  ('math', '下节课内容', '导数的应用——函数的单调性', 'senior', '选择性必修第二册', '导数的应用——函数的单调性', 100),
  ('math', '下节课内容', '导数的应用——函数的极值', 'senior', '选择性必修第二册', '导数的应用——函数的极值', 110),
  ('math', '下节课内容', '导数的应用——函数的最值', 'senior', '选择性必修第二册', '导数的应用——函数的最值', 120),
  ('math', '下节课内容', '导数恒成立问题', 'senior', '选择性必修第二册', '导数恒成立问题', 130),
  ('math', '下节课内容', '导数零点问题', 'senior', '选择性必修第二册', '导数零点问题', 140),
  ('math', '下节课内容', '导数隐零点与极值点偏移', 'senior', '选择性必修第二册', '导数隐零点与极值点偏移', 150),
  ('math', '下节课内容', '分类加法与分步乘法计数原理', 'senior', '选择性必修第三册', '分类加法与分步乘法计数原理', 10),
  ('math', '下节课内容', '排列与组合', 'senior', '选择性必修第三册', '排列与组合', 20),
  ('math', '下节课内容', '二项式定理', 'senior', '选择性必修第三册', '二项式定理', 30),
  ('math', '下节课内容', '条件概率与全概率公式', 'senior', '选择性必修第三册', '条件概率与全概率公式', 40),
  ('math', '下节课内容', '离散型随机变量', 'senior', '选择性必修第三册', '离散型随机变量', 50),
  ('math', '下节课内容', '二项分布', 'senior', '选择性必修第三册', '二项分布', 60),
  ('math', '下节课内容', '超几何分布', 'senior', '选择性必修第三册', '超几何分布', 70),
  ('math', '下节课内容', '正态分布', 'senior', '选择性必修第三册', '正态分布', 80),
  ('math', '下节课内容', '相关关系', 'senior', '选择性必修第三册', '相关关系', 90),
  ('math', '下节课内容', '回归分析', 'senior', '选择性必修第三册', '回归分析', 100),
  ('math', '下节课内容', '独立性检验', 'senior', '选择性必修第三册', '独立性检验', 110),
  ('math', '下节课内容', '近五年高考真题精讲', 'senior', '高考专题与真题', '近五年高考真题精讲', 10),
  ('math', '下节课内容', '历年高考卷选择题', 'senior', '高考专题与真题', '历年高考卷选择题', 20),
  ('math', '下节课内容', '历年高考卷大题', 'senior', '高考专题与真题', '历年高考卷大题', 30),
  ('math', '下节课内容', '周测卷讲解', 'senior', '高考专题与真题', '周测卷讲解', 40),
  ('math', '下节课内容', '月考试题讲解分析', 'senior', '高考专题与真题', '月考试题讲解分析', 50),
  ('math', '下节课内容', '一模试卷讲解', 'senior', '高考专题与真题', '一模试卷讲解', 60),
  ('math', '下节课内容', '二模试卷讲解', 'senior', '高考专题与真题', '二模试卷讲解', 70),
  ('math', '下节课内容', '省市级模拟卷精讲', 'senior', '高考专题与真题', '省市级模拟卷精讲', 80),
  ('math', '下节课内容', '选填压轴题专项', 'senior', '高考专题与真题', '选填压轴题专项', 90),
  ('math', '下节课内容', '多选题专项', 'senior', '高考专题与真题', '多选题专项', 100),
  ('math', '下节课内容', '解答题规范书写', 'senior', '高考专题与真题', '解答题规范书写', 110),
  ('math', '下节课内容', '答题时间分配与取舍', 'senior', '高考专题与真题', '答题时间分配与取舍', 120),
  ('math', '下节课内容', '极化恒等式', 'senior', '高考专题与真题', '极化恒等式', 130),
  ('math', '下节课内容', '等和线', 'senior', '高考专题与真题', '等和线', 140),
  ('math', '下节课内容', '外接球与内切球', 'senior', '高考专题与真题', '外接球与内切球', 150),
  ('math', '下节课内容', '错题总结与重做', 'senior', '高考专题与真题', '错题总结与重做', 160)
) as v(subject, category, keyword, stage, textbook_name, chapter, sort_order)
join public.feedback_textbooks t
  on t.stage = v.stage and t.subject = v.subject and t.name = v.textbook_name
join public.feedback_chapters c
  on c.textbook_id = t.id and c.name = v.chapter
where not exists (
  select 1 from public.feedback_keywords k
  where k.subject = v.subject and k.category = v.category and k.keyword = v.keyword
    and k.stage = v.stage and k.textbook_id = c.textbook_id and k.chapter_id = c.id
);

-- ============================================================
-- 8. 自检
-- ============================================================
select '关键词总数（含归档）' as 项目, count(*)::text as 值 from public.feedback_keywords
union all select '未归档关键词', count(*)::text from public.feedback_keywords where archived_at is null
union all select '已归档（可恢复）', count(*)::text from public.feedback_keywords where archived_at is not null
union all select '已标 stage', count(*)::text from public.feedback_keywords where stage is not null
union all select '通用分类', count(*)::text from public.feedback_categories
union all select '教材数', count(*)::text from public.feedback_textbooks
union all select '章节数', count(*)::text from public.feedback_chapters
union all select '章节关键词', count(*)::text from public.feedback_keywords where chapter_id is not null;

-- 恢复归档的语句（需要时手动执行）
-- update public.feedback_keywords set archived_at = null where archived_at is not null;

-- 归档内容明细（核对正好 24 条，且都是数学课堂/下节课内容词）
select category as 分类, keyword as 关键词
from public.feedback_keywords
where archived_at is not null
order by category, keyword;

-- 各科目教材分布
select stage as 学段, subject as 科目, name as 教材, sort_order as 排序
from public.feedback_textbooks
order by stage desc, subject, sort_order;

-- 数学高中人教A版章节数与知识点数
select t.name as 教材, count(distinct c.id) as 章节数, count(k.id) as 知识点数
from public.feedback_textbooks t
left join public.feedback_chapters c on c.textbook_id = t.id
left join public.feedback_keywords k on k.chapter_id = c.id
where t.subject = 'math' and t.stage = 'senior' and t.name = '人教A版'
group by t.name;
