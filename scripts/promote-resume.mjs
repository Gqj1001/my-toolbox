// 步骤⑥ 续跑 v2：修正「PostgREST 默认 1000 行上限导致读取被静默截断」的缺陷
//   · 所有 select 都分页（fetchAll 辅助函数）
//   · 关键词键一次性读全，插入时既查 Set 也回写 Set（幂等）
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BATCH = "ai-20261004-01";
const APPLY = process.argv.includes("--apply");

const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const url = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const key = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const db = createClient(url, key, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: info.users.find((u) => u.email.startsWith("rolea-")).email, password: info.password });

/** 分页读取全表（PostgREST 默认最多返回 1000 行，必须自己翻页） */
async function fetchAll(table, columns, tune) {
  const out = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    let q = db.from(table).select(columns).order("id").range(from, from + PAGE - 1);
    if (tune) q = tune(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} 读取失败: ${error.code} ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function count(table, tune) {
  let q = db.from(table).select("*", { count: "exact", head: true });
  if (tune) q = tune(q);
  const { count: c, error } = await q;
  return error ? `ERR:${error.code}` : c;
}

console.log("=== 读取（分页）===");
const tbs = await fetchAll("feedback_textbooks", "id, stage, subject, version, name");
const secs = await fetchAll("feedback_sections", "id, textbook_id, name");
const chs = await fetchAll("feedback_chapters", "id, textbook_id, name");
console.log(`教材 ${tbs.length} | 章 ${secs.length} | 知识点 ${chs.length}`);

const cands = [];
{
  const PAGE = 500;
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from("feedback_section_candidates")
      .select("id, stage, subject, version, book_name, section_name, keywords, promoted_at")
      .eq("batch_id", BATCH).eq("status", "approved").order("id").range(from, from + PAGE - 1);
    if (error) { console.error("读取候选失败:", error.code, error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    cands.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
}
console.log(`approved 候选: ${cands.length}`);

const tbByKey = new Map(tbs.map((t) => [`${t.stage}|${t.subject}|${t.version}|${t.name}`, t.id]));
const chByKey = new Map(chs.map((c) => [`${c.textbook_id}|${c.name}`, c.id]));
const bookKey = (c) => `${c.stage}|${c.subject}|${c.version}|${c.book_name}`;

// ---------- 期望关键词（批内去重） ----------
const wanted = new Map();
let dupInBatch = 0, missingChapter = 0;
for (const c of cands) {
  const tbId = tbByKey.get(bookKey(c));
  if (!tbId) continue;
  const list = Array.isArray(c.keywords) ? c.keywords : [];
  list.forEach((raw, i) => {
    const name = String(raw).trim();
    if (!name) return;
    const chId = chByKey.get(`${tbId}|${name}`);
    if (!chId) { missingChapter++; return; }
    for (const category of ["课堂内容", "下节课内容"]) {
      const k = `${c.subject}|${category}|${chId}|${name}`;
      if (wanted.has(k)) { dupInBatch++; continue; }
      wanted.set(k, {
        subject: c.subject, category, keyword: name, sort_order: (i + 1) * 10,
        stage: c.stage, textbook_id: tbId, chapter_id: chId, chapter_name: c.section_name,
        import_batch_id: BATCH,
      });
    }
  });
}
console.log(`\n期望关键词（去重后）: ${wanted.size} | 批内重复合并: ${dupInBatch} | 找不到知识点: ${missingChapter}`);

// ---------- 已存在的键（分页读全） ----------
const existKeys = new Set();
{
  const rows = await fetchAll("feedback_keywords", "subject, category, chapter_id, keyword", (q) => q.not("chapter_id", "is", null));
  for (const r of rows) existKeys.add(`${r.subject}|${r.category}|${r.chapter_id}|${r.keyword}`);
  console.log(`已存在（带 chapter_id）: ${existKeys.size}`);
}

const toInsert = [...wanted.entries()].filter(([k]) => !existKeys.has(k)).map(([, v]) => v);
console.log(`需要新增: ${toInsert.length}`);

if (!APPLY) { console.log("\n预演模式（加 --apply 才写库）"); process.exit(0); }

// ---------- 插入 ----------
let ok = 0;
const failed = [];
for (let i = 0; i < toInsert.length; i += 200) {
  const chunk = toInsert.slice(i, i + 200).filter((r) => {
    const k = `${r.subject}|${r.category}|${r.chapter_id}|${r.keyword}`;
    if (existKeys.has(k)) return false;
    existKeys.add(k);
    return true;
  });
  if (chunk.length === 0) continue;
  const { data, error } = await db.from("feedback_keywords").insert(chunk).select("id");
  if (error) failed.push(`块 ${i / 200 + 1}: ${error.code} ${error.message}`);
  else ok += (data ?? []).length;
  process.stdout.write(`\r  已写 ${ok}/${toInsert.length}`);
}
console.log("");

// ---------- 标记已提升 ----------
const promotedIds = cands.filter((c) => !c.promoted_at).map((c) => c.id);
if (promotedIds.length) {
  const now = new Date().toISOString();
  let marked = 0;
  for (let i = 0; i < promotedIds.length; i += 200) {
    const { error } = await db.from("feedback_section_candidates").update({ promoted_at: now }).in("id", promotedIds.slice(i, i + 200));
    if (error) console.error("  标记失败:", error.code, error.message);
    else marked += Math.min(200, promotedIds.length - i);
  }
  console.log(`已标记 ${marked} 条候选为已提升`);
}

// ---------- 复核 ----------
const after = {
  sections: await count("feedback_sections"),
  chapters: await count("feedback_chapters"),
  keywords: await count("feedback_keywords"),
  textbooks: await count("feedback_textbooks"),
  batchChapters: await count("feedback_chapters", (q) => q.eq("import_batch_id", BATCH)),
  batchKeywords: await count("feedback_keywords", (q) => q.eq("import_batch_id", BATCH)),
  pendingPromote: await count("feedback_section_candidates", (q) => q.eq("batch_id", BATCH).is("promoted_at", null)),
};
console.log("\n=== 复核 ===");
console.log(JSON.stringify(after, null, 1));
console.log("  写入成功:", ok, "| 失败块:", failed.length);
for (const f of failed.slice(0, 5)) console.log("     " + f);
writeFileSync("D:/my-website/my-toolbox/docs/promote-resume.json", JSON.stringify({ after, ok, failed }, null, 2), "utf8");
