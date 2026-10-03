-- ============================================================
-- 课后反馈工作台：4 张表 + RLS + 初始数据
-- 在 Supabase Dashboard -> SQL Editor 整段执行（幂等，可重复执行）
-- 依赖：public.is_admin() 与 public.touch_updated_at()（由 0001 创建）
-- ============================================================

-- ---------- 0. 复用函数兜底（若 0001 未执行则此处创建） ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------- 1. 关键词库（全局共享；所有登录用户可读，仅 admin 可写） ----------
create table if not exists public.feedback_keywords (
  id         bigint generated always as identity primary key,
  subject    text not null,                 -- math / english / chinese / ...
  category   text not null,                 -- 课堂内容 / 课堂表现（正面）...
  keyword    text not null,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);
create index if not exists feedback_keywords_lookup_idx
  on public.feedback_keywords (subject, category, sort_order);

alter table public.feedback_keywords enable row level security;

drop policy if exists "feedback_keywords readable by authenticated" on public.feedback_keywords;
create policy "feedback_keywords readable by authenticated"
  on public.feedback_keywords for select to authenticated
  using (true);

drop policy if exists "admins write feedback_keywords" on public.feedback_keywords;
create policy "admins write feedback_keywords"
  on public.feedback_keywords for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.feedback_keywords from anon;
grant select, insert, update, delete on public.feedback_keywords to authenticated;

