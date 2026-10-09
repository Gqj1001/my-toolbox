/**
 * 卷面结构（`examPreset`）→ **逐题分值**自动分配
 *
 * 为什么值得单独一个套件：这是「老师选了下拉，分值却毫无反应」那个 bug 的防线。
 * 老实现要求**题型 + 题量完全相等**，否则把整个预设丢掉、退回"常见单题分值估算" ——
 * 而实际卷子（尤其解答题道数）年年有出入，于是下拉经常点了等于没点。
 *
 * 现在的要求：
 *   ① 选了预设就**按它铺满每一道题**（有逐题常用值就用逐题值，不是一个平均值铺满）；
 *   ② 题量对不上**也要铺**（多退少补），并给出"请核对"的提示；
 *   ③ 没选预设时：题量正好匹配某个卷面结构 → 自动用它；匹配不上 → 常见单题分值估算；
 *   ④ **每个题型都必须带 `spread`** —— 少一个，前端的逐题编辑就会崩
 *      （老实现里"估算"那条分支确实没有 spread，本轮修掉）。
 *
 * 跑法：& "<bundled node>" tests\paper-preset.test.mjs
 * ⚠️ 纯函数套件，**不需要服务器、不需要数据库**。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { makeRecorder } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const SRC = "D:/my-website/my-toolbox/public/tools/paper-analysis/js/paper-parser.js";
const { record, summary } = makeRecorder();

/**
 * ⚠️ 用**源码文本**求值，而不是 `require()`。
 *    本轮踩过：`require()` 拿到的模块对象里 `TYPE_PRESETS` 的 `per` 是旧的
 *    （看起来像缓存/解析问题），换成"读源码 + new Function"才看到真相
 *    （真相是我把 `per` 写进了 `dist` 里面，见下方断言）。
 *    求值源码没有这层不确定性，而且能顺便保证"发给浏览器的就是这份文件"。
 */
const mod = { exports: {} };
const root = {};
new Function("module", "exports", "window", "document", "self", "globalThis",
  readFileSync(SRC, "utf8"))(mod, mod.exports, root, undefined, root, root);
const PP = mod.exports.assignScores ? mod.exports : root.PaperParser;
record("能加载 paper-parser.js 并拿到 assignScores", typeof PP?.assignScores === "function");

const td = (...pairs) => pairs.map(([type, count]) => ({ type, count }));
const sum = (a) => Math.round(a.reduce((x, y) => x + y, 0) * 100) / 100;

// ============================================================
// 0. 预设数据结构本身
// ============================================================
console.log("\n=== 0. 预设数据结构 ===");
{
  const names = PP.TYPE_PRESETS.map((p) => p.name);
  record("预设仍然有 6 个（名字没被改动）",
    names.length === 6 && names.includes("北京卷") && names.includes("新高考 I/II 卷"),
    names.join(" | "));

  // ★ 钉住本轮那个坑：`per` 必须是**预设对象的兄弟属性**，不能写进 `dist` 里。
  //   写进 dist 的话 `preset.per` 永远是 undefined → 逐题常用值静默失效（不报错）。
  const withPer = PP.TYPE_PRESETS.filter((p) => p.per && Array.isArray(p.per["解答题"]));
  record("★每个预设的逐题分值挂在**顶层** `per` 上（不是塞进 dist 里）",
    withPer.length === PP.TYPE_PRESETS.length,
    `带 per 的预设 = ${withPer.length} / ${PP.TYPE_PRESETS.length}` +
      (withPer.length !== PP.TYPE_PRESETS.length ? ` 缺=[${PP.TYPE_PRESETS.filter((p) => !p.per).map((p) => p.name)}]` : ""));

  // 逐题分值之和应当等于该题型的块总分（北京卷 85、新高考 77）
  const bad = [];
  for (const p of PP.TYPE_PRESETS) {
    const d = p.dist["解答题"];
    if (!d) continue;
    const block = d[2];
    const arr = p.per?.["解答题"];
    if (!arr) continue;
    // 题量与逐题值的个数要对得上，否则"铺满"就是错的
    if (arr.length !== d[0]) bad.push(`${p.name}: per 有 ${arr.length} 个值，但预设题量是 ${d[0]}`);
    if (block != null && sum(arr) !== block) bad.push(`${p.name}: 逐题之和 ${sum(arr)} ≠ 块总分 ${block}`);
  }
  record("★逐题分值的个数与合计都对得上预设（北京卷 85 / 新高考 77）",
    bad.length === 0, bad.length ? bad.join(" | ") : "");
}

// ============================================================
// 1. 选了预设 + 题量一致 → 逐题分好
// ============================================================
console.log("\n=== 1. 题量一致时逐题分好 ===");
{
  const r = PP.assignScores(td(["单选题", 10], ["填空题", 5], ["解答题", 6]), 150, "北京卷");
  record("preset 被采纳（不是退化成估算）", r.preset === "北京卷", `preset=${JSON.stringify(r.preset)}`);
  record("合计仍然是 150", r.fullScore === 150, `合计=${r.fullScore}`);
  record("★北京卷解答题用**逐题**常用值 [13,15,15,15,14,13]（不是一个平均值铺满）",
    JSON.stringify(r.perType["解答题"].spread) === JSON.stringify([13, 15, 15, 15, 14, 13]),
    `逐题=[${r.perType["解答题"].spread.join(",")}]`);
  record("★解答题块总分 = 85（与预设一致）", r.perType["解答题"].total === 85,
    `块合计=${r.perType["解答题"].total}`);

  const r2 = PP.assignScores(
    td(["单选题", 8], ["多选题", 3], ["填空题", 3], ["解答题", 5]), 150, "新高考 I/II 卷");
  record("★新高考解答题用逐题常用值 [13,15,15,17,17]",
    JSON.stringify(r2.perType["解答题"].spread) === JSON.stringify([13, 15, 15, 17, 17]),
    `逐题=[${r2.perType["解答题"].spread.join(",")}]`);
}

