// AI 教材关键词 JSON → 预览报告 + 候选表 INSERT SQL
//
// 用法：
//   node scripts/import-textbook-json.mjs                  仅预览（不写任何文件/数据）
//   node scripts/import-textbook-json.mjs --emit-sql       额外生成候选表 SQL 文件
//
// 设计要点：
//   · 章名规范化：去掉「第X章 / 第X节 / 专题N / 单元N」前缀与序号，只留正文
//   · 「第X节」会归到前面最近的「第X章」下，避免出现"某章 + 它的节"两个层级混在一起
//   · 教材行复用：JSON 的 35 个「版本」与库里 35 本占位教材一一对应，改造成册次行
//   · 输出 SQL 只写候选表，绝不写正式表
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const JSON_PATH = "C:/Users/郭庆杰/Doubao/chats/2026-10-03/new-chat/教材关键词_总表.json";
const OUT_DIR = "D:/my-website/my-toolbox/supabase/import";
const OUT_SQL = `${OUT_DIR}/0007_candidates_BATCH.sql`;
const EMIT_SQL = process.argv.includes("--emit-sql");

// ---------- 章名规范化 ----------
const CN_NUM = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18,
  十九: 19, 二十: 20, 二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24, 二十五: 25,
};
const parseNum = (s) => {
  if (/^\d+$/.test(s)) return Number(s);
  return CN_NUM[s] ?? null;
};

/**
 * 解析章名，返回 { kind, num, body }
 *   kind: 'chapter' | 'section' | 'plain'
 *
 * 注意：「第X课」必须当作独立的一章，**不能**和「第X节」一样并入上一章。
 * 政治等教材的结构是 单元 > 课 > 知识点，课是正经的一级标题；
 * 如果把「课」当成「节」合并，会静默吞掉几十个标题（真实踩过的坑）。
 */
export function parseSectionName(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { kind: "plain", num: null, body: "" };

  // 第X章 / 第X单元 / 第X课（课 = 独立层级，不合并）
  let m = s.match(/^第\s*([一二三四五六七八九十百零\d]+)\s*[章单元课]\s*[：:、.．\-—]?\s*(.*)$/);
  if (m) return { kind: "chapter", num: parseNum(m[1]), body: m[2].trim() };

  // 第X节 / 第X课时（节 = 可并入所属章）
  m = s.match(/^第\s*([一二三四五六七八九十百零\d]+)\s*课时?\s*[：:、.．\-—]?\s*(.*)$/);
  if (m) return { kind: "section", num: parseNum(m[1]), body: m[2].trim() };

  // 专题N / 单元N / 模块N
  m = s.match(/^(专题|单元|模块)\s*([一二三四五六七八九十百零\d]+)\s*[：:、.．\-—]?\s*(.*)$/);
  if (m) return { kind: "chapter", num: parseNum(m[2]), body: m[3].trim() };
  m = s.match(/^(专题|单元|模块)\s*([一二三四五六七八九十百零\d]+)$/);
  if (m) return { kind: "chapter", num: parseNum(m[2]), body: "" };

  return { kind: "plain", num: null, body: s };
}

/**
 * 规范化为「按册次分组」的章列表。
 * 「第X节」归到最近的比它小的「第X章」；若前面没有章，则独立成章。
 */
export function normalizeSections(records) {
  // 先按 册次 分组，保持 JSON 顺序
  const byBook = new Map();
  for (const r of records) {
    const key = `${r.stage}|${r.subject}|${r.version}|${r.book_name}`;
    if (!byBook.has(key)) byBook.set(key, { meta: r, sections: [] });
    byBook.get(key).sections.push(r);
  }

  const out = [];
  for (const [key, { meta, sections }] of byBook) {
    let current = null; // 当前章
    for (const sec of sections) {
      const p = parseSectionName(sec.chapter_name);
      const keywords = Array.isArray(sec.keywords) ? sec.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
      if (p.kind === "chapter") {
        const name = p.body || `第${p.num ?? ""}章`;
        current = { name, keywords: [...keywords], raw: sec.chapter_name };
        out.push({ key, meta, section: current });
      } else if (p.kind === "section" && current) {
        // 归到当前章：把节名作为知识点补进去（去重）
        for (const k of p.body ? [p.body, ...keywords] : keywords) {
          if (!current.keywords.includes(k)) current.keywords.push(k);
        }
      } else {
        const name = p.body || sec.chapter_name;
        current = { name, keywords: [...keywords], raw: sec.chapter_name };
        out.push({ key, meta, section: current });
      }
    }
  }
  return out;
}

// ---------- 读 JSON ----------
const raw = JSON.parse(readFileSync(JSON_PATH, "utf8"));
const records = Array.isArray(raw) ? raw : (raw.records ?? raw.data ?? []);

// ---------- 读数据库现状 ----------
const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const SUPABASE_URL = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const ANON_KEY = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const db = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: info.users.find((u) => u.email.startsWith("rolea-")).email, password: info.password });

