// 最终汇总：表行数、备份状态、批次状态
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BATCH = "ai-20261004-01";
const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const url = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const key = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const db = createClient(url, key, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: info.users.find((u) => u.email.startsWith("rolea-")).email, password: info.password });

const count = async (t, tune) => { let q = db.from(t).select("*", { count: "exact", head: true }); if (tune) q = tune(q); const { count: c } = await q; return c; };

console.log("=== 最终表行数 ===");
const tables = {
  feedback_textbooks: await count("feedback_textbooks"),
  feedback_sections: await count("feedback_sections"),
  feedback_chapters: await count("feedback_chapters"),
  feedback_keywords: await count("feedback_keywords"),
  feedback_categories: await count("feedback_categories"),
  feedback_phrases: await count("feedback_phrases"),
  feedback_students: await count("feedback_students"),
  feedback_history: await count("feedback_history"),
  feedback_section_candidates: await count("feedback_section_candidates"),
  feedback_section_candidates_backup: await count("feedback_section_candidates_backup"),
};
for (const [k, v] of Object.entries(tables)) console.log(`  ${k.padEnd(36)} ${String(v).padStart(6)}`);

console.log("\n=== 本批次归属 ===");
console.log("  知识点 (import_batch_id)", await count("feedback_chapters", (q) => q.eq("import_batch_id", BATCH)));
console.log("  关键词 (import_batch_id)", await count("feedback_keywords", (q) => q.eq("import_batch_id", BATCH)));

console.log("\n=== 未归档关键词（工具页可见）===");
console.log("  总数", await count("feedback_keywords", (q) => q.is("archived_at", null)));
console.log("  已归档", await count("feedback_keywords", (q) => q.not("archived_at", "is", null)));

console.log("\n=== 候选状态 ===");
const { data: cands } = await db.from("feedback_section_candidates").select("status, promoted_at").eq("batch_id", BATCH).limit(2000);
const st = {}; let promoted = 0;
for (const c of cands ?? []) { st[c.status] = (st[c.status] ?? 0) + 1; if (c.promoted_at) promoted++; }
console.log("  ", JSON.stringify(st), "| 已提升", promoted, "/", cands?.length);

console.log("\n=== 备份记录（可用于回滚）===");
const { data: baks } = await db.from("feedback_section_candidates_backup").select("backup_tag, backed_up_at").limit(2000);
const tags = {};
for (const b of baks ?? []) tags[b.backup_tag] = (tags[b.backup_tag] ?? 0) + 1;
for (const [t, n] of Object.entries(tags)) console.log(`  ${t}: ${n} 行`);
if (!Object.keys(tags).length) console.log("  (无)");

console.log("\n=== 人教A版完整性（关键）===");
const { data: aTb } = await db.from("feedback_textbooks").select("id, name").eq("version", "人教A版");
console.log("  教材册数:", aTb.length);
const aIds = aTb.map((t) => t.id);
let aCh = 0;
for (const id of aIds) aCh += await count("feedback_chapters", (q) => q.eq("textbook_id", id));
console.log("  知识点数:", aCh, aCh === 94 ? "✅ 未变" : "⚠️");
console.log("  带章节关键词（未归档）:", await count("feedback_keywords", (q) => q.not("chapter_id", "is", null).is("archived_at", null)) - await count("feedback_keywords", (q) => q.eq("import_batch_id", BATCH)) + 0, "（含本批次；人教A版自身为 188）");

console.log("\n=== 占位章节（0008 待清理）===");
console.log("  占位教材数:", await count("feedback_textbooks", (q) => q.eq("name", "-")));
console.log("  占位教材下未被本批次标记的章节:", await count("feedback_chapters", (q) => q.is("import_batch_id", null)));
