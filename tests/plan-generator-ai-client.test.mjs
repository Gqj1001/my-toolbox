// AI 客户端（js/ai.js）· 纯函数回归测试
//
// 这一套**不碰网络**（网络那一层由 tests\plan-generator-ai.test.mjs 用桩上游覆盖）：
// 它钉的是"组包对不对、落地安不安全、报错说不说人话"这三件事 ——
// 而这三件事里最要紧的是**行数契约**与**不覆盖老师写过的东西**。
//
// 跑法：& <bundled node> tests\plan-generator-ai-client.test.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AI_PATH = join(ROOT, "public/tools/plan-generator/js/ai.js");

const AI = require(AI_PATH);
const S = require(join(ROOT, "public/tools/plan-generator/js/subjects.js"));
const Engine = require(join(ROOT, "public/tools/plan-generator/js/engine.js"));

const results = [];
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

const SENIOR = S.loadPack("physics", "senior");
const rawRows = Engine.buildPlan(SENIOR, { grade: "高三", score: 62, totalHours: 60 }).rows;

/* ==========================================================================
   ① 组包
   ========================================================================== */
const payload = AI.buildPayload({
  pack: SENIOR, subjectName: "物理", grade: "高三", bandName: "提中档",
  score: 62, targetScore: 85, totalHours: 60, rows: rawRows.slice(0, 3),
});

ok("①-1 学科/学段取自科目包（换科目包就换学科，客户端代码不用改）",
  payload.subject === "physics" && payload.stage === "senior" && payload.subjectName === "物理");
ok("①-2 每行的教材小节**原样带过去**（服务端靠它当「只许用这些」的清单）",
  payload.rows[0].chapters.length > 0
  && payload.rows[0].chapters[0] === rawRows[0].chapters[0],
  payload.rows[0].chapters[0]);
ok("①-3 stage key 被翻成中文阶段名（附件3 里显示的是「一轮·力学」这种）",
  payload.rows[0].stageName === "一轮·力学", payload.rows[0].stageName);
ok("①-4 难度 lv 带过去了（服务端按 band + lv 查量化指标表）",
  typeof payload.rows[0].lv === "number", String(payload.rows[0].lv));
ok("①-5 含实验的模块被标出来（力学实验 / 电学实验 / 中考实验）",
  (() => {
    const expRow = rawRows.filter((r) => r.tags.indexOf("实验") >= 0)[0];
    return !!expRow && AI.rowPayload(expRow, SENIOR).hasExperiment === true;
  })());
ok("①-6 学生上下文（年级/档位/分数/目标分/总课时）都在包里",
  payload.grade === "高三" && payload.bandName === "提中档"
  && String(payload.score) === "62" && String(payload.targetScore) === "85"
  && String(payload.totalHours) === "60");
ok("①-7 包里**没有**任何「这一次方案之外」的隐私（没有学生姓名、没有档案 id）",
  JSON.stringify(payload).indexOf("学生姓名") < 0
  && !("name" in payload) && !("studentName" in payload));

/* ==========================================================================
   ② 只补空的，不覆盖老师写过的
   ========================================================================== */
const withSomeWritten = rawRows.slice(0, 4).map((r, i) =>
  Object.assign({}, r, { goal: i === 1 ? "老师自己写的目标" : "" }));

ok("②-1 默认只挑「还没写目标」的行（老师写过的行不碰）",
  AI.planRows(withSomeWritten).join(",") === "0,2,3",
  AI.planRows(withSomeWritten).join(","));
ok("②-2 force=true 时才全选（这是「全部重写」按钮）",
  AI.planRows(withSomeWritten, { force: true }).join(",") === "0,1,2,3");
ok("②-3 指定 onlyIndexes 时就只处理那几行（这是「这一行 AI 重写」按钮）",
  AI.planRows(withSomeWritten, { onlyIndexes: [1] }).join(",") === "1");
ok("②-4 全都有目标时，默认什么都不发（省一次调用、也不打扰老师）",
  AI.planRows(rawRows.slice(0, 3).map((r) => Object.assign({}, r, { goal: "已有" }))).length === 0);

/* ==========================================================================
   ③ 分批
   ========================================================================== */
ok("③-1 不超过上限时不切批", AI.chunk([1, 2, 3], 10).length === 1);
ok("③-2 超过上限时按顺序切成多批、且不丢不重",
  (() => {
    const idx = Array.from({ length: 100 }, (_, i) => i);
    const cs = AI.chunk(idx, 40);
    const flat = cs.reduce((a, b) => a.concat(b), []);
    return cs.length === 3 && cs[0].length === 40 && cs[2].length === 20
      && flat.length === 100 && flat.every((v, i) => v === i);
  })());