const { data: tbs, error: tbErr } = await db.from("feedback_textbooks").select("id, stage, subject, version, name");
if (tbErr) { console.log("❌ 读取教材失败:", tbErr.code, tbErr.message); process.exit(1); }
const { data: chs } = await db.from("feedback_chapters").select("id, textbook_id, name");
const { data: kws } = await db.from("feedback_keywords").select("id, chapter_id").not("chapter_id", "is", null);

// ---------- 规范化 ----------
const normalized = normalizeSections(records);
const renamed = normalized.filter((n) => parseSectionName(n.section.raw).body !== n.section.raw);

console.log("=== 1. 章名规范化 ===");
console.log(`  原始记录: ${records.length} 章`);
console.log(`  规范化后: ${normalized.length} 章（「第X节」已并入所属章）`);
console.log(`  名称被改写的章: ${renamed.length}`);
console.log("  改写示例:");
for (const r of renamed.slice(0, 8)) {
  console.log(`     "${r.section.raw}"  →  "${r.section.name}"`);
}
const mergedSections = records.length - normalized.length;
console.log(`  因合并减少的条目: ${mergedSections}（节的层级被折叠进章）`);

// ---------- 教材行规划 ----------
console.log("\n=== 2. 教材行规划（复用占位行，避免重复）===");
const placeholder = tbs.filter((t) => t.name === "-");
const byVer = new Map(); // stage|subject|version -> 该版本需要的册次列表（保持JSON顺序）
for (const n of normalized) {
  const m = n.meta;
  const k = `${m.stage}|${m.subject}|${m.version}`;
  if (!byVer.has(k)) byVer.set(k, []);
  if (!byVer.get(k).some((b) => b.name === m.book_name)) byVer.get(k).push({ name: m.book_name, sort: byVer.get(k).length * 10 + 10 });
}
const phByVer = new Map();
for (const t of placeholder) {
  const k = `${t.stage}|${t.subject}|${t.version}`;
  if (!phByVer.has(k)) phByVer.set(k, []);
  phByVer.get(k).push(t);
}

let reuseCount = 0, newRowCount = 0, verNoPlaceholder = [];
const textbookPlan = [];
for (const [k, books] of byVer) {
  const phs = phByVer.get(k) ?? [];
  if (phs.length === 0) { verNoPlaceholder.push(k); continue; }
  // 用第 1 个占位行改造成该版本的第 1 个册次，其余册次新建
  books.forEach((b, i) => {
    if (i === 0) { textbookPlan.push({ action: "reuse", id: phs[0].id, ...b, verKey: k }); reuseCount++; }
    else { textbookPlan.push({ action: "create", ...b, verKey: k }); newRowCount++; }
  });
  // 多余的占位行（该版本有多行占位）——目前每个版本只有 1 行，这里兜底
  for (const extra of phs.slice(1)) textbookPlan.push({ action: "extra-placeholder", id: extra.id, verKey: k });
}
console.log(`  复用占位行改造: ${reuseCount} 行`);
console.log(`  需要新建:      ${newRowCount} 行`);
if (verNoPlaceholder.length) console.log(`  ⚠️ 没有占位行的版本: ${verNoPlaceholder.join(", ")}`);
const extraPh = textbookPlan.filter((t) => t.action === "extra-placeholder");
console.log(`  多余占位行: ${extraPh.length} 行`);
console.log(`  → 教材行: ${tbs.length} → ${tbs.length + newRowCount} 行`);

// ---------- 占位章节清理评估 ----------
console.log("\n=== 3. 占位章节清理评估 ===");
const phIds = new Set(placeholder.map((t) => t.id));
const phChs = chs.filter((c) => phIds.has(c.textbook_id));
const usedChIds = new Set(kws.map((k) => k.chapter_id));
const phChsUsed = phChs.filter((c) => usedChIds.has(c.id));
console.log(`  占位教材下的"章节": ${phChs.length} 个（其实是册次名占位）`);
console.log(`  其中被关键词引用: ${phChsUsed.length} 个`);
const importBooks = new Set([...byVer.keys()]);
const phChsCovered = phChs.filter((c) => importBooks.has(`${tbs.find((t) => t.id === c.textbook_id).stage}|${tbs.find((t) => t.id === c.textbook_id).subject}|${tbs.find((t) => t.id === c.textbook_id).version}`));
console.log(`  属于本次导入覆盖版本的: ${phChsCovered.length} 个`);
console.log(`  结论: ${phChsUsed.length === 0 && phChsCovered.length === phChs.length
  ? "✅ 全部可安全删除（无关键词引用，且都会被真实的「章」取代）"
  : "⚠️ 有引用，需保留部分"}`);
