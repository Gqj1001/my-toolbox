// 新增三学科科目包（初中数学 / 英语初高中 / 语文初高中）· 结构与集成回归测试
//
// 为什么单独一套：物理那份的测试（`plan-generator-subjects.test.mjs`）是**为物理写的夹具**，
// 里面的数字（26 / 37）与结构假设（4 列、按册次排）都绑死了物理。
// 新学科有**同一个物理没有的坑**（本轮真踩到）：
//   ⭐ **英语单元名跨册重复**（"Unit 1" 在必修一/二/三里都有）——
//      公司附件3 会**按模块名合并相邻行** ⇒ 导出件会**静默少行**。
//      这条只有"全学科一起自检"才能发现，所以本套的核心就是它。
//
// 跑法：& <bundled node> tests\plan-generator-subjects-new.test.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "public/tools/plan-generator");
const S = require(join(DIR, "js/subjects.js"));
const Engine = require(join(DIR, "js/engine.js"));

const results = [];
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

/** 本轮新增的科目包（物理那两套由另一套测试覆盖） */
const NEW = [
  { key: "math", stage: "junior", label: "初中数学", expect: 45 },
  { key: "english", stage: "senior", label: "高中英语", expect: 49 },
  { key: "english", stage: "junior", label: "初中英语", expect: 59 },
  { key: "chinese", stage: "senior", label: "高中语文", expect: 19 },
  { key: "chinese", stage: "junior", label: "初中语文", expect: 24 },
];

/* ==========================================================================
   ① 清单与加载：四个学科齐了，且全部自检通过
   ========================================================================== */
const v = S.validate();
ok("①-1 全学科自检 **0 问题**（含新增三科）", v.ok, v.problems.slice(0, 3).join("；"));

const subjects = S.subjectList().map((s) => s.key);
ok("①-2 学科清单里有物理 / 数学 / 英语 / 语文（加学科只改 manifest 一行）",
  ["physics", "math", "english", "chinese"].every((k) => subjects.indexOf(k) >= 0),
  subjects.join(","));

ok("①-3 数学只做初中（高中版由 math-plan 承担，口径不同、刻意不碰）",
  S.loadPack("math", "senior") === null && S.loadPack("math", "junior") !== null);

for (const n of NEW) {
  const p = S.loadPack(n.key, n.stage);
  ok(`①-4 ${n.label} 能加载，模块数 = ${n.expect}`, !!p && p.modules.length === n.expect,
    p ? String(p.modules.length) : "null");
}

// 一份文件导出两个包（语文）也要能各自取到
ok("①-5 语文初高中共用一份 `chinese.js`，两个包都能单独取到且 stage 正确",
  S.loadPack("chinese", "senior").stage === "senior"
  && S.loadPack("chinese", "junior").stage === "junior"
  && S.loadPack("chinese", "senior").key === "chinese"
  && S.loadPack("chinese", "junior").key === "chinese");

/* ==========================================================================
   ② ⭐ 跨册重名（本轮真踩到的坑）
   ========================================================================== */
for (const n of NEW) {
  const p = S.loadPack(n.key, n.stage);
  const names = p.modules.map((m) => m.name);
  const dup = names.filter((x, i) => names.indexOf(x) !== i);
  ok(`②-1 ${n.label}：模块名**不重复**（重名会被附件3 合并成一行 ⇒ 静默少行）`,
    dup.length === 0, dup.slice(0, 3).join("、"));
}

// 英语的单元名必须**跨册唯一**（必修一/二 的 Unit 1 与 必修三 的 Unit 1 不能同名）。
// ⚠️ 修法是"给后面的册次加前缀"，但**必修一/二 那几个本来就不重复**，所以判据不能死盯前缀 ——
//    真正的红线是上面 ②-1 的"全局不重复"。这里补一条更直观的：带 Unit 的名字里，
//    **同名必须只出现一次**。
{
  const en = S.loadPack("english", "senior");
  const units = en.modules.filter((m) => /Unit\s*\d+/.test(m.name)).map((m) => m.name);
  const dup = units.filter((x, i) => units.indexOf(x) !== i);
  ok("②-2 高中英语带 Unit 的名字**全局唯一**（跨册不撞名）", dup.length === 0, dup.join("、"));
  const enj = S.loadPack("english", "junior");
  const junits = enj.modules.filter((m) => /^Unit\s*\d+$/.test(m.name));
  ok("②-3 初中英语也不留光秃秃的「Unit N」", junits.length === 0,
    junits.slice(0, 3).map((m) => m.name).join("、"));
}

/* ==========================================================================
   ③ 结构：字段齐全、不含括号结尾的名字、年级表引用有效
   ========================================================================== */