// ============================================================
// 2. 题量不一致 → **仍然按预设铺**（本轮改的核心）
// ============================================================
console.log("\n=== 2. 题量不一致（老实现整个作废）===");
{
  // 解答题 8 道（比北京卷预设的 6 道多）
  const r = PP.assignScores(td(["单选题", 10], ["填空题", 5], ["解答题", 8]), 150, "北京卷");
  record("★题量对不上时**不再丢弃预设**（老实现在这里 preset 变成 null）",
    r.preset === "北京卷", `preset=${JSON.stringify(r.preset)}`);
  record("★给出「题量与预设不同，请核对」的提示（不静默）",
    r.warnings.some((w) => /请核对下方逐题分值/.test(w)), JSON.stringify(r.warnings));
  record("8 道解答题每道都有分值（多出来的用平均分补齐）",
    r.perType["解答题"].spread.length === 8 && r.perType["解答题"].spread.every((v) => v > 0),
    `逐题=[${r.perType["解答题"].spread.join(",")}]`);
  record("前 5 道仍按预设的相对高低（不是一律拉平）",
    new Set(r.perType["解答题"].spread.slice(0, 5)).size > 1,
    `前5道=[${r.perType["解答题"].spread.slice(0, 5).join(",")}]`);

  // 解答题 5 道（比预设少）
  const r2 = PP.assignScores(td(["单选题", 10], ["填空题", 5], ["解答题", 5]), 150, "北京卷");
  record("题量比预设少时同样按预设铺（取前 5 个）",
    r2.preset === "北京卷" && r2.perType["解答题"].spread.length === 5,
    `preset=${r2.preset} 逐题=[${r2.perType["解答题"]?.spread.join(",")}]`);
}

// ============================================================
// 3. 没选预设：自动匹配 / 估算
// ============================================================
console.log("\n=== 3. 没选预设 ===");
{
  const auto = PP.assignScores(td(["单选题", 10], ["填空题", 5], ["解答题", 6]), 150, "");
  record("题量正好匹配某个卷面结构 → 自动用它",
    auto.preset === "北京卷", `preset=${JSON.stringify(auto.preset)}`);

  // 含「判断题」→ 任何预设都匹配不上 → 走估算
  const est = PP.assignScores(td(["单选题", 7], ["判断题", 4], ["解答题", 6]), 150, "");
  record("匹配不上任何预设 → 按常见单题分值估算",
    /估算/.test(String(est.preset)), `preset=${JSON.stringify(est.preset)}`);
  record("估算路径也给出「请核对」提示",
    est.warnings.some((w) => /常见单题分值估算/.test(w)), JSON.stringify(est.warnings));
}

// ============================================================
// 4. 红线：每个题型都必须有 spread（否则前端逐题编辑会崩）
// ============================================================
console.log("\n=== 4. 红线：spread 必须齐 ===");
{
  const cases = [
    ["选北京卷·题量一致", td(["单选题", 10], ["填空题", 5], ["解答题", 6]), "北京卷"],
    ["选北京卷·题量不符", td(["单选题", 10], ["填空题", 5], ["解答题", 8]), "北京卷"],
    ["自动匹配", td(["单选题", 10], ["填空题", 5], ["解答题", 6]), ""],
    ["估算（含判断题）", td(["单选题", 7], ["判断题", 4], ["解答题", 6]), ""],
    ["预设题型完全对不上", td(["判断题", 20]), "北京卷"],
  ];
  const bad = [];
  for (const [label, dist, preset] of cases) {
    const r = PP.assignScores(dist, 150, preset);
    for (const [type, v] of Object.entries(r.perType)) {
      if (!Array.isArray(v.spread) || v.spread.length !== v.count || v.spread.some((x) => !(x > 0))) {
        bad.push(`${label}/${type}: spread=${JSON.stringify(v.spread)} count=${v.count}`);
      }
    }
    // 逐题之和 = 块合计；全卷合计 = 逐题之和总和
    for (const [type, v] of Object.entries(r.perType)) {
      if (Math.abs(sum(v.spread) - v.total) > 0.02) {
        bad.push(`${label}/${type}: 逐题之和 ${sum(v.spread)} ≠ 块合计 ${v.total}`);
      }
    }
    if (Math.abs(Object.values(r.perType).reduce((a, v) => a + v.total, 0) - r.fullScore) > 0.05) {
      bad.push(`${label}: 块合计之和 ≠ fullScore(${r.fullScore})`);
    }
  }
  record("★所有路径下每个题型都有正数 spread、且逐题之和 = 块合计 = 全卷合计",
    bad.length === 0, bad.length ? bad.join(" | ") : `（${cases.length} 种路径）`);
}

const ok = summary();
process.exit(ok ? 0 : 1);
