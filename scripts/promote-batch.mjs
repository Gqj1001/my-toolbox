// 步骤⑥：把 approved 候选提升为正式数据
// 与 src/app/admin/feedback-candidates/actions.ts 的 promoteApproved 逻辑一致，
// 但做了改动：批量插入 + 前后基线对比（用于验证不破坏既有数据）
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BATCH = "ai-20261004-01";
const APPLY = process.argv.includes("--apply");
const BASELINE_OUT = "D:/my-website/my-toolbox/docs/promote-baseline.json";

const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const url = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const key = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const db = createClient(url, key, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: info.users.find((u) => u.email.startsWith("rolea-")).email, password: info.password });

const count = async (table, build) => {
  let q = db.from(table).select("*", { count: "exact", head: true });
  if (build) q = build(q);
  const { count: c, error } = await q;
  return error ? `ERR:${error.code}` : c;
};

// ---------- 基线 ----------
const baseline = {
  at: new Date().toISOString(),
  sections: await count("feedback_sections"),
  chapters: await count("feedback_chapters"),
  keywords: await count("feedback_keywords"),
  keywordsArchived: await count("feedback_keywords", (q) => q.not("archived_at", "is", null)),
  textbooks: await count("feedback_textbooks"),
  aChapters: await count("feedback_chapters", (q) => q.eq("textbook_id", 1)),
  aKeywordsWithChapter: await count("feedback_keywords", (q) => q.not("chapter_id", "is", null)),
  batchRows: await count("feedback_chapters", (q) => q.eq("import_batch_id", BATCH)),
};
console.log("=== 提升前基线 ===");
console.log(JSON.stringify(baseline, null, 1));
writeFileSync(BASELINE_OUT, JSON.stringify(baseline, null, 2), "utf8");