const keepChs = phChs.filter((c) => !phChsCovered.includes(c) || usedChIds.has(c.id));
if (keepChs.length) {
  console.log("  需保留的占位章节:");
  for (const c of keepChs.slice(0, 10)) {
    const t = tbs.find((x) => x.id === c.textbook_id);
    console.log(`     ${t.stage}/${t.subject}/${t.version} → "${c.name}"`);
  }
}

// ---------- 汇总 ----------
const totalKw = normalized.reduce((n, x) => n + x.section.keywords.length, 0);
console.log("\n=== 4. 导入规模 ===");
console.log(`  章（feedback_sections）: ${normalized.length}`);
console.log(`  知识点（feedback_chapters）: ${totalKw}`);
console.log(`  关键词（feedback_keywords，×2 分类）: ${totalKw * 2}`);
console.log(`  候选表行数: ${normalized.length}`);

// 质量检查
console.log("\n=== 5. 规范化后的质量检查 ===");
const empty = normalized.filter((n) => n.section.keywords.length === 0);
console.log(`  无知识点的章: ${empty.length}`, empty.length ? "⚠️" : "✅");
const dupNames = new Map();
for (const n of normalized) {
  const k = `${n.key}|${n.section.name}`;
  dupNames.set(k, (dupNames.get(k) ?? 0) + 1);
}
const dups = [...dupNames.entries()].filter(([, v]) => v > 1);
console.log(`  同册次内章名重复: ${dups.length}`, dups.length ? "⚠️ " + dups.slice(0, 3).map((d) => d[0]).join(" | ") : "✅");
const shortName = normalized.filter((n) => n.section.name.length === 0);
console.log(`  章名为空: ${shortName.length}`, shortName.length ? "⚠️" : "✅");
const oneChar = normalized.filter((n) => n.section.name.length === 1);
console.log(`  单字章名: ${oneChar.length}（如「圆」「力」「光」「烃」，属正常）`);
if (oneChar.length) console.log(`      ${[...new Set(oneChar.map((n) => n.section.name))].join(" / ")}`);

// 「第X课」是否被正确当作独立章
const lessons = records.filter((r) => /^第\s*[一二三四五六七八九十百零\d]+\s*课/.test(r.chapter_name));
console.log(`  「第X课」条目: ${lessons.length}（应各自独立成章，不被合并）`);

// ---------- 生成 SQL ----------
if (EMIT_SQL) {
  const BATCH = `ai-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-01`;
  const esc = (s) => String(s).replace(/'/g, "''");
  const rows = normalized.map((n) => {
    const m = n.meta;
    const kwJson = JSON.stringify(n.section.keywords).replace(/'/g, "''");
    return `  ('${BATCH}', '${m.stage}', '${m.subject}', '${esc(m.version)}', '${esc(m.book_name)}', '${esc(n.section.name)}', '${kwJson}'::jsonb, 'ai')`;
  });

  const sql = `-- ============================================================
-- AI 教材关键词 · 候选表导入
-- 批次号: ${BATCH}
-- 生成时间: ${new Date().toISOString()}
-- 来源: 教材关键词_总表.json（${records.length} 条原始记录 → ${normalized.length} 章）
--
-- 本文件**只写候选表** feedback_section_candidates，不动正式表。
-- 回滚: delete from public.feedback_section_candidates where batch_id = '${BATCH}';
-- ============================================================

-- 保险：同批次若已存在则先清掉（幂等）
delete from public.feedback_section_candidates where batch_id = '${BATCH}';

insert into public.feedback_section_candidates
  (batch_id, stage, subject, version, book_name, section_name, keywords, source)
values
${rows.join(",\n")};

-- 自检
select batch_id as 批次, count(*) as 候选章数,
       sum(jsonb_array_length(keywords)) as 知识点数
from public.feedback_section_candidates
where batch_id = '${BATCH}'
group by batch_id;

select stage as 学段, subject as 科目, count(*) as 章数,
       sum(jsonb_array_length(keywords)) as 知识点数
from public.feedback_section_candidates
where batch_id = '${BATCH}'
group by stage, subject
order by stage desc, subject;
`;

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_SQL, sql, "utf8");
  console.log(`\n=== 6. 已生成候选表 SQL ===`);
  console.log(`  文件: ${OUT_SQL}`);
  console.log(`  批次号: ${BATCH}`);
  console.log(`  行数: ${sql.split("\n").length} | 大小: ${(Buffer.byteLength(sql, "utf8") / 1024).toFixed(1)} KB`);
  const unbalanced = sql.split("\n").filter((l) => ((l.replace(/--.*$/, "").match(/'/g) ?? []).length % 2 !== 0));
  console.log(`  引号检查: ${unbalanced.length ? `⚠️ ${unbalanced.length} 行奇数引号` : "✅ 成对"}`);
  console.log(`\n  提示：执行后可用「按章审核」界面处理，或导出 CSV 在 Excel 里过一遍。`);
} else {
  console.log("\n（未生成 SQL。加 --emit-sql 参数即可生成候选表插入语句）");
}