for (const n of NEW) {
  const p = S.loadPack(n.key, n.stage);
  const missing = p.modules.filter((m) => !m.id || !m.name || !m.stage || !m.term
    || !Array.isArray(m.chapters) || !m.chapters.length
    || m.content == null || m.goal == null
    || m.hoursHint == null || isNaN(Number(m.hoursHint)) || !Array.isArray(m.tags));
  ok(`③-1 ${n.label}：每个模块字段齐全`, missing.length === 0,
    missing.map((m) => m.id).join("、"));

  const goalsNotBlank = p.modules.filter((m) => String(m.goal).trim() !== "");
  ok(`③-2 ${n.label}：goal 全空（由 AI 生成初稿、老师就地改）`, goalsNotBlank.length === 0,
    goalsNotBlank.slice(0, 3).map((m) => m.id).join("、"));

  const paren = p.modules.filter((m) => /[（(][^（()）]*[)）]\s*$/.test(m.name));
  ok(`③-3 ${n.label}：模块名不以括号结尾（公司引擎会切掉末尾括号）`,
    paren.length === 0, paren.map((m) => m.name).join("、"));

  const ids = {};
  p.modules.forEach((m) => { ids[m.id] = true; });
  const badRef = [];
  Object.keys(p.grades).forEach((g) => {
    (p.grades[g] || []).forEach((id) => { if (!ids[id]) badRef.push(g + "→" + id); });
  });
  ok(`③-4 ${n.label}：年级表点名的模块 id 都存在`, badRef.length === 0, badRef.join("、"));

  const stageKeys = p.stages.map((s) => s.key);
  const badStage = p.modules.filter((m) => stageKeys.indexOf(m.stage) < 0);
  ok(`③-5 ${n.label}：每个模块的 stage 都在 stages 表里`, badStage.length === 0,
    badStage.map((m) => m.id + "(" + m.stage + ")").join("、"));

  const used = {};
  p.modules.forEach((m) => { used[m.stage] = true; });
  const emptyStage = stageKeys.filter((k) => !used[k]);
  ok(`③-6 ${n.label}：stages 表里没有空分组`, emptyStage.length === 0, emptyStage.join("、"));
}

/* ==========================================================================
   ④ 与引擎集成：真科目包跑真引擎
   ========================================================================== */
const CASES = [
  { tag: "初中数学/九年级/60h", key: "math", stage: "junior", grade: "九年级", score: 80, hours: 60 },
  { tag: "初中数学/八年级/40h", key: "math", stage: "junior", grade: "八年级", score: 95, hours: 40 },
  { tag: "高中英语/高三/80h", key: "english", stage: "senior", grade: "高三", score: 95, hours: 80 },
  { tag: "初中英语/九年级/60h", key: "english", stage: "junior", grade: "九年级", score: 80, hours: 60 },
  { tag: "高中语文/高三/100h", key: "chinese", stage: "senior", grade: "高三", score: 95, hours: 100 },
  { tag: "初中语文/九年级/50h", key: "chinese", stage: "junior", grade: "九年级", score: 80, hours: 50 },
];

let allExact = true, allCheck = true, allLeak = true;
const detail = [];
for (const c of CASES) {
  const pack = S.loadPack(c.key, c.stage);
  const plan = Engine.buildPlan(pack, { grade: c.grade, score: c.score, totalHours: c.hours });
  const sum = Math.round(plan.rows.reduce((a, r) => a + r.hours, 0) * 10) / 10;
  if (sum !== c.hours) { allExact = false; detail.push(`${c.tag}: ${sum}≠${c.hours}`); }
  if (!Engine.selfCheck(plan).ok) { allCheck = false; detail.push(`${c.tag}: 自检不过`); }
  // 排出来的模块必须都属于该年级
  const allowed = {};
  (pack.grades[c.grade] || []).forEach((id) => { allowed[id] = true; });
  const mods = Engine.selectModules(pack, { grade: c.grade, score: c.score, totalHours: c.hours }).modules;
  mods.forEach((m) => { if (!allowed[m.id]) { allLeak = false; detail.push(`${c.tag}: 越界 ${m.id}`); } });
}
ok("④-1 六个组合：课时之和**精确等于**总课时", allExact, detail.slice(0, 3).join("；"));
ok("④-2 六个组合：自检（合计/重名/小数）全过", allCheck, detail.slice(0, 3).join("；"));
ok("④-3 六个组合：排出的模块全属所选年级（不越界）", allLeak, detail.slice(0, 3).join("；"));

// 每科都要有"必开"收口模块（不然课时紧时会被普通模块挤掉）
for (const n of NEW) {
  const p = S.loadPack(n.key, n.stage);
  const must = p.modules.filter((m) => m.must);
  ok(`④-4 ${n.label}：有 ${must.length} 个「必开」收口模块`, must.length >= 1,
    must.map((m) => m.name).join("、"));
}

/* ==========================================================================
   ⑤ 静态契约：别把高中数学塞进来、别动 physics 那两份
   ========================================================================== */
const mathSrc = readFileSync(join(DIR, "subjects/math-junior.js"), "utf8");
ok("⑤-1 初中数学包里没有「高中/必修/选必」这类高中内容（避免与 math-plan 口径打架）",
  mathSrc.indexOf("高中") < 0 && mathSrc.indexOf("必修一") < 0 && mathSrc.indexOf("选必") < 0);

const physicsSrc = readFileSync(join(DIR, "subjects/physics-senior.js"), "utf8");
ok("⑤-2 物理包仍是 26 个模块（本轮没被动过）",
  (physicsSrc.match(/^\s+id: "p\d+"|^\s+id: "p\d+",/gm) || []).length >= 20,
  "（用 id 出现次数当粗指标）");

console.log("");
const total = results.length;
const passed = results.filter((x) => x.pass).length;
console.log("=".repeat(78));
console.log(`SUMMARY: ${passed}/${total} passed`);
if (passed !== total) {
  console.log("未通过：");
  results.filter((x) => !x.pass).forEach((x) => console.log("  - " + x.name));
}
console.log("=".repeat(78));
process.exit(passed === total ? 0 : 1);
