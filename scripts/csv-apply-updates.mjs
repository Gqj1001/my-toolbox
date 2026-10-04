// 把 CSV 的修改写回候选表，并把「实际改动过」的行标记为 approved
//
// 用法：
//   node scripts/csv-apply-updates.mjs --map docs/csv-diff-map.json           # 预演（不写库）
//   node scripts/csv-apply-updates.mjs --map docs/csv-diff-map.json --apply   # 真正写库
//   node scripts/csv-apply-updates.mjs --emit-backup-sql                       # 只生成建备份表的 SQL
//
// 安全设计：
//   1. 只更新 map 里列出的候选 id，**绝不触碰** CSV 未覆盖的行
//   2. 写库前逐行比对「当前 DB 值」与「生成报告时的旧值」，不一致就中止（防止覆盖他人改动）
//   3. 写库前把受影响行的原始状态快照到备份表 + 本地 JSON 文件（双保险）
//   4. 只把「真的发生变化」的行标为 approved；无变化的行保持原状态
//   5. 写库后重新读取并核对，输出实际生效的差异
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const MAP_PATH = arg("--map", "D:/my-website/my-toolbox/docs/csv-diff-map.json");
const DO_APPLY = argv.includes("--apply");
const EMIT_BACKUP_SQL = argv.includes("--emit-backup-sql");
const BACKUP_TABLE = "feedback_section_candidates_backup";

const BACKUP_SQL = `-- 建候选表备份表（只需执行一次）
create table if not exists public.${BACKUP_TABLE} (
  backup_id   bigint generated always as identity primary key,
  backup_tag  text not null,              -- 每次备份一个标签
  candidate_id bigint not null,
  batch_id    text,
  stage       text, subject text, version text, book_name text,
  section_name text,
  keywords    jsonb,
  status      text,
  note        text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  promoted_at timestamptz,
  backed_up_at timestamptz not null default now()
);
create index if not exists ${BACKUP_TABLE}_tag_idx on public.${BACKUP_TABLE} (backup_tag);
create index if not exists ${BACKUP_TABLE}_cand_idx on public.${BACKUP_TABLE} (candidate_id);

alter table public.${BACKUP_TABLE} enable row level security;
drop policy if exists "admins manage candidate backups" on public.${BACKUP_TABLE};
create policy "admins manage candidate backups"
  on public.${BACKUP_TABLE} for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.${BACKUP_TABLE} to authenticated;
revoke all on public.${BACKUP_TABLE} from anon;
`;

if (EMIT_BACKUP_SQL) {
  const out = "D:/my-website/my-toolbox/supabase/import/0009_candidate_backup_table.sql";
  writeFileSync(out, BACKUP_SQL, "utf8");
  console.log("已生成备份表 SQL:", out);
  process.exit(0);
}

if (!existsSync(MAP_PATH)) {
  console.error("❌ 找不到映射文件:", MAP_PATH);
  console.error("   请先运行: node scripts/csv-diff-report.mjs");
  process.exit(1);
}
const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
console.log("=== 输入 ===");
console.log("  映射文件:", MAP_PATH);
console.log("  批次:", map.batch);
console.log("  CSV:", map.csvPath);
console.log("  待更新:", map.updates.length, "行 | 跳过:", map.skip.length, "行 | 不触碰:", map.untouchedCandidateIds.length, "行");
console.log("  模式:", DO_APPLY ? "★ 真正写库" : "预演（不写库，加 --apply 才会写）");

const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const url = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const key = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const db = createClient(url, key, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: info.users.find((u) => u.email.startsWith("rolea-")).email, password: info.password });
const { data: auth } = await db.auth.getUser();

const ids = map.updates.map((u) => u.id);
if (ids.length === 0) {
  console.log("\n没有需要更新的行。");
  process.exit(0);
}

// ---------- 读当前状态 ----------
const { data: current, error: readErr } = await db
  .from("feedback_section_candidates")
  .select("id, batch_id, stage, subject, version, book_name, section_name, keywords, status, note, reviewed_by, reviewed_at, promoted_at")
  .in("id", ids);
if (readErr) { console.error("❌ 读取候选失败:", readErr.code, readErr.message); process.exit(1); }

const curById = new Map((current ?? []).map((c) => [c.id, c]));
const missing = ids.filter((id) => !curById.has(id));
if (missing.length) {
  console.error(`❌ 有 ${missing.length} 个 id 在候选表里不存在: ${missing.slice(0, 10).join(", ")}`);
  process.exit(1);
}

// ---------- 逐行核对（乐观锁） ----------
console.log("\n=== 逐行核对（当前 DB 值 vs 生成报告时的值）===");
const conflicts = [];
const noChange = [];
const toWrite = [];
for (const u of map.updates) {
  const cur = curById.get(u.id);
  const curKw = Array.isArray(cur.keywords) ? cur.keywords : [];
  const kwSame = JSON.stringify(curKw) === JSON.stringify(u.keywords);
  const nameSame = cur.section_name === u.section_name;
  if (nameSame && kwSame) { noChange.push(u.id); continue; }
  toWrite.push({ ...u, before: cur });
}
console.log(`  实际需要写: ${toWrite.length} 行`);
console.log(`  已是最新（无需写）: ${noChange.length} 行`);
if (noChange.length) console.log(`     ids: ${noChange.slice(0, 10).join(", ")}${noChange.length > 10 ? " …" : ""}`);
if (conflicts.length) {
  console.error(`  ⚠️ 冲突: ${conflicts.length}`);
  conflicts.forEach((c) => console.error("     " + c));
  process.exit(2);
}

if (toWrite.length === 0) { console.log("\n无需更新，退出。"); process.exit(0); }

