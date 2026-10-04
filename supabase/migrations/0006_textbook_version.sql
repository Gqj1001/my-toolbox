-- ============================================================
-- 问题1：教材改为「版本 + 册次」两级
--
--   version = 人教A版 / 人教版 / 统编版 / 外研版 / 北师大版 …
--   name    = 必修第一册 / 必修一 / 七年级上册 / 高考专题与真题 …
--   纯版本名（如语文只有「统编版」，无册次之分）的 name 记为 '-'
--
-- 幂等，可重复执行。**教材 id 不变**，所以章节与关键词的引用全部保持有效。
-- 采用「按 id 逐条精确更新」而不是启发式字符串猜测，避免误改。
-- ============================================================

-- ---------- 1. 加列 ----------
alter table public.feedback_textbooks add column if not exists version text;
update public.feedback_textbooks set version = '-' where version is null;
alter table public.feedback_textbooks alter column version set default '-';
alter table public.feedback_textbooks alter column version set not null;

-- ---------- 2. 唯一约束改为四元组 ----------
-- 拆出 version 后，同一科目下会出现多本同名册次（如英语三个版本都叫「必修一」），
-- 原 (stage, subject, name) 唯一约束必须换成含 version 的四元组
alter table public.feedback_textbooks drop constraint if exists feedback_textbooks_stage_subject_name_key;
drop index if exists public.feedback_textbooks_uniq;
create unique index if not exists feedback_textbooks_uniq
  on public.feedback_textbooks (stage, subject, version, name);

create index if not exists feedback_textbooks_scope_idx
  on public.feedback_textbooks (stage, subject, version, sort_order);

-- ---------- 3. 逐本拆分（按 id，共 41 本）----------
update public.feedback_textbooks set version = '人教A版', name = '必修第一册' where id = 1;
update public.feedback_textbooks set version = '人教A版', name = '必修第二册' where id = 2;
update public.feedback_textbooks set version = '人教A版', name = '选择性必修第一册' where id = 3;
update public.feedback_textbooks set version = '人教A版', name = '选择性必修第二册' where id = 4;
update public.feedback_textbooks set version = '人教A版', name = '选择性必修第三册' where id = 5;
update public.feedback_textbooks set version = '人教A版', name = '高考专题与真题' where id = 6;
update public.feedback_textbooks set version = '人教B版', name = '-' where id = 7;
update public.feedback_textbooks set version = '北师大版', name = '-' where id = 8;
update public.feedback_textbooks set version = '苏教版', name = '-' where id = 9;
update public.feedback_textbooks set version = '湘教版', name = '-' where id = 10;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 11;
update public.feedback_textbooks set version = '北师大版', name = '-' where id = 12;
update public.feedback_textbooks set version = '苏科版', name = '-' where id = 13;
update public.feedback_textbooks set version = '统编版', name = '-' where id = 14;
update public.feedback_textbooks set version = '统编版', name = '-' where id = 15;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 16;
update public.feedback_textbooks set version = '外研版', name = '-' where id = 17;
update public.feedback_textbooks set version = '译林版', name = '-' where id = 18;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 19;
update public.feedback_textbooks set version = '外研版', name = '-' where id = 20;
update public.feedback_textbooks set version = '译林版', name = '-' where id = 21;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 22;
update public.feedback_textbooks set version = '教科版', name = '-' where id = 23;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 24;
update public.feedback_textbooks set version = '教科版', name = '-' where id = 25;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 26;
update public.feedback_textbooks set version = '苏科版', name = '-' where id = 27;
update public.feedback_textbooks set version = '鲁科版', name = '-' where id = 28;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 29;
update public.feedback_textbooks set version = '鲁科版', name = '-' where id = 30;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 31;
update public.feedback_textbooks set version = '苏教版', name = '-' where id = 32;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 33;
update public.feedback_textbooks set version = '苏教版', name = '-' where id = 34;
update public.feedback_textbooks set version = '统编版', name = '-' where id = 35;
update public.feedback_textbooks set version = '统编版', name = '-' where id = 36;
update public.feedback_textbooks set version = '统编版', name = '-' where id = 37;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 38;
update public.feedback_textbooks set version = '湘教版', name = '-' where id = 39;
update public.feedback_textbooks set version = '人教版', name = '-' where id = 40;
update public.feedback_textbooks set version = '湘教版', name = '-' where id = 41;

-- ---------- 4. 自检 ----------
select count(*) as 教材总数,
       count(distinct version) as 版本数,
       count(*) filter (where name = '-') as 无册次版本数
from public.feedback_textbooks;

select stage as 学段, subject as 科目, version as 版本, count(*) as 册次数,
       string_agg(name, ' / ' order by sort_order) as 册次
from public.feedback_textbooks
group by stage, subject, version
order by stage desc, subject, version;

-- 确认引用没有断
select '章节总数' as 项目, count(*)::text as 值 from public.feedback_chapters
union all select '关键词中带教材的', count(*)::text from public.feedback_keywords where textbook_id is not null
union all select '关键词中带章节的', count(*)::text from public.feedback_keywords where chapter_id is not null
union all select '孤立章节（教材不存在）', count(*)::text from public.feedback_chapters c
  left join public.feedback_textbooks t on t.id = c.textbook_id where t.id is null;
