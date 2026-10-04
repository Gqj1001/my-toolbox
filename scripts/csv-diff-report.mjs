// CSV ↔ 候选表 差异报告（只读，不写数据库）
//
// 用法：
//   node scripts/csv-diff-report.mjs --csv <路径> [--batch ai-20261004-01]
//                                     [--out docs/csv-diff-report.md]
//                                     [--map docs/csv-diff-map.json]
//
// 匹配策略（三级，宁可报"无法匹配"也不猜错）：
//   L1 完整键： stage|subject|version|book|section_name
//   L2 归一化键：章名去掉「元/单元/第X单元」前缀与空格后相等
//   L3 册次内唯一：L1/L2 都失败时，若该册次下「候选行数 = CSV 行数」且其余行已配对，
//                  则按顺序配对（仅当能唯一确定时才用，否则报歧义）
//
// 输出：
//   · 控制台差异报告
//   · Markdown 报告（人看）
//   · JSON 映射文件（apply 脚本用，含每条 CSV 行对应的候选 id 与新旧值）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const CSV_PATH = arg("--csv", "C:/Users/郭庆杰/Desktop/feedback-candidates-ai-20261004-01-pending.csv");
const BATCH = arg("--batch", "ai-20261004-01");
const OUT_MD = arg("--out", "D:/my-website/my-toolbox/docs/csv-diff-report.md");
const OUT_MAP = arg("--map", "D:/my-website/my-toolbox/docs/csv-diff-map.json");
const WRITE = !argv.includes("--no-write"); // 允许 --no-write 只打印

const SUBJ = { 语文: "chinese", 数学: "math", 英语: "english", 物理: "physics", 化学: "chemistry", 生物: "biology", 政治: "politics", 历史: "history", 地理: "geography" };

// ---------- CSV 解析（支持引号内逗号、双引号转义、BOM） ----------
export function parseCsv(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 章名归一化：去掉「元/单元/第X单元」前缀与所有空格，仅用于匹配 */
export function normalizeSection(s) {
  return String(s ?? "")
    .replace(/^\s*元\s+/, "")
    .replace(/^\s*第\s*[一二三四五六七八九十百零\d]+\s*单元\s*/, "")
    .replace(/^\s*单元\s*[一二三四五六七八九十百零\d]*\s*/, "")
    .replace(/\s+/g, "")
    .trim();
}

// ---------- 读取 CSV ----------
let csvText = readFileSync(CSV_PATH, "utf8");
if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);
const table = parseCsv(csvText);
const header = table[0];
const REQUIRED = ["学段", "科目", "教材版本", "册次", "章名", "知识点（用 | 分隔）"];
const missingCols = REQUIRED.filter((c) => !header.includes(c));
if (missingCols.length) {
  console.error("❌ CSV 缺少必需列:", missingCols.join(", "));
  console.error("   实际表头:", header.join(" | "));
  process.exit(1);
}
const ix = {
  stage: header.indexOf("学段"), subject: header.indexOf("科目"), version: header.indexOf("教材版本"),
  book: header.indexOf("册次"), section: header.indexOf("章名"), count: header.indexOf("知识点数"),
  keywords: header.indexOf("知识点（用 | 分隔）"), status: header.indexOf("审核状态"),
  promoted: header.indexOf("是否已提升"), note: header.indexOf("备注"),
};

const csvRows = table.slice(1)
  .filter((r) => r.some((c) => String(c).trim() !== ""))
  .map((r, i) => ({
    line: i + 2,
    stage: r[ix.stage] === "高中" ? "senior" : r[ix.stage] === "初中" ? "junior" : String(r[ix.stage]).trim(),
    subject: SUBJ[String(r[ix.subject]).trim()] ?? String(r[ix.subject]).trim(),
    version: String(r[ix.version]).trim(),
    book: String(r[ix.book]).trim(),
    section: String(r[ix.section]).trim(),
    keywords: String(r[ix.keywords] ?? "").split("|").map((s) => s.trim()).filter(Boolean),
    note: ix.note >= 0 ? String(r[ix.note] ?? "").trim() : "",
  }));

console.log(`CSV: ${CSV_PATH}`);
console.log(`  数据行 ${csvRows.length}（批次 ${BATCH}）`);

// ---------- 读取候选表 ----------
const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const url = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const key = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const db = createClient(url, key, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: info.users.find((u) => u.email.startsWith("rolea-")).email, password: info.password });

