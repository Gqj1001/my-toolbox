-- ============================================================
-- 0008（可选）：清理「册次名占位」章节
--
-- 背景：
--   0005 生成时把「册次名」填进了 feedback_chapters 当占位
--   （如 人教B版 下有 必修第一册/必修第二册/… 共 7 条）。
--   这些不是真实章节，而是当时还没有册次维度留下的痕迹。
--
-- 现状（实测）：
--   · 占位教材 35 本下共 178 条这样的"章节"
--   · 被关键词引用: 0 条
--   · 导入 0007 的候选数据后，它们会被真实的「章」(feedback_sections) 取代
--   · 若不清理，工具页的「教材」下拉会同时出现"占位行"与"册次行"，出现重复选项
--
-- 安全性：
--   只删除「属于会被本次导入覆盖的 35 个版本」且「没有被任何关键词引用」的行。
--   人教A版的 94 个真实知识点（chapter_id 被 188 条关键词引用）不会被碰。
--
-- 建议：在**导入候选并提升完成之后**再执行本文件。
-- ============================================================

-- ---------- 1. 先看会删掉哪些（执行前人工核对） ----------
select t.stage as 学段, t.subject as 科目, t.version as 版本, c.name as 占位章节名,
       (select count(*) from public.feedback_keywords k where k.chapter_id = c.id) as 被引用次数
from public.feedback_chapters c
join public.feedback_textbooks t on t.id = c.textbook_id
where t.name = '-'                                  -- 占位教材
  and not exists (select 1 from public.feedback_keywords k where k.chapter_id = c.id)
order by t.stage desc, t.subject, t.version, c.name;

-- 统计：应约为 178 条
select count(*) as 可清理的占位章节数
from public.feedback_chapters c
join public.feedback_textbooks t on t.id = c.textbook_id
where t.name = '-'
  and not exists (select 1 from public.feedback_keywords k where k.chapter_id = c.id);

-- ---------- 2. 执行清理 ----------
-- 只删「占位教材下 + 无关键词引用」的行；有引用的会保留
delete from public.feedback_chapters c
using public.feedback_textbooks t
where c.textbook_id = t.id
  and t.name = '-'
  and not exists (select 1 from public.feedback_keywords k where k.chapter_id = c.id);

-- ---------- 3. 自检 ----------
select '清理后章节总数' as 项目, count(*)::text as 值 from public.feedback_chapters
union all select '人教A版章节数（应仍为94）', count(*)::text
  from public.feedback_chapters c join public.feedback_textbooks t on t.id = c.textbook_id
  where t.version = '人教A版'
union all select '带章节的关键词（应仍为188）', count(*)::text
  from public.feedback_keywords where chapter_id is not null
union all select '孤立章节（应为0）', count(*)::text
  from public.feedback_chapters c
  left join public.feedback_textbooks t on t.id = c.textbook_id where t.id is null;