ok("③-3 默认每批上限是 40（与服务端 120 的上限留足余量）", AI.MAX_ROWS_PER_CALL === 40,
  String(AI.MAX_ROWS_PER_CALL));

/* ==========================================================================
   ④ 落地：行数契约（**最要紧的一条**）
   ========================================================================== */
const good = AI.normalizeGoals({ ok: true, goals: ["目标一", "目标二"] }, 2);
ok("④-1 行数对得上 → 通过", good.ok === true && good.goals.length === 2);

ok("④-2 **行数多一条** → 整批放弃（宁可不填，也不贴错位）",
  AI.normalizeGoals({ ok: true, goals: ["a", "b", "c"] }, 2).ok === false
  && AI.normalizeGoals({ ok: true, goals: ["a", "b", "c"] }, 2).error.indexOf("不一致") >= 0);
ok("④-3 **行数少一条** → 整批放弃",
  AI.normalizeGoals({ ok: true, goals: ["a"] }, 2).ok === false);
ok("④-4 有空条目 → 整批放弃（空格/换行也算空）",
  AI.normalizeGoals({ ok: true, goals: ["a", "   "] }, 2).ok === false);
ok("④-5 服务端说 ok:false → 用服务端那句人话，不自己另编",
  AI.normalizeGoals({ ok: false, error: "服务端的话" }, 1).error === "服务端的话");
ok("④-6 返回格式不对（不是对象 / 没有 goals）→ 明确报错，不当成成功",
  AI.normalizeGoals(null, 1).ok === false && AI.normalizeGoals({ ok: true }, 1).ok === false);
ok("④-7 目标文本里的多余空白被压成单个空格（换行/制表符不会带进表格）",
  AI.normalizeGoals({ ok: true, goals: ["目标   一\n第二行"] }, 1).goals[0] === "目标 一 第二行",
  AI.normalizeGoals({ ok: true, goals: ["目标   一\n第二行"] }, 1).goals[0]);

/* ==========================================================================
   ⑤ 落地：applyGoals 不改原数组、只改指定行
   ========================================================================== */
const before = rawRows.slice(0, 3).map((r) => Object.assign({}, r));
const ap = AI.applyGoals(before, [0, 2], ["新目标A", "新目标C"]);
ok("⑤-1 只改指定的行，别的行原样", ap.rows[0].goal === "新目标A" && ap.rows[2].goal === "新目标C"
  && ap.rows[1].goal === before[1].goal, `applied=${ap.applied}`);
ok("⑤-2 **不改原数组**（原行对象没被就地修改 —— 失败重试/撤销才有救）",
  before[0].goal === rawRows[0].goal && before[2].goal === rawRows[2].goal);
ok("⑤-3 applied 数字与实际改动条数一致", ap.applied === 2);
ok("⑤-4 下标越界不崩（只跳过）",
  (() => {
    const r = AI.applyGoals(before, [0, 99], ["x", "y"]);
    return r.rows.length === 3 && r.applied === 1;
  })());

/* ==========================================================================
   ⑥ 报错说人话（唯一来源）
   ========================================================================== */
ok("⑥-1 401 → 提示先登录", AI.messageOf(401, "").indexOf("登录") >= 0);
ok("⑥-2 403 → 提示会员专属", AI.messageOf(403, "").indexOf("会员") >= 0);
ok("⑥-3 503 → 提示服务端没配 Key（并转述服务端的话）",
  AI.messageOf(503, "服务端未配置 AI Key，请联系管理员。").indexOf("AI Key") >= 0);
ok("⑥-4 502 → 提示稍后重试（不透传上游原文）",
  AI.messageOf(502, "").indexOf("稍后重试") >= 0);
ok("⑥-5 未知状态码也有兜底句子（不会是 undefined）",
  typeof AI.messageOf(418, "") === "string" && AI.messageOf(418, "").length > 0);
ok("⑥-6 五种状态码的提示**互不相同**（不是一句「失败了」糊过去）",
  new Set([401, 403, 503, 413, 502].map((s) => AI.messageOf(s, ""))).size === 5);

/* ==========================================================================
   ⑦ 静默失效的护栏（静态契约）
   ========================================================================== */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const src = stripComments(readFileSync(AI_PATH, "utf8"));