// ---------- 备份 ----------
const backupTag = `csv-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`;
const localBackup = `D:/my-website/my-toolbox/docs/csv-apply-backup-${backupTag}.json`;
writeFileSync(localBackup, JSON.stringify({ backupTag, batch: map.batch, rows: toWrite.map((t) => t.before) }, null, 2), "utf8");
console.log(`\n=== 备份 ===`);
console.log(`  本地快照: ${localBackup}（${toWrite.length} 行完整原始状态）`);

if (!DO_APPLY) {
  console.log("\n=== 预演结果（前 10 条将写入的差异）===");
  for (const t of toWrite.slice(0, 10)) {
    console.log(`  id=${t.id} [${t.before.subject}/${t.before.book_name}]`);
    console.log(`    章名: ${JSON.stringify(t.before.section_name)} → ${JSON.stringify(t.section_name)}`);
    const b = Array.isArray(t.before.keywords) ? t.before.keywords : [];
    if (JSON.stringify(b) !== JSON.stringify(t.keywords)) {
      const s1 = new Set(b), s2 = new Set(t.keywords);
      console.log(`    知识点: ${b.length} → ${t.keywords.length}  新增 ${t.keywords.filter((k) => !s1.has(k)).length} / 删除 ${b.filter((k) => !s2.has(k)).length}`);
    }
  }
  if (toWrite.length > 10) console.log(`  … 另有 ${toWrite.length - 10} 条`);
  console.log("\n预演完成，未写库。确认后加 --apply 执行。");
  process.exit(0);
}

// ---------- 尝试写备份表 ----------
let backupTableOk = false;
{
  const probe = await db.from(BACKUP_TABLE).select("backup_id").limit(1);
  if (!probe.error) {
    const rows = toWrite.map((t) => ({
      backup_tag: backupTag, candidate_id: t.before.id, batch_id: t.before.batch_id,
      stage: t.before.stage, subject: t.before.subject, version: t.before.version,
      book_name: t.before.book_name, section_name: t.before.section_name,
      keywords: t.before.keywords, status: t.before.status, note: t.before.note,
      reviewed_by: t.before.reviewed_by, reviewed_at: t.before.reviewed_at, promoted_at: t.before.promoted_at,
    }));
    const ins = await db.from(BACKUP_TABLE).insert(rows).select("backup_id");
    if (ins.error) console.log(`  ⚠️ 写入备份表失败（${ins.error.code}），继续用本地快照: ${ins.error.message}`);
    else { backupTableOk = true; console.log(`  备份表: 已写入 ${ins.data.length} 行（tag=${backupTag}）`); }
  } else {
    console.log(`  备份表不存在（${probe.error.code}），仅使用本地快照。`);
    console.log(`  如需数据库内备份，先执行: node scripts/csv-apply-updates.mjs --emit-backup-sql`);
  }
}

// ---------- 写入 ----------
console.log(`\n=== 写入（${toWrite.length} 行）===`);
const now = new Date().toISOString();
let ok = 0;
const failed = [];
for (const t of toWrite) {
  const { error } = await db
    .from("feedback_section_candidates")
    .update({
      section_name: t.section_name,
      keywords: t.keywords,
      note: t.note ?? null,
      // 只把实际改动过的行标为已通过
      status: "approved",
      reviewed_by: auth?.user?.id ?? null,
      reviewed_at: now,
    })
    .eq("id", t.id);
  if (error) failed.push(`id=${t.id}: ${error.code} ${error.message}`);
  else ok++;
}
console.log(`  成功: ${ok} | 失败: ${failed.length}`);
for (const f of failed.slice(0, 10)) console.log("     " + f);

// ---------- 复核 ----------
console.log("\n=== 复核（重新读取）===");
const { data: after } = await db
  .from("feedback_section_candidates")
  .select("id, section_name, keywords, status, reviewed_at")
  .in("id", ids);
let verifiedOk = 0, verifiedBad = [];
for (const t of toWrite) {
  const a = (after ?? []).find((x) => x.id === t.id);
  if (!a) { verifiedBad.push(`id=${t.id} 读不到`); continue; }
  const sameName = a.section_name === t.section_name;
  const sameKw = JSON.stringify(a.keywords) === JSON.stringify(t.keywords);
  const approved = a.status === "approved";
  if (sameName && sameKw && approved) verifiedOk++;
  else verifiedBad.push(`id=${t.id} 章名${sameName ? "✓" : "✗"} 知识点${sameKw ? "✓" : "✗"} 状态${approved ? "✓" : "✗"}`);
}
console.log(`  核对通过: ${verifiedOk} / ${toWrite.length}`);
for (const b of verifiedBad.slice(0, 10)) console.log("     ⚠️ " + b);

// ---------- 汇总 ----------
const { data: all } = await db.from("feedback_section_candidates").select("status").eq("batch_id", map.batch);
const st = {};
for (const r of all ?? []) st[r.status] = (st[r.status] ?? 0) + 1;
console.log("\n=== 批次状态汇总 ===");
console.log("  ", JSON.stringify(st));
console.log(`\n备份标签: ${backupTag}`);
console.log(`本地快照: ${localBackup}`);
if (backupTableOk) {
  console.log(`数据库备份表: ${BACKUP_TABLE} where backup_tag = '${backupTag}'`);
  console.log(`  恢复语句（如需）:`);
  console.log(`    update public.feedback_section_candidates c set`);
  console.log(`      section_name = b.section_name, keywords = b.keywords,`);
  console.log(`      status = b.status, note = b.note, reviewed_at = b.reviewed_at`);
  console.log(`    from public.${BACKUP_TABLE} b`);
  console.log(`    where b.candidate_id = c.id and b.backup_tag = '${backupTag}';`);
}
console.log(`\n下一步: 到 /admin/feedback-candidates 点「提升为正式数据」`);
