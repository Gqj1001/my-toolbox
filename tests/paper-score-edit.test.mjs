// 第二批「解答题分值逐题可编辑」· 纯逻辑验证（不需要浏览器、不需要起服务）
//
// 验证的是「改分值的数学」本身：
//   · assignScores 给的 spread 是否逐题正确
//   · 改一道题 / 批量改区间之后，题型总分 = sum(spread)、整卷合计 = sum(各题型总分)
//   · 拆掉「压回平均」的覆写后，同题型各题分值确实可以不同
//   · seedRecords 的 got/full 缩放 + clamp 在改分值后是否正确（模型与 app.js 保持一致）
//
// app.js 是 IIFE，内部函数取不到；所以这里用同一份 paper-parser.js 复现 UI 的算术，
// 并对 app.js / app.css 做静态结构校验（核心改动不能被改回去）。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PaperParser = require(join(ROOT, "public/tools/paper-analysis/js/paper-parser.js"));

const results = [];
const eq = (name, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${pass ? "" : ` | got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};
const ok = (name, cond, detail) => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};
const round2 = (x) => Math.round((parseFloat(x) || 0) * 100) / 100;

/* ==========================================================================
   1. 取 DEMO 试卷文本并解析（DEMO 是 app.js 里的模板字符串常量）
   ========================================================================== */
const appJs = readFileSync(join(ROOT, "public/tools/paper-analysis/js/app.js"), "utf8");
const demoMatch = appJs.match(/const DEMO = `([\s\S]*?)`;/);
ok("app.js 里能取到 DEMO 常量", !!demoMatch);
const DEMO = demoMatch[1];

const paper = PaperParser.parse(DEMO);
console.log(`\n      DEMO 解析：${paper.questions.length} 题，题型分布 ${JSON.stringify(paper.typeDist)}`);

/* ==========================================================================
   2. assignScores：spread 逐题正确
   ========================================================================== */
const sa = PaperParser.assignScores(paper.typeDist, 150, "");
const types = Object.keys(sa.perType);
console.log(`      分值方案「${sa.preset}」：${types.map(t => `${t} ${sa.perType[t].count}题/${sa.perType[t].total}分`).join("，")}`);

// 与 app.js 的 ensureSpread() 同一套补齐：assignScores 在「非预设」分支下
// 不给客观题生成 spread，渲染前必须就地补一个，spread 才是权威数据源。
const ensureSpreadLike = (type) => {
  const info = sa.perType[type];
  if(!Array.isArray(info.spread) || info.spread.length !== info.count){
    info.spread = Array.from({ length: info.count }, () => parseFloat(info.per) || 0);
  }
};
// 补齐前先记录：客观题确实没有 spread（这是驱动 ensureSpread 存在的理由）
const rawMissing = types.filter(t => !Array.isArray(sa.perType[t].spread));
if(rawMissing.length) console.log(`      assignScores 未给这些题型生成 spread：${rawMissing.join("、")}（由 ensureSpread 补齐）`);
types.forEach(ensureSpreadLike);

ok("补齐后每个题型都有 spread 数组", types.every(t => Array.isArray(sa.perType[t].spread)));
ok("spread 长度 = 题量", types.every(t => sa.perType[t].spread.length === sa.perType[t].count));
eq("整卷合计 = 150", round2(sa.fullScore), 150);
eq("各题型总分之和 = 150",
  round2(types.reduce((s, t) => s + sa.perType[t].total, 0)), 150);
ok("每道题分值都 > 0", types.every(t => sa.perType[t].spread.every(v => v > 0)));

/* ==========================================================================
   3. 复现 UI 的「改一道题」与「批量改区间」
   ========================================================================== */
// 与 app.js 的 typeQuestionNos() 同一套映射：按 section 过滤，保序
const typeQuestionNos = (type) => paper.questions.filter(q => q.section === type).map(q => q.no);

// 与 app.js 的 syncTypeAfterEdit() 同一套派生
const syncTotals = (type) => {
  const info = sa.perType[type];
  info.total = round2(info.spread.reduce((a, x) => a + (parseFloat(x) || 0), 0));
  info.per = info.count ? round2(info.total / info.count) : 0;
  sa.fullScore = round2(Object.values(sa.perType).reduce((a, x) => a + (parseFloat(x.total) || 0), 0));
};

const jd = "解答题";
const jn = typeQuestionNos(jd);
const jinfo = sa.perType[jd];
const beforeJd = jinfo.spread.slice();
console.log(`\n      ${jd} 题号：${jn.join("、")}　初始 spread：${JSON.stringify(jinfo.spread)}`);

// DEMO 走「按常见单题分值估算」分支（未命中预设），解答题按 base + (i<extra)
// 吸收尾差，所以初始值本来就可能有 1 分之差（10,10,10,9,9,9,9,9）。
// 这里要验的是「估算出来的逐题分值自洽」，等值情形由下面的新高考预设覆盖。
ok("解答题初始逐题分值极差 ≤ 1（尾差分配正确）",
  Math.max(...jinfo.spread) - Math.min(...jinfo.spread) <= 1, `spread=${JSON.stringify(jinfo.spread)}`);
eq("初始逐题分值之和 = 题型总分",
  round2(jinfo.spread.reduce((s, x) => s + x, 0)), round2(jinfo.total));

// 改第 3 道解答题为 17（模拟老师填 13/15/15/17/17 的中间一步）
const targetIdx = 2;
jinfo.spread[targetIdx] = 17;
syncTotals(jd);

ok("改一道题后 spread 保留了差异（没被压回平均）",
  new Set(jinfo.spread).size > 1, `spread=${JSON.stringify(jinfo.spread)}`);
ok("改一道题没有动到同题型其他题",
  jinfo.spread.every((v, i) => i === targetIdx || v === beforeJd[i]),
  `spread=${JSON.stringify(jinfo.spread)}`);
eq("题型总分 = sum(spread)",
  jinfo.total, round2(jinfo.spread.reduce((s, x) => s + x, 0)));
eq("整卷合计 = 各题型 total 之和",
  sa.fullScore, round2(types.reduce((s, t) => s + sa.perType[t].total, 0)));
ok("整卷合计随改动变化", sa.fullScore !== 150, `fullScore=${sa.fullScore}`);

// 把 5 道解答题 77 分调成 13/15/15/17/17（正好总和还是 77 → 合计应回到 150）
const goal = [13, 15, 15, 17, 17];
if(jinfo.count === goal.length){
  jinfo.spread = goal.slice();
  syncTotals(jd);
  eq("13/15/15/17/17 → 题型总分 77", jinfo.total, 77);
  eq("13/15/15/17/17 → 平均 15.4", jinfo.per, 15.4);
  eq("13/15/15/17/17 → 整卷合计回到 150", sa.fullScore, 150);
} else {
  console.log(`      （DEMO 解答题是 ${jinfo.count} 道，跳过 13/15/15/17/17 定点校验）`);
}

/* ---- 批量改区间：「第 X 到 Y 题，每题 V 分」 ---- */
const before = jinfo.spread.slice();
const lo = jn[0], hi = jn[1], V = 12;
const hit = [];
for(let i = 0; i < jinfo.count; i++){
  const no = jn[i] != null ? jn[i] : i + 1;
  if(no >= lo && no <= hi) hit.push(i);
}
hit.forEach(i => { jinfo.spread[i] = V; });
syncTotals(jd);
ok("批量区间只影响该题型内的题", hit.length === 2 && jinfo.spread[0] === V && jinfo.spread[1] === V,
  `hit=${JSON.stringify(hit)} spread=${JSON.stringify(jinfo.spread)}`);
ok("批量区间没动到区间外的题", jinfo.count < 3 || jinfo.spread[jinfo.count - 1] === before[jinfo.count - 1]);
ok("批量后其他题型完全未受影响",
  types.filter(t => t !== jd).every(t => sa.perType[t].total === PaperParser.assignScores(paper.typeDist, 150, "").perType[t].total));

/* ==========================================================================
   3b. 需求里的精确场景：新高考 I/II 卷，5 道解答题 77 分 → 15.4 → 13/15/15/17/17
   ========================================================================== */
const dist5 = [
  { type: "单选题", count: 8 }, { type: "多选题", count: 3 },
  { type: "填空题", count: 3 }, { type: "解答题", count: 5 },
];
const sa5 = PaperParser.assignScores(dist5, 150, "新高考 I/II 卷");
const j5 = sa5.perType["解答题"];
console.log(`\n      新高考 I/II 卷：解答题 ${j5.count} 题 / ${j5.total} 分，spread=${JSON.stringify(j5.spread)}`);

eq("新高考预设命中", sa5.preset, "新高考 I/II 卷");
eq("解答题 5 题共 77 分", j5.total, 77);
eq("默认平均 15.4", j5.per, 15.4);
eq("默认 spread 全是 15.4", j5.spread, [15.4, 15.4, 15.4, 15.4, 15.4]);
eq("整卷合计 150", round2(sa5.fullScore), 150);

// 老师改成 13/15/15/17/17（总和仍是 77）
const goal5 = [13, 15, 15, 17, 17];
j5.spread = goal5.slice();
j5.total = round2(j5.spread.reduce((s, x) => s + x, 0));
j5.per = round2(j5.total / j5.count);
const full5 = round2(Object.values(sa5.perType).reduce((s, x) => s + x.total, 0));

eq("改成 13/15/15/17/17 后题型总分仍 77", j5.total, 77);
eq("改成 13/15/15/17/17 后平均仍是 15.4", j5.per, 15.4);
eq("整卷合计仍 150（总和没变）", full5, 150);
ok("5 道题分值各不相同（逐题可编辑的核心目标）", new Set(j5.spread).size > 1);

// 总分变了 → 合计应跟着变，并应触发「与预设不一致」提示
j5.spread[4] = 20;                                   // 17 → 20
j5.total = round2(j5.spread.reduce((s, x) => s + x, 0));
const full5b = round2(Object.values(sa5.perType).reduce((s, x) => s + x.total, 0));
eq("总分加到 80 后题型总分 = 80", j5.total, 80);
eq("整卷合计变成 153", full5b, 153);
ok("总分与原预设 77 不一致（这正是要提示的情形）", j5.total !== 77, `${j5.total} vs 77`);

/* ==========================================================================
   4. seedRecords 的缩放 + clamp（与 app.js 同一套模型）
   ========================================================================== */
const seedLike = (old, full) => {
  let got = full;
  if(old && typeof old.full === "number" && old.full > 0){
    if(old.full === full) got = old.got;
    else if(old.got >= old.full) got = full;              // 原本满分 → 给新满分
    else got = Math.round(full * (old.got / old.full) * 100) / 100;   // 部分分 → 比例缩放
  }
  // app.js 的 clamp 用 num() 兜底，NaN/undefined 一律归零后不触发 got>full
  if(!(got >= 0)) got = 0;
  if(got > full) got = full;
  if(got < 0) got = 0;
  return got;
};

eq("分值未变 → 已填得分原样保留", seedLike({ full: 15.4, got: 9 }, 15.4), 9);
eq("分值变、原本满分 → 给新满分", seedLike({ full: 15.4, got: 15.4 }, 17), 17);
eq("分值变、部分分 → 按比例缩放 (9/15.4×17)", seedLike({ full: 15.4, got: 9 }, 17), 9.94);
eq("缩放结果不会超过新满分", seedLike({ full: 15.4, got: 9 }, 5) <= 5, true);
eq("得分超上限被 clamp 到满分", seedLike({ full: 10, got: 999 }, 10), 10);
eq("得分是 NaN → clamp 归零", seedLike({ full: 10, got: NaN }, 10), 0);
eq("得分是负数 → clamp 归零", seedLike({ full: 10, got: -5 }, 10), 0);
eq("全新题目（无旧记录）→ 默认满分", seedLike(undefined, 13), 13);

/* ==========================================================================
   5. app.js / app.css 静态结构校验（核心改动不能被改回去）
   ========================================================================== */
const a = appJs;
// 「压回平均」的覆写只允许存在于 ensureSpread 里（补齐用，不是覆盖用户编辑）。
// syncTypeAfterEdit 是逐题编辑的收尾函数，它绝不能给 info.spread 整体赋新数组。
const syncFn = (a.match(/function syncTypeAfterEdit\([\s\S]*?\n\}/) || [""])[0];
ok("syncTypeAfterEdit 不再把 spread 整体覆写",
  syncFn.length > 0 && !/info\.spread\s*=/.test(syncFn));
ok("旧的逐题压回平均已从渲染/编辑路径移除",
  !/info\.spread\s*=\s*Array\.from\([\s\S]{0,40}info\.count/.test(a));
ok("info.spread 的整体赋值只剩 ensureSpread 一处",
  (a.match(/info\.spread\s*=\s*/g) || []).length === 1,
  `出现 ${(a.match(/info\.spread\s*=\s*/g) || []).length} 次`);
ok("存在 scoreExpand 状态", /let scoreExpand = new Set\(\)/.test(a));
ok("存在 baselineTotals 快照", /let baselineTotals = \{\}/.test(a));
ok("存在 typeQuestionNos", /function typeQuestionNos\(/.test(a));
ok("存在 applyTypeCell", /function applyTypeCell\(/.test(a));
ok("存在 applyBatch", /function applyBatch\(/.test(a));
ok("存在 syncTypeAfterEdit", /function syncTypeAfterEdit\(/.test(a));
ok("存在 ensureSpread", /function ensureSpread\(/.test(a));
ok("存在 buildScoreSumHint", /function buildScoreSumHint\(/.test(a));
ok("事件委托：scoreTable 上挂了 click", /scoreTable\.addEventListener\('click'/.test(a));
ok("事件委托：scoreTable 上挂了 change", /scoreTable\.addEventListener\('change'/.test(a));
ok("渲染函数内不再逐个绑 change 监听器", !/\$\$\('#scoreTable input\[data-per\]'\)/.test(a));
ok("已无旧的 data-per 输入框", !/data-per=/.test(a));
ok("子行用 colspan=4（定义 + 重建各一处）",
  (a.match(/colspan="4"/g) || []).length >= 2,
  `出现 ${(a.match(/colspan="4"/g) || []).length} 次`);
ok("合计单元格仍叫 sumCell", /id="sumCell"/.test(a));
ok("提示行仍叫 scoreSumHint", (a.match(/scoreSumHint/g) || []).length >= 2);

const css = readFileSync(join(ROOT, "public/tools/paper-analysis/css/app.css"), "utf8");
ok("CSS 有 .tgl 段", /\.tgl\{/.test(css));
ok("CSS 有 tr.sub 段", /tr\.sub>td\{/.test(css));
ok("CSS 有 .qcell 段", /\.qcell\{/.test(css));
ok("CSS 有 .batch 段", /\.batch\{/.test(css));
ok("CSS 显式隐藏 tr.sub[hidden]", /tr\.sub\[hidden\]\{display:none!important\}/.test(css));

console.log(`\n=== SUMMARY: ${results.filter(Boolean).length}/${results.length} passed ===`);
process.exit(results.every(Boolean) ? 0 : 1);