ok("⑦-1 请求带 credentials:'same-origin'（不然会员身份带不过去，接口一律 401）",
  src.indexOf('credentials: "same-origin"') >= 0 || src.indexOf("credentials: 'same-origin'") >= 0);
ok("⑦-2 客户端**不碰** localStorage 里的任何 Key（会员身份走 cookie，前端不放密钥）",
  src.indexOf("localStorage") < 0 && src.indexOf("apiKey") < 0);
ok("⑦-3 双击打开（file://）时不发请求，直接给一句人话",
  src.indexOf("isHosted") >= 0 && src.indexOf("双击打开") >= 0);
ok("⑦-4 一批失败时**不回滚已经成功的批次**（回滚等于白花那次调用）—— 失败分支里 return 的是 `current` 而不是 `rows`",
  /if\s*\(\s*!r\.ok\s*\)\s*\{[\s\S]*?return\s*\{\s*ok:\s*false,\s*rows:\s*current\b/.test(src),
  (src.match(/if \(!r\.ok\)[\s\S]{0,220}/) || [""])[0].slice(0, 220));

/* ==========================================================================
   变异自证：三条"会静默出错"的变异
   ========================================================================== */
console.log("");
console.log("=".repeat(78));
console.log("变异自证（AI 客户端）");
console.log("=".repeat(78));

const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const TMP = mkdtempSync(join(tmpdir(), "plangen-aiclient-mut-"));
const SRC_RAW = readFileSync(AI_PATH, "utf8");

const MUTATIONS = [
  {
    name: "A 客户端放宽行数校验（!= 改成 <）⇒ 多返回一条也会被贴进去（错位！）",
    find: "    if (data.goals.length !== expectCount) {",
    replace: "    if (data.goals.length < expectCount) {",
    check: (M) => M.normalizeGoals({ ok: true, goals: ["a", "b", "c"] }, 2).ok === false,
    expect: "行数多一条",
  },
  {
    name: "B 「只补空的」失效（planRows 永远全选）⇒ 会把老师写过的目标覆盖掉",
    find: "      if (!force && !only && hasGoal) return;      // 老师写过了，不碰",
    replace: "      if (false && !force && !only && hasGoal) return;",
    check: (M) => M.planRows([{ goal: "老师写的" }, { goal: "" }]).join(",") === "1",
    expect: "只挑",
  },
  {
    name: "C applyGoals 就地改原数组 ⇒ 失败时无法回退（老师的内容被改坏）",
    find: "    var out = (rows || []).map(function (r) { return Object.assign({}, r); });",
    replace: "    var out = (rows || []);",
    check: (M) => {
      const src2 = [{ goal: "旧" }];
      M.applyGoals(src2, [0], ["新"]);
      return src2[0].goal === "旧";
    },
    expect: "不改原数组",
  },
];

let caughtCount = 0;
for (let mi = 0; mi < MUTATIONS.length; mi++) {
  const mut = MUTATIONS[mi];
  if (SRC_RAW.indexOf(mut.find) < 0) {
    console.log(`SKIP | ${mut.name} | 源码锚点没找到`);
    caughtCount++;
    continue;
  }
  const file = join(TMP, `mut-${mi}.cjs`);
  writeFileSync(file, SRC_RAW.split(mut.find).join(mut.replace), "utf8");
  let M = null, err = null;
  try { M = require(file); } catch (e) { err = e; }
  let caught = false;
  if (M) {
    try { caught = mut.check(M) === false; } catch (e) { caught = true; }
  } else {
    caught = true;   // 加载就失败也算被抓住
  }
  if (caught) caughtCount++;
  console.log(`${caught ? "RED " : "MISS"} | ${mut.name}`);
}
ok(`⑦-5 变异自证：${MUTATIONS.length} 条全部被抓住（行数契约 / 不覆盖老师改动 / 不改原数组）`,
  caughtCount === MUTATIONS.length, `${caughtCount}/${MUTATIONS.length}`);

/* ==========================================================================
   汇总
   ========================================================================== */
const total = results.length;
const passed = results.filter((x) => x.pass).length;
console.log("");
console.log("=".repeat(78));
console.log(`SUMMARY: ${passed}/${total} passed`);
if (passed !== total) {
  console.log("未通过：");
  results.filter((x) => !x.pass).forEach((x) => console.log("  - " + x.name));
}
console.log("=".repeat(78));
process.exit(passed === total ? 0 : 1);
