// 生成第 7 步迁移 SQL（v2）：
//  - 新增 feedback_textbooks / feedback_chapters / feedback_categories
//  - feedback_keywords 加 stage / textbook_id / chapter_id / chapter_name
//  - 84 个通用分类入库（9 科目 × 2 学段，stage 覆盖 + '通用'）
//  - 教材种子（按用户指定清单）
//  - 数学高中 6 册 94 章 → 188 条章节关键词（课堂内容 + 下节课内容）
//  - 删除 24 条与章节知识点重名的旧词（精确匹配，先查后删）
import { readFileSync, writeFileSync } from "node:fs";

const HTML = "D:/my-website/my-toolbox/public/tools/feedback.html";
const OUT = "D:/my-website/my-toolbox/supabase/migrations/0005_stage_subject_textbook.sql";

const lines = readFileSync(HTML, "utf8").split(/\r?\n/);
function extractConst(name) {
  const start = lines.findIndex((l) => new RegExp(`^\\s*const ${name}\\s*=`).test(l));
  if (start === -1) throw new Error(`未找到 ${name}`);
  let text = "", depth = 0, started = false;
  for (let i = start; i < lines.length; i++) {
    text += lines[i] + "\n";
    for (const ch of lines[i]) {
      if (ch === "{" || ch === "[") { depth++; started = true; }
      else if (ch === "}" || ch === "]") depth--;
    }
    if (started && depth <= 0) break;
  }
  let body = text.slice(text.indexOf("=") + 1).trim();
  if (body.endsWith(";")) body = body.slice(0, -1);
  return new Function(`return (${body});`)();
}
const BOOKS = extractConst("MATHEMATICS_BOOKS");
const CATS = extractConst("CATS");

