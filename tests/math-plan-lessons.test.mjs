// 阶段① 回归测试：高三「三轮节奏」与必开模块必须进课表
//
// 背景（本次要修的 bug）：
//   1. 「高考真题精讲」「错题清零」「综合模拟」在 MODULES 里不存在，
//      只作为纯文本出现在 threeRounds() 的描述里 → 逐次课表从不排入；
//   2. generate() 的 mods.slice(0, maxRows) 在课时偏小时按评分砍掉尾部模块
//      → 三大压轴专项（数列/解析几何/导数）会被砍掉；
//   3. 三轮节奏的课时是独立按百分比算的，与课表实际内容脱节。
//
// 做法：从 math-plan.html 里抽出 <script>，在 Node vm 沙箱里执行（补最小 DOM stub），
//       直接调用 generate / pickModules / threeRounds / selfCheck / MODULES。
//       不依赖浏览器、不依赖界面操作，纯逻辑断言。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HTML = join(ROOT, "public/tools/math-plan.html");

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

/* ==========================================================================
   抽出 <script> 并在 vm 沙箱里执行
   ========================================================================== */
const html = readFileSync(HTML, "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
if (!m) {
  console.error("无法从 math-plan.html 抽出 <script>");
  process.exit(2);
}
const scriptSource = m[1];
// 顶层 const/function 在 vm 里不会挂到 context 对象上（const 进的是词法环境，
// 不是 globalThis 属性），所以追加一行显式导出，把需要的符号取出来。
const EXPORT_LINE =
  "\n;globalThis.__MP__ = { MODULES, EXAMS, generate, pickModules, threeRounds, selfCheck, " +
  "bandOf, rateOf, fitFlow, FLOWS, BAND_TEXT, allocateRows, buildLessons, readForm, PRESETS };\n";

/** 最小 DOM stub：只满足脚本「加载期」真正碰到的调用 */
function makeDomStub() {
  const el = () => ({
    value: "", textContent: "", innerHTML: "", style: {}, dataset: {},
    classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, querySelector: () => el(),
    querySelectorAll: () => [],
  });
  return {
    querySelector: () => el(),
    querySelectorAll: (s) => (String(s).includes("button") ? [] : []),
    addEventListener() {},
    createElement: () => el(),
  };
}

const ctx = {
  document: makeDomStub(),
  location: { reload() {} },
  window: { print() {} },
  console,
  Math, JSON, Array, Object, String, Number, parseFloat, parseInt, isNaN, Set, Map, RegExp, Date, Error,
};
require("node:vm").createContext(ctx);
require("node:vm").runInContext(scriptSource + EXPORT_LINE, ctx);

const { MODULES, generate, pickModules, threeRounds, selfCheck, EXAMS, bandOf } = ctx.__MP__ || {};
ok("沙箱里能拿到 math-plan.html 的顶层函数与 MODULES", !!MODULES && !!generate && !!threeRounds && !!selfCheck,
  `MODULES=${MODULES ? MODULES.length : "无"} 个`);
if (!MODULES) { console.log("\n=== SUMMARY: 0/1 passed ===\n（脚本抽取失败，后续断言跳过）"); process.exit(1); }

const nameOf = (id) => (MODULES.find((x) => x.id === id) || {}).name || id;

/* ==========================================================================
   基线快照：老 42 个模块必须一字不动
   ========================================================================== */
const OLD_IDS = Array.from({ length: 42 }, (_, i) => "m" + String(i + 1).padStart(2, "0"));
const oldMods = MODULES.filter((x) => OLD_IDS.includes(x.id));
const baseline = oldMods.map((x) => ({ id: x.id, name: x.name, lv: x.lv, tags: x.tags.join(",") }));
// 冻结基线（阶段① 改动前实测所得；改动后必须逐条一致）
const FROZEN = [
  ["m01", "集合与常用逻辑用语", 1], ["m02", "一元二次函数、方程与不等式", 1],
  ["m03", "基本不等式与最值", 2], ["m04", "函数的概念与三要素", 1],
  ["m05", "函数的性质综合", 2], ["m06", "指数函数与对数函数", 2],
  ["m07", "函数的零点与图像变换", 2], ["m08", "三角函数的概念与恒等变换", 1],
  ["m09", "三角函数的图像与性质", 2], ["m10", "平面向量", 1],
  ["m11", "正弦定理与余弦定理", 2], ["m12", "复数的概念与运算", 1],
  ["m13", "立体几何初步", 2], ["m14", "统计与统计案例", 1],
  ["m15", "概率基础", 1], ["m16", "空间向量与立体几何", 2],
  ["m17", "直线与圆的方程", 1], ["m18", "椭圆", 2],
  ["m19", "双曲线与抛物线", 2], ["m20", "圆锥曲线综合", 3],
  ["m21", "数列的概念与通项", 2], ["m22", "数列求和与综合", 2],
  ["m23", "导数的概念与运算", 2], ["m24", "导数与函数单调性极值", 2],
  ["m25", "导数综合（恒成立与零点）", 3], ["m26", "计数原理与排列组合", 2],
  ["m27", "二项式定理", 1], ["m28", "随机变量及其分布", 2],
  ["m29", "成对数据的统计分析", 1], ["m30", "集合复数逻辑（选填基础）", 1],
  ["m31", "不等式与极值（选填中档）", 2], ["m32", "函数选填压轴专项", 3],
  ["m33", "三角选填与解答专项", 2], ["m34", "数列综合专项", 3],
  ["m35", "概率统计大题专项", 2], ["m36", "立体几何大题专项", 2],
  ["m37", "解析几何大题专项", 3], ["m38", "导数大题专项", 3],
  ["m39", "数学文化与新定义题", 3], ["m40", "应试策略与答题规范", 1],
  ["m41", "初高中衔接与计算过关", 1], ["m42", "计算专项提速（含导数与联立）", 2],
];
const snapOk = FROZEN.every(([id, name, lv], i) => {
  const b = baseline[i];
  return b && b.id === id && b.name === name && b.lv === lv;
});
ok("[护栏] 老 42 个模块 id/name/lv 与基线逐条一致", snapOk,
  snapOk ? `42 条一致` : `首个不一致：${JSON.stringify(baseline.find((b, i) => b.id !== FROZEN[i][0] || b.name !== FROZEN[i][1] || b.lv !== FROZEN[i][2]))}`);
ok("[护栏] 老模块数量仍为 42（新增只能追加）", oldMods.length === 42, `${oldMods.length} 个`);

/* ==========================================================================
   测试矩阵
   ========================================================================== */
const MUST3 = ["m43", "m44", "m45"];        // 真题精讲 / 错题清零 / 综合模拟
const ZHUANXIANG3 = ["m34", "m37", "m38"];  // 数列 / 解析几何 / 导数 大题专项
const ALL_OLD = OLD_IDS.slice();
const HOURS = [8, 20, 30, 40, 60, 80, 100, 120];
const DONE_SCENARIOS = [
  { label: "done=空", done: [] },
  { label: "done=全部42个", done: ALL_OLD },
  { label: "done=三大专项", done: ZHUANXIANG3 },
  { label: "done=全部必开+三大专项", done: [...MUST3, ...ZHUANXIANG3] },
];
const SMALL_HOURS = 40;   // < 40h 只断言「不崩 + 课时账目对」；>= 40h 断言所有 must 都在

const newOpt = (hours, done) => ({
  name: "测试同学", grade: "高三", phase: "秋寒", exam: "nh1", book: "",
  campus: "", score: 105, target: 130, totalHours: hours, len: "2",
  freq: 2, freqH: 5, weeks: 20, holidayWeeks: 3, national: 5, holiday: 1,
  focus: "hard", flow: "auto", check: "auto", paper: "",
  weakTopics: [], done, note: "",
});

const roundsTotal = (r) => (r || []).reduce((a, x) => a + x.hours, 0);

console.log("\n--- 矩阵：8 档课时 × 4 种 done 场景 ---");
const fails = { must3: [], zhuangxiang3: [], roundsExact: [], roundsNonZero: [], coverage: [], ledger: [] };

for (const hours of HOURS) {
  for (const sc of DONE_SCENARIOS) {
    const o = newOpt(hours, sc.done);
    let plan;
    try {
      plan = generate(o);
    } catch (e) {
      ok(`[${hours}h/${sc.label}] generate 不抛异常`, false, e.message);
      continue;
    }
    const ids = plan.rows.map((r) => r.module.id);
    const label = `${hours}h/${sc.label}`;

    // --- a. 三个必开模块都在课表里 ---
    const missMust = MUST3.filter((id) => !ids.includes(id));
    if (hours >= SMALL_HOURS) {
      if (missMust.length) fails.must3.push(`${label}: 缺 ${missMust.join(",")}`);
    } else {
      // 小课时：只要求不崩 + 账目对（下面 d/h 断言），不要求装得下全部必开
    }

    // --- b. 三大压轴专项都在课表里 ---
    const missZ = ZHUANXIANG3.filter((id) => !ids.includes(id));
    if (hours >= SMALL_HOURS) {
      if (missZ.length) fails.zhuangxiang3.push(`${label}: 缺 ${missZ.join(",")}`);
    }

    // --- d. 三段课时之和 = 总课时（含收尾行） ---
    const rt = roundsTotal(plan.rounds);
    if (rt !== o.totalHours) fails.roundsExact.push(`${label}: ${rt} vs ${o.totalHours}`);

    // --- e. 三轮各自有内容（仅课时≥40h 且池子充足时才谈得上）---
    // 8h 这类小课时 maxRows=2，装得下的只有排分最高的专项模块，
    // 一轮为 0 是必然的（用户已明确：<40h 只要求不崩 + 账目对）。
    if (!plan.rounds) { /* 非高三无三轮 */ }
    else if (sc.label === "done=空" && hours >= SMALL_HOURS) {
      if (plan.rounds.some((r) => !(r.hours > 0)))
        fails.roundsNonZero.push(`${label}: ${plan.rounds.map((r) => r.name + "=" + r.hours).join(" ")}`);
    }

    // --- g. selfCheck 有「模块覆盖 / 未排入模块」结论 ---
    const cov = (plan.checks || []).find((x) => x[1] === "模块覆盖" || x[1] === "未排入模块");
    if (!cov) fails.coverage.push(`${label}: 无覆盖结论`);

    // --- h. 课时账目（现有护栏）---
    // 注意：行级课时不必恒为 2 —— buildLessons 之后有「合并相邻同名行」，
    // 合并会把课时累加（如 4/6 课时一行）。所以只断言：合计精确 + 每行 > 0。
    const rowHours = plan.rows.reduce((a, r) => a + r.hours, 0);
    if (hours % 2 === 0 && rowHours !== o.totalHours)
      fails.ledger.push(`${label}: 行课时合计 ${rowHours} ≠ ${o.totalHours}`);
    if (plan.rows.some((r) => !(r.hours > 0)))
      fails.ledger.push(`${label}: 有行课时 ≤ 0`);
  }
}

ok(`a. 课时≥${SMALL_HOURS}h 时三个必开模块全都进课表（${HOURS.filter((h) => h >= SMALL_HOURS).length} 档 × ${DONE_SCENARIOS.length} 场景）`,
  fails.must3.length === 0, fails.must3.slice(0, 4).join(" ; ") || "全部命中");
ok(`b. 课时≥${SMALL_HOURS}h 时三大压轴专项全都进课表`,
  fails.zhuangxiang3.length === 0, fails.zhuangxiang3.slice(0, 4).join(" ; ") || "全部命中");
ok(`d. 三段课时之和 = 总课时（精确相等，含收尾行）`,
  fails.roundsExact.length === 0, fails.roundsExact.slice(0, 4).join(" ; ") || "全部相等");
ok("e. 三段课时各自 > 0（池子充足时二轮不被必开模块挤空）",
  fails.roundsNonZero.length === 0, fails.roundsNonZero.slice(0, 4).join(" ; ") || "全部 > 0");
ok("g. selfCheck 给出模块覆盖结论（全部排入 / 未排入清单）",
  fails.coverage.length === 0, fails.coverage.slice(0, 4).join(" ; ") || "全部有结论");
ok("h. [护栏] 课时账目：行课时合计 = 总课时（偶数档）且每行 > 0",
  fails.ledger.length === 0, fails.ledger.slice(0, 4).join(" ; ") || "全部对齐");

/* --- c. done 豁免：勾了必开模块也必须排 --- */
{
  const o = newOpt(60, [...MUST3, ...ZHUANXIANG3]);
  const plan = generate(o);
  const ids = plan.rows.map((r) => r.module.id);
  const miss = [...MUST3, ...ZHUANXIANG3].filter((id) => !ids.includes(id));
  ok("c. done 里勾选了必开模块时，它们仍然进课表（done 豁免）", miss.length === 0,
    miss.length ? `仍缺 ${miss.map(nameOf).join(",")}` : "6 个必开模块全部命中");
}

/* --- f. 收尾行与 selfCheck「检测落地」（护栏：文案不改，判定放宽） --- */
for (const hours of [40, 120]) {
  const o = newOpt(hours, []);
  const plan = generate(o);
  const last = plan.rows[plan.rows.length - 1];
  const hit = /检测|综合模拟/.test(last ? last.stage : "");
  const check = (plan.checks || []).find((x) => x[1] === "检测落地");
  ok(`f. [护栏 ${hours}h] 最后一行含「检测/综合模拟」且 selfCheck 检测落地为 ok`,
    hit && !!check && check[0] === "ok",
    `最后一行="${last ? last.stage : "(无)"}" 自检=${check ? check[0] : "缺失"}`);
}

/* --- j. 必开模块从不出现在被砍名单里 --- */
{
  const cutList = [];
  for (const hours of [40, 60, 80]) {
    for (const sc of DONE_SCENARIOS) {
      const o = newOpt(hours, sc.done);
      const pool = pickModules(o);
      const ids = generate(newOpt(hours, sc.done)).rows.map((r) => r.module.id);
      const cutMust = pool.filter((x) => x.must && !ids.includes(x.id));
      if (cutMust.length) cutList.push(`${hours}h/${sc.label}: ${cutMust.map((x) => x.name).join(",")}`);
    }
  }
  ok("j. 必开模块从不被 slice 砍掉", cutList.length === 0, cutList.slice(0, 3).join(" ; ") || "全部保留");
}

/* --- 诊断输出：当前 slice 到底砍了哪些模块（供人核对） --- */
console.log("\n--- 诊断：slice 实际砍掉的模块（当前代码） ---");
for (const hours of [40, 60, 80]) {
  for (const sc of DONE_SCENARIOS) {
    const o = newOpt(hours, sc.done);
    const pool = pickModules(o).map((x) => x.id);
    const ids = generate(newOpt(hours, sc.done)).rows.map((r) => r.module.id);
    const cut = pool.filter((id) => !ids.includes(id));
    console.log(`  ${String(hours).padStart(3)}h/${sc.label.padEnd(22)} 候选 ${String(pool.length).padStart(2)} → 排入 ${String(new Set(ids).size).padStart(2)}，砍掉 ${cut.length} 个: ${cut.map(nameOf).join("、") || "（无）"}`);
  }
}

/* --- k. 小课时（<40h）只要求不崩 + 账目对 --- */
{
  const bad = [];
  for (const hours of HOURS.filter((h) => h < SMALL_HOURS)) {
    for (const sc of DONE_SCENARIOS) {
      const o = newOpt(hours, sc.done);
      try {
        const plan = generate(o);
        if (!plan.rows.length) bad.push(`${hours}h/${sc.label}: 无行`);
        if (hours % 2 === 0 && plan.rows.reduce((a, r) => a + r.hours, 0) !== hours)
          bad.push(`${hours}h/${sc.label}: 课时对不上`);
      } catch (e) {
        bad.push(`${hours}h/${sc.label}: 抛异常 ${e.message}`);
      }
    }
  }
  ok(`k. 课时<${SMALL_HOURS}h 时 generate 不崩且课时账目正确`, bad.length === 0,
    bad.slice(0, 3).join(" ; ") || "全部正常");
}

/* ==========================================================================
   l. 极端场景自查：done = 全部 42 个（所有模块都被勾"已完成"）
   --------------------------------------------------------------------------
   这是最严苛的 done 场景：候选池被清空，只有 must 豁免还能救回必开模块。
   要求：必开 6 个全在、课时账目不坏、程序不崩。
   ========================================================================== */
console.log("\n--- 极端场景：done = 全部 42 个 ---");
{
  const bad = { must3: [], zhuangxiang3: [], ledger: [], crash: [] };
  for (const hours of [40, 60, 80, 120]) {
    let plan;
    try {
      plan = generate(newOpt(hours, ALL_OLD));
    } catch (e) {
      bad.crash.push(`${hours}h: ${e.message}`);
      continue;
    }
    const ids = plan.rows.map((r) => r.module.id);
    const ledger = plan.rows.reduce((a, r) => a + r.hours, 0);

    const missMust = MUST3.filter((id) => !ids.includes(id));
    const missZ = ZHUANXIANG3.filter((id) => !ids.includes(id));
    if (missMust.length) bad.must3.push(`${hours}h: 缺 ${missMust.join(",")}`);
    if (missZ.length) bad.zhuangxiang3.push(`${hours}h: 缺 ${missZ.join(",")}`);
    if (ledger !== hours) bad.ledger.push(`${hours}h: 行课时合计 ${ledger} ≠ ${hours}`);

    const rounds = plan.rounds || [];
    const rt = rounds.reduce((a, x) => a + x.hours, 0);
    console.log(
      `  ${String(hours).padStart(3)}h: 课表 ${String(plan.rows.length).padStart(2)} 行 / ${ledger} 课时` +
      `　必开 6 个=${[...MUST3, ...ZHUANXIANG3].every((id) => ids.includes(id)) ? "全在" : "缺"}` +
      `　三段=${rounds.map((r) => r.name.slice(0, 2) + r.hours).join(" ")}（和 ${rt}）` +
      `　排入模块 ${new Set(ids).size} 个`
    );
  }
  ok("[极端] done=全部42个 时程序不崩", bad.crash.length === 0, bad.crash.slice(0, 3).join(" ; ") || "4 档课时全部正常");
  ok("[极端] done=全部42个 时 m43/m44/m45 必开模块仍在课表（done 豁免生效）",
    bad.must3.length === 0, bad.must3.slice(0, 3).join(" ; ") || "三个必开模块全部命中");
  ok("[极端] done=全部42个 时 m34/m37/m38 三大专项仍在课表",
    bad.zhuangxiang3.length === 0, bad.zhuangxiang3.slice(0, 3).join(" ; ") || "三大专项全部命中");
  ok("[极端] done=全部42个 时课时账目：行课时合计 = totalHours",
    bad.ledger.length === 0, bad.ledger.slice(0, 3).join(" ; ") || "全部对齐");
}

/* ==========================================================================
   m. 必开模块最小课时：真题精讲 / 错题清零 / 综合模拟 各 ≥ 4 课时（2 次课）
   ========================================================================== */
{
  const bad = [];
  const detail = [];
  for (const hours of [40, 60, 80, 100, 120]) {
    for (const sc of DONE_SCENARIOS) {
      const plan = generate(newOpt(hours, sc.done));
      const per = {};
      plan.rows.forEach((r) => { per[r.module.id] = (per[r.module.id] || 0) + r.hours; });
      MUST3.forEach((id) => {
        const h = per[id] || 0;
        if (h < 4) bad.push(`${hours}h/${sc.label}: ${nameOf(id)} 只有 ${h} 课时`);
      });
    }
    const p0 = generate(newOpt(hours, []));
    const per0 = {};
    p0.rows.forEach((r) => { per0[r.module.id] = (per0[r.module.id] || 0) + r.hours; });
    detail.push(`${hours}h: ${MUST3.map((id) => nameOf(id) + "=" + (per0[id] || 0) + "h").join("  ")}`);
  }
  console.log("\n--- 必开模块实际课时（done=空）---");
  detail.forEach((d) => console.log("  " + d));
  ok("m. 三个必开模块各 ≥ 4 课时（2 次课）", bad.length === 0, bad.slice(0, 4).join(" ; ") || "全部达标");
}

/* ==========================================================================
   n. m41（初高中衔接与计算过关）位置修正
      —— 用真实 PRESETS 构造参数，保证与界面「套用预设」一致
      · gs1（band=1, score=38）    → m41 必须在第 1 行（不在池里也要强制加）
      · gap（band=2, score=65<70） → m41 必须在前 3 行
      · gs3（band=3, score=105）   → 不强制（只要求不崩、且 m41 仍在课表里）
   ========================================================================== */
{
  const raw = readFileSync(HTML, "utf8");
  const pm = raw.match(/const PRESETS = \{([\s\S]*?)\n\};/);
  ok("能从 math-plan.html 解析出 PRESETS", !!pm);
  const PRESETS = pm ? vm.runInNewContext("({" + pm[1] + "})") : {};
  ok("PRESETS 含 gs1 / gap / gs3", !!(PRESETS.gs1 && PRESETS.gap && PRESETS.gs3),
    Object.keys(PRESETS).join(","));

  const fromPreset = (key, done) => {
    const p = PRESETS[key];
    const o = newOpt(p.hours, done || []);
    Object.assign(o, {
      grade: p.grade, phase: p.phase, score: p.score, target: p.target,
      freq: p.freq, freqH: p.freqH, weeks: p.weeks, holidayWeeks: p.holidayWeeks,
      focus: p.focus, note: p.note,
    });
    // generate() 会先算 band 再调 pickModules；直接调 pickModules 时要自己补上，
    // 否则 o.band 为 undefined，m41 的位置修正分支不会被触发。
    o.band = bandOf(o.score);
    return o;
  };
  const rowIds = (plan) => {
    const out = [];
    plan.rows.forEach((r) => { if (out[out.length - 1] !== r.module.id) out.push(r.module.id); });
    return out;
  };
  const firstOccurrence = (ids, id) => ids.indexOf(id) + 1;   // 1-based，「第几行」

  // ---- gs1: band=1 → 第 1 行必须是 m41 ----
  {
    const o = fromPreset("gs1");
    const plan = generate(o);
    const ids = rowIds(plan);
    ok("gs1 的 band 确认为 1", plan.band === 1, `band=${plan.band}`);
    ok("gs1（band=1）：m41 出现在课表里", ids.includes("m41"), `首行=${nameOf(ids[0] || "")}`);
    ok("gs1（band=1）：m41 排在第 1 行", firstOccurrence(ids, "m41") === 1,
      `实际第 ${firstOccurrence(ids, "m41")} 行；前 3 行=${ids.slice(0, 3).map(nameOf).join(" / ")}`);
    ok("gs1（band=1）：第 1 行就是 m41 且整行 2 课时",
      plan.rows[0].module.id === "m41" && plan.rows[0].hours === 2,
      `${nameOf(plan.rows[0].module.id)} / ${plan.rows[0].hours}h`);
  }

  // ---- gs1 且 m41 被勾「已完成」→ 仍必须强制出现在第 1 行 ----
  {
    const o = fromPreset("gs1", ["m41"]);
    const plan = generate(o);
    const ids = rowIds(plan);
    ok("gs1 + m41 勾选已完成：m41 仍被强制排在第 1 行（豁免 done）",
      firstOccurrence(ids, "m41") === 1,
      `实际第 ${firstOccurrence(ids, "m41")} 行；首行=${nameOf(ids[0] || "")}`);
  }

  // ---- gap: band=2 且 score=65 < 70 → 前 3 行含 m41 ----
  {
    const o = fromPreset("gap");
    const plan = generate(o);
    const ids = rowIds(plan);
    const pos = firstOccurrence(ids, "m41");
    ok("gap 的 band 确认为 2", plan.band === 2, `band=${plan.band}`);
    ok("gap 的 score < 70（规则触发条件）", o.score < 70, `score=${o.score}`);
    ok("gap（band=2, score=65）：m41 出现在前 3 行",
      pos >= 1 && pos <= 3, `实际第 ${pos} 行；前 3 行=${ids.slice(0, 3).map(nameOf).join(" / ")}`);
  }

  // ---- gap 且 m41 不在池里（勾已完成）→ 不加、不崩 ----
  {
    const o = fromPreset("gap", ["m41"]);
    let plan = null, err = null;
    try { plan = generate(o); } catch (e) { err = e.message; }
    ok("gap + m41 勾选已完成：不报错（按规则「不在池里就不加」）", !err, err || "");
    if (plan) {
      ok("gap + m41 已完成：m41 未出现在前 3 行（未被强制插入）",
        !rowIds(plan).slice(0, 3).includes("m41"),
        `前 3 行=${rowIds(plan).slice(0, 3).map(nameOf).join(" / ")}`);
    }
  }

  // ---- gs3: band=3 → 不强制 ----
  {
    const o = fromPreset("gs3");
    const plan = generate(o);
    const ids = rowIds(plan);
    ok("gs3 的 band 确认为 3", plan.band === 3, `band=${plan.band}`);
    ok("gs3（band=3）：课表生成不崩且有内容", plan.rows.length > 0, `${plan.rows.length} 行`);
    ok("gs3（band=3）：m41 仍在课表里（只是位置不强制）", ids.includes("m41"), "");
    console.log(`      gs3 里 m41 在第 ${firstOccurrence(ids, "m41")} 行（不强制，仅供观察）`);
  }

  // ---- 其他模块相对顺序不能被打乱（只挪 m41 一个）----
  {
    const o = fromPreset("gs1");
    const picked = pickModules(o);                 // 已含位置修正
    const without41 = picked.filter((m) => m.id !== "m41").map((m) => m.id);
    ok("pickModules 返回的是模块数组（修正后仍是 module 而非包装对象）",
      picked.length > 0 && picked.every((m) => m && typeof m.id === "string"), `首项=${picked[0] && picked[0].id}`);
    ok("修正后 m41 在数组首位", picked[0].id === "m41", `首位=${picked[0].id}`);
    ok("除 m41 外其余模块都在且不重复",
      without41.length === picked.length - 1 && new Set(picked.map((m) => m.id)).size === picked.length,
      `${without41.length} 个`);
  }
}

/* ==========================================================================
   o. 自检「目标量化」不得误报，且不合格时必须点名到行
      —— 对全部预设跑一遍 generate + selfCheck（纯逻辑，不依赖浏览器）

   踩过的坑：收尾行「全卷得分达到 95 分…」里的「达到」不在判定词表里，
   于是 6 个预设**每一个**都报「有 1 行目标缺少量化指标」，且都指向最后一行 ——
   老师只看到「有 1 行」，根本不知道改哪一行，等于自检没法用。
   ========================================================================== */
{
  const raw = readFileSync(HTML, "utf8");
  const pm = raw.match(/const PRESETS = \{([\s\S]*?)\n\};/);
  const PRESETS = pm ? vm.runInNewContext("({" + pm[1] + "})") : {};

  const fromPreset = (key, done) => {
    const p = PRESETS[key];
    const o = newOpt(p.hours, done || []);
    Object.assign(o, {
      grade: p.grade, phase: p.phase, score: p.score, target: p.target,
      freq: p.freq, freqH: p.freqH, weeks: p.weeks, holidayWeeks: p.holidayWeeks,
      focus: p.focus, note: p.note,
    });
    o.band = bandOf(o.score);
    return o;
  };

  const keys = Object.keys(PRESETS);
  ok("o. 能从 math-plan.html 解析出全部预设", keys.length >= 6, keys.join(","));

  // ---- 1) 每个预设的「目标量化」都必须是 ok（收尾行不能再被误判）----
  // ⚠️ 必须**精确匹配标题**：自检里还有一项「目标方向」（恒为 ok），
  //    用 /目标/ 会先命中它，断言就变成永远成立、抓不到任何 bug（本组断言第一版就踩了这个坑）。
  const isQuantCheck = (c) => c[1] === "目标量化" || c[1] === "目标全部量化";
  const notOk = [];
  keys.forEach((k) => {
    const plan = generate(fromPreset(k));
    const item = (plan.checks || []).find(isQuantCheck);
    if (!item) notOk.push(`${k}: 自检里找不到「目标量化」项`);
    else if (item[0] !== "ok") notOk.push(`${k}: ${item[1]} → ${item[2]}`);
  });
  ok(`o. 全部 ${keys.length} 个预设：自检「目标量化」均为 ok（不再误报收尾行）`,
    notOk.length === 0, notOk.slice(0, 3).join(" ; ") || "全部通过");

  // ---- 2) 收尾行「达到 N 分」必须被判为已量化（本次 bug 的正主）----
  {
    const plan = generate(fromPreset("gap"));
    const last = plan.rows[plan.rows.length - 1];
    ok("o. 收尾行目标含「达到 N 分」且能通过量化判定",
      /达到/.test(last.goal) && !/目标量化/.test(JSON.stringify(plan.checks.filter((c) => c[0] !== "ok"))),
      `[${last.stage}] ${last.goal.slice(0, 40)}`);
  }

  // ---- 3) 真的不合格时，必须点名「第几行 + 阶段名 + 总数」----
  {
    const o = fromPreset("gap");
    const plan = generate(o);
    const target = plan.rows[2];
    const mutated = { ...plan, rows: plan.rows.map((r, i) => (i === 2 ? { ...r, goal: "能理解概念" } : r)) };
    const item = (selfCheck(o, mutated) || []).find((c) => c[1] === "目标量化");
    const detail = item ? String(item[2]) : "";
    ok("o. 存在未量化行时给出 warn", !!item && item[0] === "warn", item ? item[0] : "未找到该项");
    ok("o. 未量化提示点名了行号「第 3 行」", /第 3 行/.test(detail), detail.slice(0, 96));
    ok("o. 未量化提示点名了阶段名", !!target && detail.includes(String(target.stage).slice(0, 8)), detail.slice(0, 96));
    ok("o. 未量化提示给出了总行数", /共 1 行/.test(detail), detail.slice(0, 96));
  }
}

/* ==========================================================================
   汇总
   ========================================================================== */
const passed = results.filter((r) => r.pass).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
if (passed !== results.length) {
  console.log("\n失败项：");
  results.filter((r) => !r.pass).forEach((r) => console.log("  ✗ " + r.name));
}
process.exit(passed === results.length ? 0 : 1);
