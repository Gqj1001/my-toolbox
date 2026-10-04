// 生成 0006_textbook_version.sql：教材改为「版本 + 册次」两级
// 设计：按 id 逐条精确更新（不用启发式 SQL 猜），安全且幂等
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const OUT = "D:/my-website/my-toolbox/supabase/migrations/0006_textbook_version.sql";

const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const url = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const key = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const adminEmail = info.users.find((u) => u.email.startsWith("rolea-")).email;

const db = createClient(url, key, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: adminEmail, password: info.password });
const { data: rows, error } = await db
  .from("feedback_textbooks")
  .select("id, stage, subject, name, sort_order")
  .order("id");
if (error) { console.log("读取教材失败:", error.code, error.message); process.exit(1); }
console.log("读到教材:", rows.length, "本");

// 已知版本名：长的排前面，避免 "人教版" 抢掉 "人教A版"
const KNOWN = ["人教A版", "人教B版", "北师大版", "苏教版", "苏科版", "湘教版", "教科版", "鲁科版", "译林版", "外研版", "人教版", "统编版"];
function split(raw) {
  const s = String(raw).trim();
  for (const v of KNOWN) {
    if (s === v) return { version: v, name: "-" };
    if (s.startsWith(v + " ")) return { version: v, name: s.slice(v.length + 1).trim() };
  }
  const sp = s.indexOf(" ");
  if (sp > 0) return { version: s.slice(0, sp), name: s.slice(sp + 1).trim() };
  return { version: s, name: "-" };
}

const parsed = rows.map((r) => ({ ...r, ...split(r.name) }));

// 唯一性检查（stage, subject, version, name）
const seen = new Map();
let dup = 0;
for (const p of parsed) {
  const k = `${p.stage}|${p.subject}|${p.version}|${p.name}`;
  if (seen.has(k)) { dup++; console.log("  ⚠️ 重复:", k, "ids:", seen.get(k), p.id); }
  seen.set(k, p.id);
}
console.log(`拆分后 (stage,subject,version,name) 唯一性: ${dup === 0 ? "✅ 无重复" : `❌ ${dup} 组重复`}`);
if (dup > 0) { console.log("存在重复，需要人工调整后再生成"); process.exit(1); }

const esc = (s) => String(s).replace(/'/g, "''");
console.log("\n拆分结果（前 8 条）:");
for (const p of parsed.slice(0, 8)) {
  console.log(`  id=${String(p.id).padEnd(3)} ${p.stage}/${p.subject}  version="${p.version}"  name="${p.name}"`);
}

const byKey = {};
for (const p of parsed) {
  const k = `${p.stage}/${p.subject}`;
  byKey[k] ??= new Map();
  const arr = byKey[k].get(p.version) ?? [];
  arr.push(p.name);
  byKey[k].set(p.version, arr);
}
console.log("\n拆分后结构:");
for (const [k, versions] of Object.entries(byKey).sort()) {
  const parts = [...versions.entries()].map(([v, names]) => `${v}[${names.length}]`);
  console.log(`  ${k}: ${parts.join(" ")}`);
}

// 逐 id 的 update 语句（精确、幂等）
const updates = parsed
  .map((p) => `update public.feedback_textbooks set version = '${esc(p.version)}', name = '${esc(p.name)}' where id = ${p.id};`)
  .join("\n");

const sql = `-- ============================================================
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

-- ---------- 3. 逐本拆分（按 id，共 ${parsed.length} 本）----------
${updates}

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
`;

writeFileSync(OUT, sql, "utf8");
console.log(`\n已写入: ${OUT}`);
console.log(`行数 ${sql.split("\n").length} | 大小 ${(Buffer.byteLength(sql, "utf8") / 1024).toFixed(1)} KB`);
const unbalanced = sql.split("\n").filter((l) => ((l.replace(/--.*$/, "").match(/'/g) ?? []).length % 2 !== 0));
console.log("引号检查:", unbalanced.length ? `⚠️ ${unbalanced.length} 行奇数引号` : "✅ 全部成对");
const updateCount = (sql.match(/^update public\.feedback_textbooks set version = /gm) ?? []).length;
console.log(`逐条 update 语句: ${updateCount} 条`, updateCount === parsed.length ? "✅" : "⚠️");