-- ---------- 2. 结尾短语库（全局共享；同上） ----------
create table if not exists public.feedback_phrases (
  id         bigint generated always as identity primary key,
  phrase     text not null,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.feedback_phrases enable row level security;

drop policy if exists "feedback_phrases readable by authenticated" on public.feedback_phrases;
create policy "feedback_phrases readable by authenticated"
  on public.feedback_phrases for select to authenticated using (true);

drop policy if exists "admins write feedback_phrases" on public.feedback_phrases;
create policy "admins write feedback_phrases"
  on public.feedback_phrases for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

revoke all on public.feedback_phrases from anon;
grant select, insert, update, delete on public.feedback_phrases to authenticated;

-- ---------- 3. 学生档案（按 user_id 隔离） ----------
create table if not exists public.feedback_students (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  name        text not null,
  subject     text,
  salutation  text,
  teacher     text,
  type        text,
  notes       text,
  updated_at  timestamptz not null default now(),
  constraint feedback_students_user_name_key unique (user_id, name)
);
create index if not exists feedback_students_user_idx on public.feedback_students (user_id);

alter table public.feedback_students enable row level security;

drop policy if exists "own students read" on public.feedback_students;
create policy "own students read"
  on public.feedback_students for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own students insert" on public.feedback_students;
create policy "own students insert"
  on public.feedback_students for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "own students update" on public.feedback_students;
create policy "own students update"
  on public.feedback_students for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own students delete" on public.feedback_students;
create policy "own students delete"
  on public.feedback_students for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.feedback_students to authenticated;

-- ---------- 4. 反馈历史（按 user_id 隔离） ----------
create table if not exists public.feedback_history (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid()
                 references auth.users (id) on delete cascade,
  student_name text not null,
  text         text not null,
  date         date,
  type_name    text,
  subject      text,
  created_at   timestamptz not null default now()
);
create index if not exists feedback_history_user_idx
  on public.feedback_history (user_id, created_at desc);

alter table public.feedback_history enable row level security;

drop policy if exists "own history read" on public.feedback_history;
create policy "own history read"
  on public.feedback_history for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "own history insert" on public.feedback_history;
create policy "own history insert"
  on public.feedback_history for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "own history update" on public.feedback_history;
create policy "own history update"
  on public.feedback_history for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own history delete" on public.feedback_history;
create policy "own history delete"
  on public.feedback_history for delete to authenticated
  using (user_id = (select auth.uid()));

grant select, insert, update, delete on public.feedback_history to authenticated;

-- ---------- 5. 序列权限（identity 主键需要） ----------
grant usage, select on all sequences in schema public to authenticated;

-- ---------- 6. updated_at 自动维护 ----------
drop trigger if exists feedback_keywords_touch on public.feedback_keywords;
create trigger feedback_keywords_touch before update on public.feedback_keywords
  for each row execute function public.touch_updated_at();

drop trigger if exists feedback_phrases_touch on public.feedback_phrases;
create trigger feedback_phrases_touch before update on public.feedback_phrases
  for each row execute function public.touch_updated_at();

drop trigger if exists feedback_students_touch on public.feedback_students;
create trigger feedback_students_touch before update on public.feedback_students
  for each row execute function public.touch_updated_at();

-- ============================================================
-- 7. 初始数据：关键词库 + 短语库
-- 数据来源：public/tools/feedback.html 的 KW / OTHER / CATS / DEFAULT_PHRASES
--           （由脚本程序化提取生成，共 8 科目 × 8 分类）
-- 幂等：按 subject+category+keyword 去重
-- ============================================================

insert into public.feedback_keywords (subject, category, keyword, sort_order)
select v.subject, v.category, v.keyword, v.sort_order
from (values
('math', '课堂内容', '平面向量', 1),
  ('math', '课堂内容', '解三角形', 2),
  ('math', '课堂内容', '正弦定理、余弦定理', 3),
  ('math', '课堂内容', '复数', 4),
  ('math', '课堂内容', '立体几何初步', 5),
  ('math', '课堂内容', '空间几何体的表面积体积', 6),
  ('math', '课堂内容', '线面平行与垂直判定', 7),
  ('math', '课堂内容', '面面平行与垂直判定', 8),
  ('math', '课堂内容', '空间向量', 9),
  ('math', '课堂内容', '直线的方程', 10),
  ('math', '课堂内容', '圆的方程', 11),
  ('math', '课堂内容', '直线与圆的位置关系', 12),
  ('math', '课堂内容', '椭圆', 13),
  ('math', '课堂内容', '双曲线', 14),
  ('math', '课堂内容', '抛物线', 15),
  ('math', '课堂内容', '圆锥曲线综合', 16),
  ('math', '课堂内容', '数列', 17),
  ('math', '课堂内容', '等差数列', 18),
  ('math', '课堂内容', '等比数列', 19),
  ('math', '课堂内容', '数列求和', 20),
  ('math', '课堂内容', '导数', 21),
  ('math', '课堂内容', '导数与单调性', 22),
  ('math', '课堂内容', '导数与极值最值', 23),
  ('math', '课堂内容', '导数恒成立与零点', 24),
  ('math', '课堂内容', '集合与常用逻辑用语', 25),
  ('math', '课堂内容', '一元二次不等式', 26),
  ('math', '课堂内容', '基本不等式', 27),
  ('math', '课堂内容', '函数的概念与性质', 28),
  ('math', '课堂内容', '函数的单调性、奇偶性、周期性', 29),
  ('math', '课堂内容', '指数函数', 30),
  ('math', '课堂内容', '对数函数', 31),
  ('math', '课堂内容', '幂函数', 32),
  ('math', '课堂内容', '函数零点与图像', 33),
  ('math', '课堂内容', '三角函数', 34),
  ('math', '课堂内容', '诱导公式', 35),
  ('math', '课堂内容', '三角恒等变换', 36),
  ('math', '课堂内容', '三角函数图像与性质', 37),
  ('math', '课堂内容', '概率', 38),
  ('math', '课堂内容', '古典概型', 39),
  ('math', '课堂内容', '条件概率', 40),
  ('math', '课堂内容', '全概率公式', 41),
  ('math', '课堂内容', '离散型随机变量分布列', 42),
  ('math', '课堂内容', '二项分布', 43),
  ('math', '课堂内容', '超几何分布', 44),
  ('math', '课堂内容', '统计与抽样', 45),
  ('math', '课堂内容', '频率分布直方图', 46),
  ('math', '课堂内容', '回归分析与独立性检验', 47),
  ('math', '课堂内容', '排列组合', 48),
  ('math', '课堂内容', '二项式定理', 49),
  ('math', '课堂内容', '高考真题精讲', 50),
  ('math', '课堂内容', '周测卷讲解', 51),
  ('math', '课堂内容', '月考试题讲解', 52),
  ('math', '课堂内容', '一模试卷讲解', 53),
  ('math', '课堂内容', '二模试卷讲解', 54),
  ('math', '课堂内容', '错题重做与总结', 55),
  ('math', '课堂表现（正面）', '认真听讲', 1),
  ('math', '课堂表现（正面）', '积极发言', 2),
  ('math', '课堂表现（正面）', '互动良好', 3),
  ('math', '课堂表现（正面）', '紧跟课堂节奏', 4),
  ('math', '课堂表现（正面）', '认真整理笔记', 5),
  ('math', '课堂表现（正面）', '学习态度端正', 6),
  ('math', '课堂表现（正面）', '做题认真沉得下心', 7),
  ('math', '课堂表现（正面）', '有上进心', 8),
  ('math', '课堂表现（正面）', '能主动提问', 9),
  ('math', '课堂表现（正面）', '课堂专注认真', 10),
  ('math', '课堂表现（正面）', '学习状态良好', 11),
  ('math', '课堂表现（正面）', '执行力强', 12),
  ('math', '课堂表现（正面）', '接受度较好', 13),
  ('math', '课堂表现（正面）', '理解到位', 14),
  ('math', '课堂表现（正面）', '知识掌握扎实', 15),
  ('math', '课堂表现（正面）', '进步明显', 16),
  ('math', '课堂表现（正面）', '能够独立完成', 17),
  ('math', '课堂表现（正面）', '课上状态很好', 18),
  ('math', '课堂表现（正面）', '学习很认真', 19),
  ('math', '课堂表现（正面）', '愿意动笔练习', 20),
  ('math', '课堂表现（正面）', '能复述解题过程', 21),
  ('math', '课堂表现（正面）', '提问时能准确回答', 22),
  ('math', '课堂表现（正面）', '作业完成情况好', 23),
  ('math', '课堂表现（正面）', '学习习惯良好', 24),
  ('math', '课堂表现（正面）', '自信心提升', 25),
  ('math', '课堂表现（需改进）', '偶尔走神', 1),
  ('math', '课堂表现（需改进）', '需要更专注', 2),
  ('math', '课堂表现（需改进）', '互动不积极', 3),
  ('math', '课堂表现（需改进）', '作业完成情况不好', 4),
  ('math', '课堂表现（需改进）', '课下复习不到位', 5),
  ('math', '课堂表现（需改进）', '学习状态下降', 6),
  ('math', '课堂表现（需改进）', '笔记需要提醒才记', 7),
  ('math', '课堂表现（需改进）', '不怎么看笔记', 8),
  ('math', '课堂表现（需改进）', '做题较慢', 9),
  ('math', '课堂表现（需改进）', '审题不够细致', 10),
  ('math', '课堂表现（需改进）', '计算粗心', 11),
  ('math', '课堂表现（需改进）', '计算能力弱', 12),
  ('math', '课堂表现（需改进）', '基础知识点掌握不够扎实', 13),
  ('math', '课堂表现（需改进）', '知识遗忘较快', 14),
  ('math', '课堂表现（需改进）', '存在畏难情绪', 15),
  ('math', '课堂表现（需改进）', '不够自信', 16),
  ('math', '课堂表现（需改进）', '思路不够清晰', 17),
  ('math', '课堂表现（需改进）', '综合运用易失误', 18),
  ('math', '课堂表现（需改进）', '大题不愿意动笔', 19),
  ('math', '课堂表现（需改进）', '做题顺序不合理', 20),
  ('math', '课堂表现（需改进）', '遇难题死磕耗时', 21),
  ('math', '课堂表现（需改进）', '课下练习量不足', 22),
  ('math', '课堂表现（需改进）', '错题不复盘', 23),
  ('math', '课堂表现（需改进）', '考试时心态紧张', 24),
  ('math', '课堂表现（需改进）', '解题步骤不规范', 25),
  ('math', '课堂表现（需改进）', '题目条件看错', 26),
  ('math', '课堂表现（需改进）', '时间分配不合理', 27),
  ('math', '课堂表现（需改进）', '中档题得分不稳定', 28),
  ('math', '课堂表现（需改进）', '选填速度偏慢', 29),
  ('math', '课堂表现（需改进）', '压轴题直接放弃', 30),
  ('math', '知识掌握评价', '概念清晰', 1),
  ('math', '知识掌握评价', '理解到位', 2),
  ('math', '知识掌握评价', '进步明显', 3),
  ('math', '知识掌握评价', '公式不熟', 4),
  ('math', '知识掌握评价', '需要巩固', 5),
  ('math', '知识掌握评价', '基础掌握扎实', 6),
  ('math', '知识掌握评价', '基础较差', 7),
  ('math', '知识掌握评价', '做题正确率高', 8),
  ('math', '知识掌握评价', '能够独立完成', 9),
  ('math', '知识掌握评价', '掌握情况良好', 10),
  ('math', '知识掌握评价', '选填部分较稳定', 11),
  ('math', '知识掌握评价', '大题第一问能拿分', 12),
  ('math', '知识掌握评价', '中档题掌握不牢', 13),
  ('math', '知识掌握评价', '知识体系尚未成型', 14),
  ('math', '知识掌握评价', '对考点把握准确', 15),
  ('math', '知识掌握评价', '知识迁移能力较强', 16),
  ('math', '知识掌握评价', '新题型适应能力有待提升', 17),
  ('math', '知识掌握评价', '对课本知识不熟悉', 18),
  ('math', '改进建议', '多练口算', 1),
  ('math', '改进建议', '整理错题', 2),
  ('math', '改进建议', '加强复习', 3),
  ('math', '改进建议', '注意书写', 4),
  ('math', '改进建议', '强化审题能力', 5),
  ('math', '改进建议', '精准抓取题干关键条件', 6),
  ('math', '改进建议', '熟记公式', 7),
  ('math', '改进建议', '夯实基础', 8),
  ('math', '改进建议', '多动手练习', 9),
  ('math', '改进建议', '调整做题顺序', 10),
  ('math', '改进建议', '限时训练', 11),
  ('math', '改进建议', '课下加大投入时间', 12),
  ('math', '改进建议', '刷题巩固知识点', 13),
  ('math', '改进建议', '多看错题本', 14),
  ('math', '改进建议', '吃透基础题型', 15),
  ('math', '改进建议', '复习讲过的知识', 16),
  ('math', '改进建议', '调整学习状态', 17),
  ('math', '改进建议', '定下心揣摩条件步骤', 18),
  ('math', '改进建议', '先易后难保证基础分', 19),
  ('math', '改进建议', '每天限时练一份小题', 20),
  ('math', '改进建议', '把大题第一问写全', 21),
  ('math', '改进建议', '按模块整理易混概念', 22),
  ('math', '改进建议', '建立答题模板', 23),
  ('math', '改进建议', '回归课本补漏洞', 24),
  ('math', '改进建议', '做题后即时复盘', 25),
  ('math', '分层建议', '现阶段先保证基础题零失误', 1),
  ('math', '分层建议', '中档题是提分的主要空间', 2),
  ('math', '分层建议', '压轴题只要求拿第一问和步骤分', 3),
  ('math', '分层建议', '选填争取 40 分钟内完成', 4),
  ('math', '分层建议', '把该拿的分稳稳拿到手', 5),
  ('math', '分层建议', '稳住已会内容、减少马虎失分', 6),
  ('math', '分层建议', '先把会做的题做完再回头攻坚', 7),
  ('math', '分层建议', '按高考评分标准规范书写步骤', 8),
  ('math', '作业布置', '复习讲过的题目', 1),
  ('math', '作业布置', '完成讲义剩余部分', 2),
  ('math', '作业布置', '整理错题并分析原因', 3),
  ('math', '作业布置', '背诵公式', 4),
  ('math', '作业布置', '熟记判定定理', 5),
  ('math', '作业布置', '完成学校配套练习', 6),
  ('math', '作业布置', '整理笔记并复习', 7),
  ('math', '作业布置', '完成高考真题练习', 8),
  ('math', '作业布置', '限时完成小题训练', 9),
  ('math', '作业布置', '错题重做一遍', 10),
  ('math', '作业布置', '完成专项练习册', 11),
  ('math', '作业布置', '预习下节内容', 12),
  ('math', '作业布置', '整理本次测验错题', 13),
  ('math', '作业布置', '补齐落下的作业', 14),
  ('math', '下节课内容', '继续当前专题', 1),
  ('math', '下节课内容', '新知识讲解', 2),
  ('math', '下节课内容', '综合练习', 3),
  ('math', '下节课内容', '错题精讲', 4),
  ('math', '下节课内容', '数列综合问题', 5),
  ('math', '下节课内容', '三角函数恒等变换', 6),
  ('math', '下节课内容', '平面向量的坐标表示', 7),
  ('math', '下节课内容', '立体几何证明', 8),
  ('math', '下节课内容', '圆锥曲线综合', 9),
  ('math', '下节课内容', '概率统计大题', 10),
  ('math', '下节课内容', '导数专题', 11),
  ('math', '下节课内容', '周测卷大题部分讲解', 12),
  ('math', '下节课内容', '限时套卷训练', 13),
  ('math', '下节课内容', '模块总复习', 14),
  ('english', '课堂内容', '谓语动词时态', 1),
  ('english', '课堂内容', '被动语态', 2),
  ('english', '课堂内容', '非谓语动词', 3),
  ('english', '课堂内容', '定语从句', 4),
  ('english', '课堂内容', '状语从句', 5),
  ('english', '课堂内容', '名词性从句', 6),
  ('english', '课堂内容', '应用文写作', 7),
  ('english', '课堂内容', '读后续写', 8),
  ('english', '课堂内容', '语法填空', 9),
  ('english', '课堂内容', '阅读理解', 10),
  ('english', '课堂内容', '完形填空', 11),
  ('english', '课堂内容', '七选五', 12),
  ('english', '课堂内容', '作文句式梳理', 13),
  ('english', '课堂内容', '长难句分析', 14),
  ('english', '课堂内容', '不规则动词', 15),
  ('english', '课堂内容', '时态综合复习', 16),
  ('english', '课堂内容', '一模试卷讲解', 17),
  ('english', '课堂内容', '单词背诵检查', 18),
  ('english', '课堂表现（正面）', '积极回答问题', 1),
  ('english', '课堂表现（正面）', '笔记整理非常好', 2),
  ('english', '课堂表现（正面）', '知识吸收有进步', 3),
  ('english', '课堂表现（正面）', '能主动提问', 4),
  ('english', '课堂表现（正面）', '课上状态很好', 5),
  ('english', '课堂表现（正面）', '背诵完成度高', 6),
  ('english', '课堂表现（正面）', '造句积极', 7),
  ('english', '课堂表现（正面）', '理解能力不错', 8),
  ('english', '课堂表现（正面）', '学习态度端正', 9),
  ('english', '课堂表现（正面）', '进步明显', 10),
  ('english', '课堂表现（需改进）', '单词背诵不足', 1),
  ('english', '课堂表现（需改进）', '作业未补完', 2),
  ('english', '课堂表现（需改进）', '知识点遗忘较多', 3),
  ('english', '课堂表现（需改进）', '长句书写有语法问题', 4),
  ('english', '课堂表现（需改进）', '笔记未及时复习', 5),
  ('english', '课堂表现（需改进）', '固定表达不熟', 6),
  ('english', '课堂表现（需改进）', '需要加强自主练习', 7),
  ('english', '课堂表现（需改进）', '句子成分分析不熟', 8),
  ('english', '课堂表现（需改进）', '中文思路直译成英文', 9),
  ('english', '知识掌握评价', '语法框架逐渐清晰', 1),
  ('english', '知识掌握评价', '词汇量仍需扩充', 2),
  ('english', '知识掌握评价', '阅读定位能力提升', 3),
  ('english', '知识掌握评价', '书写规范性提高', 4),
  ('english', '改进建议', '背诵勾画句子', 1),
  ('english', '改进建议', '整理范文并背诵', 2),
  ('english', '改进建议', '多练习长难句', 3),
  ('english', '改进建议', '复习笔记内容', 4),
  ('english', '改进建议', '加强单词默写', 5),
  ('english', '改进建议', '及时完成作业', 6),
  ('english', '改进建议', '背熟不规则动词变化', 7),
  ('english', '改进建议', '课上多开口造句', 8),
  ('english', '改进建议', '坚持每日单词背诵', 9),
  ('english', '分层建议', '作文先保证内容完整再追求句式', 1),
  ('english', '分层建议', '阅读先定位关键信息再全篇翻译', 2),
  ('english', '作业布置', '背诵讲解过的作文', 1),
  ('english', '作业布置', '完成单词默写练习册', 2),
  ('english', '作业布置', '整理范文并背诵', 3),
  ('english', '作业布置', '背诵不规则动词变化', 4),
  ('english', '作业布置', '完成勾画题目', 5),
  ('english', '作业布置', '整理笔记并复习', 6),
  ('english', '下节课内容', '作文专题', 1),
  ('english', '下节课内容', '阅读梳理', 2),
  ('english', '下节课内容', '续写梳理', 3),
  ('english', '下节课内容', '定语从句', 4),
  ('english', '下节课内容', '非谓语动词综合', 5),
  ('english', '下节课内容', '语法填空技巧', 6),
  ('chinese', '课堂内容', '病句辨析与修改', 1),
  ('chinese', '课堂内容', '论证方法', 2),
  ('chinese', '课堂内容', '论证思路', 3),
  ('chinese', '课堂内容', '现代文阅读', 4),
  ('chinese', '课堂内容', '古诗文鉴赏', 5),
  ('chinese', '课堂内容', '作文写作', 6),
  ('chinese', '课堂内容', '文言文翻译', 7),
  ('chinese', '课堂内容', '语言运用', 8),
  ('chinese', '课堂内容', '真题精讲', 9),
  ('chinese', '课堂内容', '答题框架梳理', 10),
  ('chinese', '课堂表现（正面）', '专注认真', 1),
  ('chinese', '课堂表现（正面）', '进步明显', 2),
  ('chinese', '课堂表现（正面）', '正确率高', 3),
  ('chinese', '课堂表现（正面）', '课堂状态积极', 4),
  ('chinese', '课堂表现（正面）', '辨析题掌握扎实', 5),
  ('chinese', '课堂表现（正面）', '能跟随步骤完成练习', 6),
  ('chinese', '课堂表现（正面）', '态度端正', 7),
  ('chinese', '课堂表现（需改进）', '初次接触不够熟练', 1),
  ('chinese', '课堂表现（需改进）', '答题尚不熟练', 2),
  ('chinese', '课堂表现（需改进）', '需要强化规范作答', 3),
  ('chinese', '课堂表现（需改进）', '部分知识点遗忘', 4),
  ('chinese', '知识掌握评价', '对历年真题把握较好', 1),
  ('chinese', '知识掌握评价', '主观题框架初步建立', 2),
  ('chinese', '改进建议', '严格套用答题框架', 1),
  ('chinese', '改进建议', '复习知识框架', 2),
  ('chinese', '改进建议', '多做专项练习', 3),
  ('chinese', '改进建议', '巩固所学内容', 4),
  ('chinese', '改进建议', '加强规范作答训练', 5),
  ('chinese', '分层建议', '主观题先搭框架再填充内容', 1),
  ('chinese', '作业布置', '完成病句专项练习', 1),
  ('chinese', '作业布置', '完成论证方法练习题', 2),
  ('chinese', '作业布置', '复习知识框架', 3),
  ('chinese', '作业布置', '套用答题框架作答', 4),
  ('chinese', '下节课内容', '继续阅读专项', 1),
  ('chinese', '下节课内容', '作文训练', 2),
  ('chinese', '下节课内容', '下一专题讲解', 3),
  ('chinese', '下节课内容', '综合练习', 4),
  ('physics', '课堂内容', '动能定理', 1),
  ('physics', '课堂内容', '平抛运动', 2),
  ('physics', '课堂内容', '板块模型', 3),
  ('physics', '课堂内容', '圆周运动', 4),
  ('physics', '课堂内容', '机械能守恒', 5),
  ('physics', '课堂内容', '动量定理', 6),
  ('physics', '课堂内容', '电场强度', 7),
  ('physics', '课堂内容', '电势差', 8),
  ('physics', '课堂内容', '闭合电路欧姆定律', 9),
  ('physics', '课堂内容', '磁场', 10),
  ('physics', '课堂内容', '电磁感应', 11),
  ('physics', '课堂内容', '月考试题讲解', 12),
  ('physics', '课堂内容', '模型综合复习', 13),
  ('physics', '课堂表现（正面）', '认真听讲做笔记', 1),
  ('physics', '课堂表现（正面）', '基础没有问题', 2),
  ('physics', '课堂表现（正面）', '思路正确', 3),
  ('physics', '课堂表现（正面）', '能复述解题过程', 4),
  ('physics', '课堂表现（正面）', '学习很努力', 5),
  ('physics', '课堂表现（正面）', '整理笔记认真', 6),
  ('physics', '课堂表现（需改进）', '审题不认真', 1),
  ('physics', '课堂表现（需改进）', '看错题目条件', 2),
  ('physics', '课堂表现（需改进）', '模型掌握不清楚', 3),
  ('physics', '课堂表现（需改进）', '不够自信', 4),
  ('physics', '课堂表现（需改进）', '知识串联不足', 5),
  ('physics', '课堂表现（需改进）', '综合性知识掌握不到位', 6),
  ('physics', '课堂表现（需改进）', '模型要点遗漏', 7),
  ('physics', '课堂表现（需改进）', '应试心理紧张', 8),
  ('physics', '知识掌握评价', '基础模型掌握到位', 1),
  ('physics', '知识掌握评价', '综合题串联能力待提升', 2),
  ('physics', '改进建议', '仔细审题圈关键信息', 1),
  ('physics', '改进建议', '巩固模型解题思路', 2),
  ('physics', '改进建议', '增强练习提升自信', 3),
  ('physics', '改进建议', '从问题出发列方程', 4),
  ('physics', '改进建议', '多做综合练习', 5),
  ('physics', '改进建议', '整理错题思路方法', 6),
  ('physics', '改进建议', '举反例排除错误选项', 7),
  ('physics', '分层建议', '先判断题干问的是什么再列式', 1),
  ('physics', '分层建议', '把模型里的每个要点都过一遍', 2),
  ('physics', '作业布置', '整理错题及思路', 1),
  ('physics', '作业布置', '完成月考试卷', 2),
  ('physics', '作业布置', '复习模型要点', 3),
  ('physics', '作业布置', '完成专项练习', 4),
  ('physics', '下节课内容', '综合复习', 1),
  ('physics', '下节课内容', '下一章节预习', 2),
  ('physics', '下节课内容', '错题精讲', 3),
  ('physics', '下节课内容', '模型专题', 4),
  ('history', '课堂内容', '殖民体系', 1),
  ('history', '课堂内容', '一战', 2),
  ('history', '课堂内容', '二战', 3),
  ('history', '课堂内容', '冷战', 4),
  ('history', '课堂内容', '亚非拉民族运动', 5),
  ('history', '课堂内容', '苏联社会主义建设', 6),
  ('history', '课堂内容', '二轮专题复习', 7),
  ('history', '课堂内容', '选择题专项练习', 8),
  ('history', '课堂内容', '材料大题训练', 9),
  ('history', '课堂表现（正面）', '紧跟课堂节奏', 1),
  ('history', '课堂表现（正面）', '认真整理笔记', 2),
  ('history', '课堂表现（正面）', '配合完成背诵', 3),
  ('history', '课堂表现（正面）', '学习状态稳定', 4),
  ('history', '课堂表现（正面）', '能跟上复习节奏', 5),
  ('history', '课堂表现（正面）', '知识落实到位', 6),
  ('history', '课堂表现（正面）', '能联系现实活学活用', 7),
  ('history', '课堂表现（需改进）', '课下背诵懈怠', 1),
  ('history', '课堂表现（需改进）', '作业完成度不足', 2),
  ('history', '课堂表现（需改进）', '存在畏难情绪', 3),
  ('history', '课堂表现（需改进）', '主动动笔意愿弱', 4),
  ('history', '课堂表现（需改进）', '答题熟练度不足', 5),
  ('history', '课堂表现（需改进）', '选择题正确率起伏', 6),
  ('history', '知识掌握评价', '一轮复习已系统完成', 1),
  ('history', '知识掌握评价', '阶段特征识记较好', 2),
  ('history', '知识掌握评价', '材料题框架待搭建', 3),
  ('history', '改进建议', '加强课下背诵', 1),
  ('history', '改进建议', '认真完成作业', 2),
  ('history', '改进建议', '克服畏难情绪', 3),
  ('history', '改进建议', '多动笔练习', 4),
  ('history', '改进建议', '建立答题自信心', 5),
  ('history', '改进建议', '从短句作答入手搭框架', 6),
  ('history', '分层建议', '材料题先搭框架再填充史实', 1),
  ('history', '作业布置', '背诵材料题标准答案', 1),
  ('history', '作业布置', '背诵历史阶段特征', 2),
  ('history', '作业布置', '抄写阶段特征', 3),
  ('history', '作业布置', '补齐选择题练习', 4),
  ('history', '下节课内容', '二轮专题继续', 1),
  ('history', '下节课内容', '主观题分层训练', 2),
  ('history', '下节课内容', '高考真题精讲', 3),
  ('politics', '课堂内容', '哲学概况', 1),
  ('politics', '课堂内容', '唯物论', 2),
  ('politics', '课堂内容', '辩证法', 3),
  ('politics', '课堂内容', '联系观', 4),
  ('politics', '课堂内容', '发展观', 5),
  ('politics', '课堂内容', '矛盾观', 6),
  ('politics', '课堂内容', '创新观', 7),
  ('politics', '课堂内容', '物质与意识', 8),
  ('politics', '课堂内容', '规律客观性', 9),
  ('politics', '课堂内容', '意识能动作用', 10),
  ('politics', '课堂内容', '马克思主义哲学', 11),
  ('politics', '课堂表现（正面）', '专注认真', 1),
  ('politics', '课堂表现（正面）', '态度端正', 2),
  ('politics', '课堂表现（正面）', '紧跟老师思路', 3),
  ('politics', '课堂表现（正面）', '主动标记重难点', 4),
  ('politics', '课堂表现（正面）', '笔记整理规范完整', 5),
  ('politics', '课堂表现（正面）', '理解到位', 6),
  ('politics', '课堂表现（正面）', '学习状态积极高效', 7),
  ('politics', '课堂表现（需改进）', '原理对应记忆需强化', 1),
  ('politics', '课堂表现（需改进）', '结合例题不够熟练', 2),
  ('politics', '课堂表现（需改进）', '需要提升解题能力', 3),
  ('politics', '知识掌握评价', '哲学框架掌握扎实', 1),
  ('politics', '知识掌握评价', '原理关系理解到位', 2),
  ('politics', '改进建议', '回顾笔记强化记忆', 1),
  ('politics', '改进建议', '强化原理与方法论对应', 2),
  ('politics', '改进建议', '结合典型例题巩固理解', 3),
  ('politics', '分层建议', '背原理时必须连带方法论一起记', 1),
  ('politics', '作业布置', '回顾课堂笔记', 1),
  ('politics', '作业布置', '强化原理记忆', 2),
  ('politics', '作业布置', '完成配套练习', 3),
  ('politics', '下节课内容', '辩证法深入', 1),
  ('politics', '下节课内容', '认识论', 2),
  ('politics', '下节课内容', '历史唯物主义', 3),
  ('politics', '下节课内容', '综合练习', 4),
  ('chemistry', '课堂内容', '离子反应', 1),
  ('chemistry', '课堂内容', '离子共存', 2),
  ('chemistry', '课堂内容', '氧化还原反应', 3),
  ('chemistry', '课堂内容', '化学平衡', 4),
  ('chemistry', '课堂内容', '电化学', 5),
  ('chemistry', '课堂内容', '元素化合物', 6),
  ('chemistry', '课堂内容', '有机化学', 7),
  ('chemistry', '课堂内容', '测试题讲解', 8),
  ('chemistry', '课堂表现（正面）', '课堂表现积极', 1),
  ('chemistry', '课堂表现（正面）', '有上进心', 2),
  ('chemistry', '课堂表现（正面）', '学习态度值得肯定', 3),
  ('chemistry', '课堂表现（正面）', '能主动提出问题', 4),
  ('chemistry', '课堂表现（正面）', '有一定认知基础', 5),
  ('chemistry', '课堂表现（需改进）', '部分问题偏离考点', 1),
  ('chemistry', '课堂表现（需改进）', '做题偶尔犯懒', 2),
  ('chemistry', '课堂表现（需改进）', '审题不够细致', 3),
  ('chemistry', '课堂表现（需改进）', '计算缺乏严谨', 4),
  ('chemistry', '课堂表现（需改进）', '基础知识点掌握不够扎实', 5),
  ('chemistry', '知识掌握评价', '基础离子组知识有一定认知', 1),
  ('chemistry', '知识掌握评价', '综合应用存在漏洞', 2),
  ('chemistry', '改进建议', '强化审题能力', 1),
  ('chemistry', '改进建议', '精准抓取题干条件', 2),
  ('chemistry', '改进建议', '熟记常见离子组知识点', 3),
  ('chemistry', '改进建议', '夯实基础', 4),
  ('chemistry', '改进建议', '计算过程认真严谨', 5),
  ('chemistry', '分层建议', '先判断反应类型再写方程式', 1),
  ('chemistry', '作业布置', '整理测验错题', 1),
  ('chemistry', '作业布置', '分析错误原因', 2),
  ('chemistry', '作业布置', '预习下一专题', 3),
  ('chemistry', '下节课内容', '下一专题讲解', 1),
  ('chemistry', '下节课内容', '综合练习', 2),
  ('chemistry', '下节课内容', '错题回顾', 3),
  ('general', '课堂内容', '知识点讲解', 1),
  ('general', '课堂内容', '习题练习', 2),
  ('general', '课堂内容', '试卷讲评', 3),
  ('general', '课堂内容', '专题复习', 4),
  ('general', '课堂内容', '综合训练', 5),
  ('general', '课堂内容', '知识梳理', 6),
  ('general', '课堂表现（正面）', '认真听讲', 1),
  ('general', '课堂表现（正面）', '积极发言', 2),
  ('general', '课堂表现（正面）', '互动良好', 3),
  ('general', '课堂表现（正面）', '态度端正', 4),
  ('general', '课堂表现（正面）', '进步明显', 5),
  ('general', '课堂表现（正面）', '学习状态好', 6),
  ('general', '课堂表现（需改进）', '偶尔走神', 1),
  ('general', '课堂表现（需改进）', '需要更专注', 2),
  ('general', '课堂表现（需改进）', '积极性有待提高', 3),
  ('general', '课堂表现（需改进）', '作业完成不理想', 4),
  ('general', '知识掌握评价', '基础掌握尚可', 1),
  ('general', '知识掌握评价', '综合应用待加强', 2),
  ('general', '改进建议', '加强复习', 1),
  ('general', '改进建议', '多做练习', 2),
  ('general', '改进建议', '整理错题', 3),
  ('general', '改进建议', '夯实基础', 4),
  ('general', '分层建议', '先保证基础题不丢分', 1),
  ('general', '作业布置', '完成课后练习', 1),
  ('general', '作业布置', '复习课堂内容', 2),
  ('general', '作业布置', '整理笔记', 3),
  ('general', '下节课内容', '继续当前专题', 1),
  ('general', '下节课内容', '新知识讲解', 2),
  ('general', '下节课内容', '综合练习', 3)
) as v(subject, category, keyword, sort_order)
where not exists (
  select 1 from public.feedback_keywords k
  where k.subject = v.subject and k.category = v.category and k.keyword = v.keyword
);

insert into public.feedback_phrases (phrase, sort_order)
select v.phrase, v.sort_order
from (values
('有问题及时和我沟通。', 10),
  ('辛苦您多叮嘱孩子课下多做题。', 20),
  ('希望我们一同努力，帮助孩子实现梦想。', 30),
  ('课下的时间利用才是决定孩子最后成绩的关键。', 40),
  ('孩子很聪明，一点就透。', 50),
  ('总体上孩子上课学习态度很积极。', 60),
  ('每周都能看到孩子在一点点进步。', 70),
  ('孩子现阶段需要加大练习力度。', 80),
  ('临近高考，基础和中档题一定要拿住。', 90),
  ('现阶段就是通过刷题巩固知识，同时对中上难度的综合题进行突破。', 100)
) as v(phrase, sort_order)
where not exists (
  select 1 from public.feedback_phrases p where p.phrase = v.phrase
);

-- ============================================================
-- 8. 自检
-- ============================================================
select '关键词总数' as 项目, count(*)::text as 值 from public.feedback_keywords
union all
select '短语总数', count(*)::text from public.feedback_phrases;

select subject as 科目, count(*) as 关键词数
from public.feedback_keywords
group by subject
order by subject;

select tablename as 表, policyname as 策略, cmd as 操作
from pg_policies
where tablename like 'feedback\_%'
order by tablename, policyname;
