// 步骤⑥ 后置一致性检查：原创性、重复、孤立、批次归属
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BATCH = "ai-20261004-01";
const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const url = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const key = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const db = createClient(url, key, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: info.users.find((u) => u.email.startsWith("rolea-")).email, password: info.password });

async function fetchAll(table, columns, tune) {
  const out = []; const PAGE = 1000; let from = 0;
  for (;;) {
    let q = db.from(table).select(columns).order("id").range(from, from + PAGE - 1);
    if (tune) q = tune(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.code} ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}
const results = [];
const rec = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`); };

console.log("=== 全量读取（分页）===");
const tbs = await fetchAll("feedback_textbooks", "id, stage, subject, version, name");
const secs = await fetchAll("feedback_sections", "id, textbook_id, name");
const chs = await fetchAll("feedback_chapters", "id, textbook_id, section_id, name, import_batch_id");
const kws = await fetchAll("feedback_keywords", "id, subject, category, stage, textbook_id, chapter_id, keyword, archived_at, import_batch_id");
console.log(`教材 ${tbs.length} | 章 ${secs.length} | 知识点 ${chs.length} | 关键词 ${kws.length}`);

// 1. 原有人教A版是否被破坏（必须完全不变）
const A = tbs.filter((t) => t.version === "人教A版");
const aCh = chs.filter((c) => A.some((t) => t.id === c.textbook_id));
const aKw = kws.filter((k) => k.chapter_id && aCh.some((c) => c.id === k.chapter_id));
rec("人教A版教材 6 册", A.length === 6, `${A.length}`);
rec("人教A版知识点 94 个不变", aCh.length === 94, `${aCh.length}`);
rec("人教A版带章节关键词 188 条不变（未归档）", aKw.filter((k) => !k.archived_at).length === 188, `${aKw.filter((k) => !k.archived_at).length}`);
rec("人教A版知识点均未被标记为本批次", aCh.every((c) => !c.import_batch_id), `有批次的: ${aCh.filter((c) => c.import_batch_id).length}`);

// 2. 批次归属
const batchCh = chs.filter((c) => c.import_batch_id === BATCH);
const batchKw = kws.filter((k) => k.import_batch_id === BATCH);
rec("本批次知识点 4179", batchCh.length === 4179, `${batchCh.length}`);
rec("本批次关键词 8358", batchKw.length === 8358, `${batchKw.length}`);
rec("本批次关键词全部带 chapter_id", batchKw.every((k) => k.chapter_id), `缺 chapter_id 的: ${batchKw.filter((k) => !k.chapter_id).length}`);

// 3. 重复检测
const dupKey = new Map();
for (const k of kws) {
  if (!k.chapter_id) continue;
  const kk = `${k.subject}|${k.category}|${k.chapter_id}|${k.keyword}`;
  dupKey.set(kk, (dupKey.get(kk) ?? 0) + 1);
}
const dups = [...dupKey.entries()].filter(([, v]) => v > 1);
rec("关键词无重复（subject|category|chapter|keyword）", dups.length === 0, `${dups.length} 组重复`);

// 4. 孤立引用
const tbIds = new Set(tbs.map((t) => t.id));
const secIds = new Set(secs.map((s) => s.id));
const chIds = new Set(chs.map((c) => c.id));
rec("无孤立章（textbook 不存在）", secs.every((s) => tbIds.has(s.textbook_id)), "");
rec("无孤立知识点（textbook 不存在）", chs.every((c) => tbIds.has(c.textbook_id)), "");
rec("无孤立知识点（section 不存在）", chs.every((c) => !c.section_id || secIds.has(c.section_id)), "");
rec("无孤立关键词（chapter 不存在）", kws.every((k) => !k.chapter_id || chIds.has(k.chapter_id)), "");
rec("无孤立关键词（textbook 不存在）", kws.every((k) => !k.textbook_id || tbIds.has(k.textbook_id)), "");

// 5. 两个分类成对
const pairKey = new Map();
for (const k of batchKw) {
  const kk = `${k.subject}|${k.chapter_id}|${k.keyword}`;
  const set = pairKey.get(kk) ?? new Set();
  set.add(k.category);
  pairKey.set(kk, set);
}
const notPaired = [...pairKey.values()].filter((s) => s.size !== 2);
rec("本批次关键词在两个内容分类成对出现", notPaired.length === 0, `${notPaired.length} 组不成对`);

// 6. 归档词未被本批次误动
const archivedBatch = kws.filter((k) => k.archived_at && k.import_batch_id === BATCH);
rec("本批次没有已归档的行", archivedBatch.length === 0, `${archivedBatch.length}`);
const archivedTotal = kws.filter((k) => k.archived_at).length;
rec("归档词仍为 24 条（0005 遗留）", archivedTotal === 24, `${archivedTotal}`);

// 7. 占位教材的册次名占位章节是否还在（0008 未执行，应仍在）
const phIds = new Set(tbs.filter((t) => t.name === "-").map((t) => t.id));
const phChs = chs.filter((c) => phIds.has(c.textbook_id) && !c.import_batch_id);
rec("0008 未执行：占位章节仍存在（约178）", phChs.length >= 170, `${phChs.length}`);

// 8. 候选全部已提升
const cands = await fetchAll("feedback_section_candidates", "id, status, promoted_at", (q) => q.eq("batch_id", BATCH));
rec("候选全部 approved", cands.every((c) => c.status === "approved"), `非 approved: ${cands.filter((c) => c.status !== "approved").length}`);
rec("候选全部已提升", cands.every((c) => c.promoted_at), `未提升: ${cands.filter((c) => !c.promoted_at).length}`);

// 9. 分布抽样
console.log("\n=== 各科目章/知识点/关键词数（本批次）===");
const secTb = new Map(secs.map((s) => [s.id, s.textbook_id]));
const tbById = new Map(tbs.map((t) => [t.id, t]));
const bySubj = {};
for (const c of batchCh) {
  const t = tbById.get(c.textbook_id);
  const k = `${t.stage}/${t.subject}`;
  bySubj[k] ??= { ch: 0, kw: 0 };
  bySubj[k].ch++;
}
for (const k of batchKw) {
  const t = tbById.get(k.textbook_id);
  if (!t) continue;
  const kk = `${t.stage}/${t.subject}`;
  bySubj[kk] ??= { ch: 0, kw: 0 };
  bySubj[kk].kw++;
}
for (const [k, v] of Object.entries(bySubj).sort()) {
  console.log(`  ${k.padEnd(18)} 知识点 ${String(v.ch).padStart(4)}  关键词 ${String(v.kw).padStart(4)}`);
}

console.log("\n=== 高中化学（清单第3项）===");
const chemTb = tbs.filter((t) => t.stage === "senior" && t.subject === "chemistry");
for (const t of chemTb.slice(0, 3)) {
  const c = secs.filter((s) => s.textbook_id === t.id);
  const k = kws.filter((x) => x.textbook_id === t.id && !x.archived_at);
  console.log(`  ${t.version} / ${t.name}: ${c.length} 章, ${k.length} 关键词`);
  console.log(`     章: ${c.slice(0, 4).map((x) => x.name).join(" / ")}`);
}

console.log("\n=== 高中数学 人教B版（清单第5项）===");
const bTb = tbs.filter((t) => t.stage === "senior" && t.subject === "math" && t.version === "人教B版");
for (const t of bTb.slice(0, 3)) {
  const c = secs.filter((s) => s.textbook_id === t.id);
  const k = kws.filter((x) => x.textbook_id === t.id && !x.archived_at);
  console.log(`  ${t.version} / ${t.name}: ${c.length} 章, ${k.length} 关键词`);
  console.log(`     章: ${c.slice(0, 3).map((x) => x.name).join(" / ")}`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== 一致性检查 ${passed}/${results.length} 通过 ===`);
process.exit(passed === results.length ? 0 : 1);