// ---------- 候选 ----------
const cands = [];
{
  let from = 0;
  while (true) {
    const { data, error } = await db
      .from("feedback_section_candidates")
      .select("id, stage, subject, version, book_name, section_name, keywords, promoted_at")
      .eq("batch_id", BATCH)
      .eq("status", "approved")
      .order("id")
      .range(from, from + 499);
    if (error) { console.error("读取候选失败:", error.code, error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    cands.push(...data);
    if (data.length < 500) break;
    from += 500;
  }
}
const todo = cands.filter((c) => !c.promoted_at);
console.log(`\napproved 候选: ${cands.length} | 未提升: ${todo.length} | 已提升: ${cands.length - todo.length}`);
if (!APPLY) { console.log("\n预演模式（加 --apply 才写库）"); process.exit(0); }
if (todo.length === 0) { console.log("没有需要提升的行。"); process.exit(0); }

// ---------- 1) 教材行 ----------
const bookKey = (c) => `${c.stage}|${c.subject}|${c.version}|${c.book_name}`;
const bookPlan = new Map(); // key -> {stage,subject,version,name}
for (const c of todo) bookPlan.set(bookKey(c), { stage: c.stage, subject: c.subject, version: c.version, name: c.book_name });

const { data: existTb } = await db.from("feedback_textbooks").select("id, stage, subject, version, name");
const tbByKey = new Map((existTb ?? []).map((t) => [`${t.stage}|${t.subject}|${t.version}|${t.name}`, t.id]));
const newBooks = [...bookPlan.entries()].filter(([k]) => !tbByKey.has(k));
console.log(`\n=== 1) 教材行 ===`);
console.log(`  需要: ${bookPlan.size} | 已存在: ${bookPlan.size - newBooks.length} | 新建: ${newBooks.length}`);
if (newBooks.length) {
  const rows = newBooks.map(([, b]) => ({ ...b, sort_order: 0 }));
  const { data, error } = await db.from("feedback_textbooks").insert(rows).select("id, stage, subject, version, name");
  if (error) { console.error("  建教材失败:", error.code, error.message); process.exit(1); }
  for (const t of data ?? []) tbByKey.set(`${t.stage}|${t.subject}|${t.version}|${t.name}`, t.id);
  console.log(`  已建 ${data?.length} 行`);
}

// ---------- 2) 章 ----------
const { data: existSec } = await db.from("feedback_sections").select("id, textbook_id, name");
const secByKey = new Map((existSec ?? []).map((s) => [`${s.textbook_id}|${s.name}`, s.id]));
const secPlan = new Map();
for (const c of todo) {
  const tbId = tbByKey.get(bookKey(c));
  if (!tbId) { console.error("找不到教材行:", bookKey(c)); process.exit(1); }
  secPlan.set(`${tbId}|${c.section_name}`, { textbook_id: tbId, name: c.section_name });
}
const newSecs = [...secPlan.entries()].filter(([k]) => !secByKey.has(k));
console.log(`\n=== 2) 章 ===`);
console.log(`  需要: ${secPlan.size} | 已存在: ${secPlan.size - newSecs.length} | 新建: ${newSecs.length}`);
if (newSecs.length) {
  const rows = newSecs.map(([, s], i) => ({ ...s, sort_order: (i + 1) * 10 }));
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data, error } = await db.from("feedback_sections").insert(chunk).select("id, textbook_id, name");
    if (error) { console.error(`  建章失败（块 ${i / 500 + 1}）:`, error.code, error.message); process.exit(1); }
    for (const s of data ?? []) secByKey.set(`${s.textbook_id}|${s.name}`, s.id);
    process.stdout.write(`\r  已建 ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }
  console.log("");
}

// ---------- 3) 知识点 + 关键词 ----------
console.log(`\n=== 3) 知识点 / 关键词 ===`);
const { data: existCh } = await db.from("feedback_chapters").select("id, textbook_id, name");
const chByKey = new Map((existCh ?? []).map((c) => [`${c.textbook_id}|${c.name}`, c.id]));

const chPlan = new Map(); // key -> {textbook_id, section_id, name, batch}
const kwPlan = [];        // 关键词行
for (const c of todo) {
  const tbId = tbByKey.get(bookKey(c));
  const secId = secByKey.get(`${tbId}|${c.section_name}`);
  const list = Array.isArray(c.keywords) ? c.keywords : [];
  list.forEach((raw, i) => {
    const name = String(raw).trim();
    if (!name) return;
    const k = `${tbId}|${name}`;
    if (!chPlan.has(k)) chPlan.set(k, { textbook_id: tbId, section_id: secId, name, sort_order: (i + 1) * 10 });
    // 两个分类各一行
    for (const category of ["课堂内容", "下节课内容"]) {
      kwPlan.push({
        subject: c.subject, category, keyword: name, sort_order: (i + 1) * 10,
        stage: c.stage, textbook_id: tbId, chapter_id: null, chapter_name: c.section_name,
        import_batch_id: BATCH, _chKey: k,
      });
    }
  });
}
const newChs = [...chPlan.entries()].filter(([k]) => !chByKey.has(k));
console.log(`  知识点: 需要 ${chPlan.size} | 已存在 ${chPlan.size - newChs.length} | 新建 ${newChs.length}`);
if (newChs.length) {
  const rows = newChs.map(([, c]) => ({ ...c, import_batch_id: BATCH }));
  for (let i = 0; i < rows.length; i += 300) {
    const chunk = rows.slice(i, i + 300);
    const { data, error } = await db.from("feedback_chapters").insert(chunk).select("id, textbook_id, name");
    if (error) { console.error(`  建知识点失败（块 ${i / 300 + 1}）:`, error.code, error.message); process.exit(1); }
    for (const c of data ?? []) chByKey.set(`${c.textbook_id}|${c.name}`, c.id);
    process.stdout.write(`\r  已建知识点 ${Math.min(i + 300, rows.length)}/${rows.length}`);
  }
  console.log("");
}

// 回填 chapter_id
const { data: kwExist } = await db.from("feedback_keywords").select("subject, category, chapter_id, keyword").not("chapter_id", "is", null);
const kwExistSet = new Set((kwExist ?? []).map((k) => `${k.subject}|${k.category}|${k.chapter_id}|${k.keyword}`));

const kwRows = [];
for (const k of kwPlan) {
  const chId = chByKey.get(k._chKey);
  if (!chId) continue;
  if (kwExistSet.has(`${k.subject}|${k.category}|${chId}|${k.keyword}`)) continue;
  const { _chKey, ...rest } = k;
  kwRows.push({ ...rest, chapter_id: chId });
}
console.log(`  关键词: 需写入 ${kwRows.length}（已存在则跳过）`);
let kwOk = 0;
for (let i = 0; i < kwRows.length; i += 300) {
  const chunk = kwRows.slice(i, i + 300);
  const { data, error } = await db.from("feedback_keywords").insert(chunk).select("id");
  if (error) { console.error(`\n  写关键词失败（块 ${i / 300 + 1}）:`, error.code, error.message); process.exit(1); }
  kwOk += (data ?? []).length;
  process.stdout.write(`\r  已写关键词 ${kwOk}/${kwRows.length}`);
}
console.log("");

// ---------- 4) 标记已提升 ----------
const promotedIds = todo.map((c) => c.id);
const now = new Date().toISOString();
for (let i = 0; i < promotedIds.length; i += 300) {
  const chunk = promotedIds.slice(i, i + 300);
  const { error } = await db.from("feedback_section_candidates").update({ promoted_at: now }).in("id", chunk);
  if (error) console.error("  标记已提升失败:", error.code, error.message);
}
console.log(`  已标记 ${promotedIds.length} 条候选为已提升`);

// ---------- 5) 复核 ----------
const after = {
  at: new Date().toISOString(),
  sections: await count("feedback_sections"),
  chapters: await count("feedback_chapters"),
  keywords: await count("feedback_keywords"),
  keywordsArchived: await count("feedback_keywords", (q) => q.not("archived_at", "is", null)),
  textbooks: await count("feedback_textbooks"),
  aChapters: await count("feedback_chapters", (q) => q.eq("textbook_id", 1)),
  aKeywordsWithChapter: await count("feedback_keywords", (q) => q.not("chapter_id", "is", null)),
  batchChapters: await count("feedback_chapters", (q) => q.eq("import_batch_id", BATCH)),
  batchKeywords: await count("feedback_keywords", (q) => q.eq("import_batch_id", BATCH)),
  pendingPromote: await count("feedback_section_candidates", (q) => q.eq("batch_id", BATCH).is("promoted_at", null)),
};
console.log("\n=== 提升后 ===");
console.log(JSON.stringify(after, null, 1));
console.log("\n=== 前后对比 ===");
for (const k of Object.keys(after)) {
  if (k === "at") continue;
  const b = baseline[k];
  const a = after[k];
  if (typeof a === "number" && typeof b === "number") {
    console.log(`  ${k.padEnd(22)} ${String(b).padStart(6)} → ${String(a).padStart(6)}  (${a - b >= 0 ? "+" : ""}${a - b})`);
  }
}
writeFileSync("D:/my-website/my-toolbox/docs/promote-after.json", JSON.stringify({ baseline, after }, null, 2), "utf8");
