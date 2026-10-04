-- ============================================================
-- 0008：清理「册次名占位」章节（**提升完成后**执行）
--
-- 背景
--   0005 生成时还没有「册次」维度，我把册次名（必修第一册 / 七年级上册 …）
--   填进了 feedback_chapters 当占位。它们不是真实章节，而是占位数据。
--   现在真实的「章」已进入 feedback_sections（959 条），
--   占位数据若留着，教材/章列表里会出现重复条目。
--
-- 当前实测状态（提升后）
--   · 占位教材（name='-'）35 本
--   · 占位章节 178 条，全部**无关键词引用**
--   · 人教A版的 94 个真实知识点（chapter_id 被 188 条关键词引用）不受影响
--
-- 安全性
--   只删「占位教材下 + 没有任何关键词引用 + 未被本批次导入标记」的行。
--   有引用的行会被保留（下面的查询会列出来）。
--   幂等：可重复执行，第二次影响 0 行。
-- ============================================================

-- ---------- 执行前：先看会删掉哪些（应约 178 行） ----------
select t.stage as 学段, t.subject as 科目, t.version as 版本,
       c.name as 占位章节名,
       (select count(*) from public.feedback_keywords k where k.chapter_id = c.id) as 被引用次数
from public.feedback_chapters c
join public.feedback_textbooks t on t.id = c.textbook_id
where t.name = '-'
  and c.import_batch_id is null
  and not exists (select 1 from public.feedback_keywords k where k.chapter_id = c.id)
order by t.stage desc, t.subject, t.version, c.name;

-- 统计：应为 178
select count(*) as 可清理的占位章节数
from public.feedback_chapters c
join public.feedback_textbooks t on t.id = c.textbook_id
where t.name = '-'
  and c.import_batch_id is null
  and not exists (select 1 from public.feedback_keywords k where k.chapter_id = c.id);

-- ---------- 执行清理 ----------
delete from public.feedback_chapters c
using public.feedback_textbooks t
where c.textbook_id = t.id
  and t.name = '-'
  and c.import_batch_id is null
  and not exists (select 1 from public.feedback_keywords k where k.chapter_id = c.id);

-- ---------- 执行后自检 ----------
-- 期望：chapters 4451 - 178 = 4273
select 'feedback_chapters 总数' as 项目, count(*)::text as 值 from public.feedback_chapters
union all select '本批次知识点（应仍为4179）', count(*)::text from public.feedback_chapters
        where import_batch_id = 'ai-20261004-01'
union all select '人教A版知识点（应仍为94）', count(*)::text
        from public.feedback_chapters c join public.feedback_textbooks t on t.id = c.textbook_id
        where t.version = '人教A版'
union all select '带章节的关键词（应仍为8546）', count(*)::text
        from public.feedback_keywords where chapter_id is not null
union all select '孤立知识点（应为0）', count(*)::text
        from public.feedback_chapters c
        left join public.feedback_textbooks t on t.id = c.textbook_id where t.id is null
union all select '孤立关键词（应为0）', count(*)::text
        from public.feedback_keywords k
        left join public.feedback_chapters c on c.id = k.chapter_id
        where k.chapter_id is not null and c.id is null;

-- ---------- 可选：清理占位教材行本身 ----------
-- 执行完上面的删除后，占位教材（name='-'）就只剩一个空壳，没有任何章节挂着。
-- 工具页的「册次」下拉里它们会显示为「<版本>」（无册次），与真实册次并存，
-- 可能略显冗余。若想一并清掉，取消下面两行的注释：
--
-- delete from public.feedback_textbooks t
-- where t.name = '-' and not exists (select 1 from public.feedback_chapters c where c.textbook_id = t.id);
--
-- 注意：删除后教材表将从 219 行降到约 184 行（只保留有册次名的）。
--       这一步**不是必须的**，功能上留着也无害。