const { data: cands, error } = await db
  .from("feedback_section_candidates")
  .select("id, stage, subject, version, book_name, section_name, keywords, status, note, promoted_at")
  .eq("batch_id", BATCH)
  .order("id");
if (error) {
  console.error("❌ 读取候选表失败:", error.code, error.message);
  process.exit(1);
}
console.log(`候选表: ${cands.length} 条`);

// ---------- 匹配 ----------
const keyOf = (o) => `${o.stage}|${o.subject}|${o.version}|${o.book_name ?? o.book}|${o.section_name ?? o.section}`;
const normKeyOf = (o) => `${o.stage}|${o.subject}|${o.version}|${o.book_name ?? o.book}|${normalizeSection(o.section_name ?? o.section)}`;

const dbByFull = new Map();
const dbByNorm = new Map();
for (const c of cands) {
  dbByFull.set(keyOf(c), c);
  const nk = normKeyOf(c);
  if (!dbByNorm.has(nk)) dbByNorm.set(nk, []);
  dbByNorm.get(nk).push(c);
}

const pairs = [];        // { csv, db, level }
const unmatchedCsv = [];
const usedDbIds = new Set();

for (const row of csvRows) {
  // L1
  const c1 = dbByFull.get(keyOf(row));
  if (c1 && !usedDbIds.has(c1.id)) {
    pairs.push({ csv: row, db: c1, level: "L1" });
    usedDbIds.add(c1.id);
    continue;
  }
  // L2
  const candsL2 = (dbByNorm.get(normKeyOf(row)) ?? []).filter((c) => !usedDbIds.has(c.id));
  if (candsL2.length === 1) {
    pairs.push({ csv: row, db: candsL2[0], level: "L2" });
    usedDbIds.add(candsL2[0].id);
    continue;
  }
  if (candsL2.length > 1) {
    unmatchedCsv.push({ row, reason: `L2 命中了 ${candsL2.length} 条，无法确定是哪一个` });
    continue;
  }
  // L3：册次内按顺序配对（仅当该册次下候选数与 CSV 数相等，且已配对数量一致）
  const bookKey = (o) => `${o.stage}|${o.subject}|${o.version}|${o.book_name ?? o.book}`;
  const bk = bookKey(row);
  const dbInBook = cands.filter((c) => bookKey(c) === bk && !usedDbIds.has(c.id));
  const csvInBookRemaining = csvRows.filter((r) => bookKey(r) === bk && !pairs.some((p) => p.csv === r) && !unmatchedCsv.some((u) => u.row === r));
  if (dbInBook.length === 1 && csvInBookRemaining.length === 1) {
    pairs.push({ csv: row, db: dbInBook[0], level: "L3" });
    usedDbIds.add(dbInBook[0].id);
    continue;
  }
  unmatchedCsv.push({ row, reason: `该册次下候选剩 ${dbInBook.length} 条、CSV 剩 ${csvInBookRemaining.length} 条，无法唯一配对` });
}

// 未配对的候选（CSV 里没出现的行）
const unusedDb = cands.filter((c) => !usedDbIds.has(c.id));

// ---------- 差异计算 ----------
const diffs = [];
for (const { csv, db, level } of pairs) {
  const dbKw = Array.isArray(db.keywords) ? db.keywords : [];
  const nameChanged = db.section_name !== csv.section;
  const kwChanged = JSON.stringify(dbKw) !== JSON.stringify(csv.keywords);
  const dbSet = new Set(dbKw), csvSet = new Set(csv.keywords);
  const added = csv.keywords.filter((k) => !dbSet.has(k));
  const removed = dbKw.filter((k) => !csvSet.has(k));
  const reordered = !kwChanged ? false : added.length === 0 && removed.length === 0;
  const noteChanged = (db.note ?? "") !== (csv.note ?? "");
  if (nameChanged || kwChanged || noteChanged) {
    diffs.push({ id: db.id, level, oldSection: db.section_name, newSection: csv.section, nameChanged,
      kwChanged, added, removed, reordered, oldCount: dbKw.length, newCount: csv.keywords.length,
      noteChanged, newNote: csv.note, stage: db.stage, subject: db.subject, version: db.version, book: db.book_name });
  }
}

// ---------- 报告 ----------
const L = [];
const say = (s = "") => { L.push(s); console.log(s); };