const esc = (s) => String(s).replace(/'/g, "''");

// ---------- 分类（8 个，全学段通用 → stage 留空）----------
const CATEGORY_SEED = CATS.map((c, i) => ({ name: c.name, sort_order: (i + 1) * 10 }));

// ---------- 科目 × 学段 ----------
const SUBJECTS = [
  { code: "chinese", name: "语文", stages: ["senior", "junior"] },
  { code: "math", name: "数学", stages: ["senior", "junior"] },
  { code: "english", name: "英语", stages: ["senior", "junior"] },
  { code: "physics", name: "物理", stages: ["senior", "junior"] },
  { code: "chemistry", name: "化学", stages: ["senior", "junior"] },
  { code: "biology", name: "生物", stages: ["senior", "junior"] },
  { code: "politics", name: "政治", stages: ["senior"] },
  { code: "history", name: "历史", stages: ["senior", "junior"] },
  { code: "geography", name: "地理", stages: ["senior", "junior"] },
  { code: "general", name: "通用", stages: ["senior", "junior"] },
];

// ---------- 教材种子（用户指定清单）----------
// 数学高中：MATHEMATICS_BOOKS 的每一册 = 一本教材（版本=人教A版，册次=必修第一册…）
// name 用 '-' 表示该版本没有册次之分（与 0006 迁移的约定一致）
const TB = [
  ...BOOKS.map((b, i) => ({
    stage: "senior",
    subject: "math",
    version: "人教A版",
    name: b.name,
    chapters: b.topics,
    sort_order: (i + 1) * 10,
  })),
  // 数学 · 高中其它版本
  { stage: "senior", subject: "math", version: "人教B版",  sort_order: 20, name: "-", chapters: ["必修第一册", "必修第二册", "必修第三册", "必修第四册", "选择性必修第一册", "选择性必修第二册", "选择性必修第三册"] },
  { stage: "senior", subject: "math", version: "北师大版", sort_order: 30, name: "-", chapters: ["必修第一册", "必修第二册", "选择性必修第一册", "选择性必修第二册"] },
  { stage: "senior", subject: "math", version: "苏教版",   sort_order: 40, name: "-", chapters: ["必修第一册", "必修第二册", "选择性必修第一册", "选择性必修第二册"] },
  { stage: "senior", subject: "math", version: "湘教版",   sort_order: 50, name: "-", chapters: ["必修第一册", "必修第二册", "选择性必修第一册", "选择性必修第二册"] },
  // 数学 · 初中
  { stage: "junior", subject: "math", version: "人教版",   sort_order: 10, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级上册", "九年级下册"] },
  { stage: "junior", subject: "math", version: "北师大版", sort_order: 20, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级上册", "九年级下册"] },
  { stage: "junior", subject: "math", version: "苏科版",   sort_order: 30, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级上册", "九年级下册"] },
  // 语文
  { stage: "senior", subject: "chinese", version: "统编版", sort_order: 10, name: "-", chapters: ["必修上册", "必修下册", "选择性必修上册", "选择性必修中册", "选择性必修下册"] },
  { stage: "junior", subject: "chinese", version: "统编版", sort_order: 10, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级上册", "九年级下册"] },
  // 英语
  { stage: "senior", subject: "english", version: "人教版", sort_order: 10, name: "-", chapters: ["必修一", "必修二", "必修三", "选择性必修一", "选择性必修二", "选择性必修三", "选择性必修四"] },
  { stage: "senior", subject: "english", version: "外研版", sort_order: 20, name: "-", chapters: ["必修一", "必修二", "必修三", "选择性必修一", "选择性必修二", "选择性必修三", "选择性必修四"] },
  { stage: "senior", subject: "english", version: "译林版", sort_order: 30, name: "-", chapters: ["必修一", "必修二", "必修三", "选择性必修一", "选择性必修二", "选择性必修三", "选择性必修四"] },
  { stage: "junior", subject: "english", version: "人教版", sort_order: 10, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级全一册"] },
  { stage: "junior", subject: "english", version: "外研版", sort_order: 20, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级上册", "九年级下册"] },
  { stage: "junior", subject: "english", version: "译林版", sort_order: 30, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级上册", "九年级下册"] },
  // 物理
  { stage: "senior", subject: "physics", version: "人教版", sort_order: 10, name: "-", chapters: ["必修第一册", "必修第二册", "必修第三册", "选择性必修第一册", "选择性必修第二册", "选择性必修第三册"] },
  { stage: "senior", subject: "physics", version: "教科版", sort_order: 20, name: "-", chapters: ["必修第一册", "必修第二册", "必修第三册", "选择性必修第一册", "选择性必修第二册", "选择性必修第三册"] },
  { stage: "junior", subject: "physics", version: "人教版", sort_order: 10, name: "-", chapters: ["八年级上册", "八年级下册", "九年级全一册"] },
  { stage: "junior", subject: "physics", version: "教科版", sort_order: 20, name: "-", chapters: ["八年级上册", "八年级下册", "九年级上册", "九年级下册"] },
  // 化学
  { stage: "senior", subject: "chemistry", version: "人教版", sort_order: 10, name: "-", chapters: ["必修第一册", "必修第二册", "选择性必修1 化学反应原理", "选择性必修2 物质结构与性质", "选择性必修3 有机化学基础"] },
  { stage: "senior", subject: "chemistry", version: "苏科版", sort_order: 20, name: "-", chapters: ["必修第一册", "必修第二册", "选择性必修1 化学反应原理", "选择性必修2 物质结构与性质", "选择性必修3 有机化学基础"] },
  { stage: "senior", subject: "chemistry", version: "鲁科版", sort_order: 30, name: "-", chapters: ["必修第一册", "必修第二册", "选择性必修1 化学反应原理", "选择性必修2 物质结构与性质", "选择性必修3 有机化学基础"] },
  { stage: "junior", subject: "chemistry", version: "人教版", sort_order: 10, name: "-", chapters: ["九年级上册", "九年级下册"] },
  { stage: "junior", subject: "chemistry", version: "鲁科版", sort_order: 20, name: "-", chapters: ["九年级上册", "九年级下册"] },
  // 生物
  { stage: "senior", subject: "biology", version: "人教版", sort_order: 10, name: "-", chapters: ["必修1 分子与细胞", "必修2 遗传与进化", "选择性必修1 稳态与调节", "选择性必修2 生物与环境", "选择性必修3 生物技术与工程"] },
  { stage: "senior", subject: "biology", version: "苏教版", sort_order: 20, name: "-", chapters: ["必修1 分子与细胞", "必修2 遗传与进化", "选择性必修1 稳态与调节", "选择性必修2 生物与环境", "选择性必修3 生物技术与工程"] },
  { stage: "junior", subject: "biology", version: "人教版", sort_order: 10, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册"] },
  { stage: "junior", subject: "biology", version: "苏教版", sort_order: 20, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册"] },
  // 政治（仅高中）
  { stage: "senior", subject: "politics", version: "统编版", sort_order: 10, name: "-", chapters: ["必修1 中国特色社会主义", "必修2 经济与社会", "必修3 政治与法治", "必修4 哲学与文化", "选择性必修1 当代国际政治与经济", "选择性必修2 法律与生活", "选择性必修3 逻辑与思维"] },
  // 历史
  { stage: "senior", subject: "history", version: "统编版", sort_order: 10, name: "-", chapters: ["中外历史纲要（上）", "中外历史纲要（下）", "选择性必修1 国家制度与社会治理", "选择性必修2 经济与社会生活", "选择性必修3 文化交流与传播"] },
  { stage: "junior", subject: "history", version: "统编版", sort_order: 10, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册", "九年级上册", "九年级下册"] },
  // 地理
  { stage: "senior", subject: "geography", version: "人教版", sort_order: 10, name: "-", chapters: ["必修第一册", "必修第二册", "选择性必修1 自然地理基础", "选择性必修2 区域发展", "选择性必修3 资源、环境与国家安全"] },
  { stage: "senior", subject: "geography", version: "湘教版", sort_order: 20, name: "-", chapters: ["必修第一册", "必修第二册", "选择性必修1 自然地理基础", "选择性必修2 区域发展", "选择性必修3 资源、环境与国家安全"] },
  { stage: "junior", subject: "geography", version: "人教版", sort_order: 10, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册"] },
  { stage: "junior", subject: "geography", version: "湘教版", sort_order: 20, name: "-", chapters: ["七年级上册", "七年级下册", "八年级上册", "八年级下册"] },
];

// ---------- 数学高中「人教A版」的章节知识点 ----------
// 每册是一个 textbook 行（version=人教A版，name=册次），册内 topic = 章节
const mathABooks = TB.filter(
  (t) => t.subject === "math" && t.stage === "senior" && t.version === "人教A版",
);
const chapterKeywordRows = [];
const allTopics = [];
for (const cat of ["课堂内容", "下节课内容"]) {
  for (const book of mathABooks) {
    book.chapters.forEach((topic, i) => {
      chapterKeywordRows.push(
        `  ('math', '${cat}', '${esc(topic)}', 'senior', '${esc(book.name)}', '${esc(topic)}', ${(i + 1) * 10})`,
      );
    });
  }
}
for (const book of mathABooks) allTopics.push(...book.chapters);

// 与章节知识点重名的旧词（用于删除）
const dupValues = allTopics.map((k) => `  ('${esc(k)}')`).join(",\n");

// ---------- 生成 SQL ----------
const catValues = CATEGORY_SEED.map((c) => `  ('${esc(c.name)}', ${c.sort_order})`).join(",\n");
const tbValues = TB.map((t) => `  ('${t.stage}', '${t.subject}', '${esc(t.version)}', '${esc(t.name)}', ${t.sort_order})`).join(",\n");
const chValues = TB.flatMap((t) =>
  t.chapters.map((c, i) => `  ('${t.stage}', '${t.subject}', '${esc(t.version)}', '${esc(t.name)}', '${esc(c)}', ${(i + 1) * 10})`),
).join(",\n");

const sql = `-- ============================================================
-- 第 7 步：扩展支持 学段 × 科目 × 教材 × 章节
-- 在 Supabase SQL Editor 整段执行（幂等，可重复执行）
-- 前置：0004_feedback_tables.sql 已执行
--
-- 内容：
--   1. 新增 feedback_categories（8 个通用分类，stage 留空 = 全学段通用）
--   2. 新增 feedback_textbooks / feedback_chapters
--   3. feedback_keywords 加 stage / textbook_id / chapter_id / chapter_name
--   4. 现有 470 条统一补 stage='senior'（一条不删，除下面第 6 节的 24 条重名）
--   5. 教材/章节种子（${TB.length} 本 / ${TB.reduce((n, t) => n + t.chapters.length, 0)} 章）
--   6. 删除与章节知识点重名的旧词（先查后删，精确匹配）
--   7. 数学高中人教A版 ${mathABooks.length} 册 ${allTopics.length} 章 → ${chapterKeywordRows.length} 条章节关键词
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
${catValues}
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
${tbValues}
) as v(stage, subject, version, name, sort_order)
where not exists (
  select 1 from public.feedback_textbooks t
  where t.stage = v.stage and t.subject = v.subject
    and t.version = v.version and t.name = v.name
);

insert into public.feedback_chapters (textbook_id, name, sort_order)
select t.id, v.chapter, v.sort_order
from (values
${chValues}
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
${dupValues}
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
${dupValues}
  );

-- ---------- 7. 数学高中人教A版：章节知识点 ----------
-- 每个章节同时作为「课堂内容」与「下节课内容」的关键词
insert into public.feedback_keywords (subject, category, keyword, sort_order, stage, textbook_id, chapter_id, chapter_name)
select v.subject, v.category, v.keyword, v.sort_order, v.stage, c.textbook_id, c.id, c.name
from (values
${chapterKeywordRows.join(",\n")}
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
`;

writeFileSync(OUT, sql, "utf8");

const totalTb = TB.length;
const totalCh = TB.reduce((n, t) => n + t.chapters.length, 0);
console.log(`教材 ${totalTb} 本 | 章节 ${totalCh} 个 | 通用分类 ${CATEGORY_SEED.length} 个`);
console.log(`数学人教A版：${mathABooks.length} 册 / ${allTopics.length} 章 → 章节关键词 ${chapterKeywordRows.length} 条`);
console.log(`待删除重名词：${allTopics.length} 个（去重后 ${new Set(allTopics).size}）`);
console.log(`\n已写入: ${OUT}`);
console.log(`行数 ${sql.split("\n").length} | 大小 ${(Buffer.byteLength(sql, "utf8") / 1024).toFixed(1)} KB`);

const unbalanced = sql.split("\n").filter((l) => ((l.replace(/--.*$/, "").match(/'/g) ?? []).length % 2 !== 0));
console.log("引号检查:", unbalanced.length ? `⚠️ ${unbalanced.length} 行奇数引号` : "✅ 全部成对");