say("");
say("==================================================");
say(" CSV ↔ 候选表 差异报告");
say("==================================================");
say(`批次            : ${BATCH}`);
say(`CSV 数据行      : ${csvRows.length}`);
say(`候选表行数      : ${cands.length}`);
say(`成功配对        : ${pairs.length}（L1 精确 ${pairs.filter((p) => p.level === "L1").length} / L2 归一化 ${pairs.filter((p) => p.level === "L2").length} / L3 顺序 ${pairs.filter((p) => p.level === "L3").length}）`);
say(`CSV 未配对      : ${unmatchedCsv.length}`);
say(`候选未被 CSV 覆盖: ${unusedDb.length}（这些行**不会**被改动）`);
say("");
say(`有差异的章      : ${diffs.length}`);
say(`  章名变化      : ${diffs.filter((d) => d.nameChanged).length}`);
say(`  知识点变化    : ${diffs.filter((d) => d.kwChanged).length}`);
say(`  备注变化      : ${diffs.filter((d) => d.noteChanged).length}`);
say(`  完全一致      : ${pairs.length - diffs.length}`);

if (diffs.filter((d) => d.nameChanged).length) {
  say("");
  say("---- 章名差异（前 20 条）----");
  for (const d of diffs.filter((x) => x.nameChanged).slice(0, 20)) {
    say(`  [${d.subject}/${d.book}] "${d.oldSection}"  →  "${d.newSection}"`);
  }
  const moreName = diffs.filter((x) => x.nameChanged).length - 20;
  if (moreName > 0) say(`  … 另有 ${moreName} 条`);
}

if (diffs.filter((d) => d.kwChanged).length) {
  say("");
  say("---- 知识点差异（前 20 条）----");
  for (const d of diffs.filter((x) => x.kwChanged).slice(0, 20)) {
    const tag = d.reordered ? "顺序变化" : `+${d.added.length} / -${d.removed.length}`;
    say(`  [${d.subject}/${d.book}] "${d.newSection}"  ${d.oldCount} → ${d.newCount} 个  (${tag})`);
    if (d.added.length) say(`      新增: ${d.added.slice(0, 6).join(" / ")}${d.added.length > 6 ? ` …+${d.added.length - 6}` : ""}`);
    if (d.removed.length) say(`      删除: ${d.removed.slice(0, 6).join(" / ")}${d.removed.length > 6 ? ` …+${d.removed.length - 6}` : ""}`);
  }
  const moreKw = diffs.filter((x) => x.kwChanged).length - 20;
  if (moreKw > 0) say(`  … 另有 ${moreKw} 条`);
}

if (unmatchedCsv.length) {
  say("");
  say("---- ⚠️ CSV 中无法配对的行（将跳过，不写库）----");
  for (const u of unmatchedCsv.slice(0, 20)) {
    say(`  第${u.row.line}行 [${u.row.subject}/${u.row.book}] "${u.row.section}"  ← ${u.reason}`);
  }
  if (unmatchedCsv.length > 20) say(`  … 另有 ${unmatchedCsv.length - 20} 条`);
}

if (unusedDb.length) {
  say("");
  say(`---- 候选表中未被 CSV 覆盖的行（前 10 条，不会被改动）----`);
  for (const c of unusedDb.slice(0, 10)) say(`  id=${c.id} [${c.subject}/${c.book_name}] "${c.section_name}"`);
  if (unusedDb.length > 10) say(`  … 另有 ${unusedDb.length - 10} 条`);
}

say("");
say("==================================================");
say(" 下一步");
say("==================================================");
say("  确认无误后执行：");
say(`    node scripts/csv-apply-updates.mjs --map "${OUT_MAP}"            # 预演（仍不写库）`);
say(`    node scripts/csv-apply-updates.mjs --map "${OUT_MAP}" --apply  # 真正写库`);
say("");

if (WRITE) {
  const dir = OUT_MD.slice(0, OUT_MD.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OUT_MD, L.join("\n"), "utf8");
  const map = {
    generatedAt: new Date().toISOString(),
    batch: BATCH,
    csvPath: CSV_PATH,
    csvRows: csvRows.length,
    matched: pairs.length,
    diffs: diffs.length,
    updates: diffs.map((d) => ({
      id: d.id,
      section_name: d.newSection,
      keywords: pairs.find((p) => p.db.id === d.id).csv.keywords,
      note: d.newNote || null,
    })),
    skip: unmatchedCsv.map((u) => ({ line: u.row.line, section: u.row.section, reason: u.reason })),
    untouchedCandidateIds: unusedDb.map((c) => c.id),
  };
  writeFileSync(OUT_MAP, JSON.stringify(map, null, 2), "utf8");
  console.log(`已写出报告: ${OUT_MD}`);
  console.log(`已写出映射: ${OUT_MAP}`);
}
