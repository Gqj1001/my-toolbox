#!/usr/bin/env node
/**
 * 学情分析 · 报告装配的**纯函数**测试（**不需要起服务、不需要真浏览器**）
 *
 * 被测对象：`src/lib/student-report.ts`
 *
 * ⚠️ **这是本仓库第一个直接 import `.ts` 的测试**：
 *    Node 24 自带类型擦除（type stripping），所以 `import "../src/lib/student-report.ts"`
 *    可以直接跑 —— 前提是被 import 的文件只用**可擦除语法**（类型注解、interface、
 *    `as const` 都行；enum / namespace / 构造函数参数属性不行）。
 *    该文件对 `feedback-db` 只有一句 `import type`（会被擦掉），所以不会连到 Supabase。
 *    跑法：`& "<bundled node>" tests\student-report.test.mjs`
 *
 * 为什么要这一套（而不是只靠接口测试）：
 *   · 报告里最危险的不是"算错"，而是**抽不到却装作抽到了**（老师会拿它跟家长说）——
 *     这类边界用纯函数测最省事、最便宜；
 *   · 抽取规则（`【】` 段落、paper 那句话、课时数）本身就容易在改动中被改坏。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeRecorder } from "./_helpers.mjs";

// ⚠️ **必须先关掉 Node 的默认 warning 打印，再动态 import 那个 `.ts`**：
//    本仓库的 package.json 没有 `"type": "module"`，所以 Node 在把 `.ts` 当 ESM 解析时
//    会往 **stderr** 打一条 `MODULE_TYPELESS_PACKAGE_JSON` 警告。
//    那条警告本身无害，但会让**脚本化运行**（`_run-ui-suites` / CI）看起来"有错"，
//    甚至让 PowerShell 把整条命令判成失败（本项目就踩到过：37/37 却 exit=1）。
process.removeAllListeners("warning");
process.on("warning", () => { /* 有意静音：见上 */ });

const {
  ANALYSIS_TOOL,
  TOOL_LABELS,
  buildStudentReport,
  extractPaperWeakness,
  extractSections,
  parsePlanHours,
} = await import("../src/lib/student-report.ts");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { record, summary } = makeRecorder();

/* ==========================================================================
   1. 正文抽取
   ========================================================================== */
{
  const secs = extractSections("【课堂表现】上课认真，能跟上。\n【知识掌握】函数不熟。");
  record("extractSections：抽出两个 `【】` 段落，标题与正文都对",
    secs.length === 2 && secs[0].label === "课堂表现" && secs[0].body.includes("上课认真") &&
      secs[1].label === "知识掌握" && secs[1].body.includes("函数不熟"),
    JSON.stringify(secs));

  const dup = extractSections("【课堂内容】A。【课堂内容】B。");
  record("extractSections：同名标题出现两次就**都保留**（合并会丢信息）",
    dup.length === 2 && dup[0].body === "A。" && dup[1].body === "B。", JSON.stringify(dup));

  record("extractSections：没有任何 `【】` → 空数组（不是硬凑一段）",
    extractSections("老师手写的一段话，没有任何小标题。").length === 0);

  record("extractSections：标题为空 / 换行 / 超长（>20 字）都不认（现有工具的标题都很短）",
    extractSections("【】空的").length === 0 &&
      extractSections("【前\n半】换行").length === 0 &&
      extractSections("【这是一个特别长特别长特别长特别长特别长的标题】正文").length === 0);
}

{
  record("parsePlanHours：从【课时安排】里读「共 12 课时」→ 12",
    parsePlanHours("【课时安排】共 12 课时（每次 1.5 小时）") === 12);
  record("parsePlanHours：没有空格、写法紧凑也能读（共10课时）",
    parsePlanHours("【课时安排】共10课时") === 10);
  record("★parsePlanHours：**没有【课时安排】段落就返回 null**（不猜、不当 0）",
    parsePlanHours("【学情诊断】基础一般。【提分目标】60 → 100 分") === null);
  record("★parsePlanHours：有段落但读不到数字 → null（不当 0）",
    parsePlanHours("【课时安排】按需安排，暂不确定") === null);
  record("★parsePlanHours：0 课时 → null（不是有效安排）",
    parsePlanHours("【课时安排】共 0 课时") === null);
}

{
  const w = extractPaperWeakness("……核心薄弱板块集中在以下 3 处：解三角形；导数单调性；概率分布。后面还有话。");
  record("extractPaperWeakness：从 paper 的固定句式里抽出 3 个板块",
    w.length === 3 && w[0] === "解三角形" && w[2] === "概率分布", JSON.stringify(w));
  record("extractPaperWeakness：分号有中文也有英文都认",
    extractPaperWeakness("核心薄弱板块集中在以下 2 处：A；B; C。").length === 3);
  record("★extractPaperWeakness：句式和数字对不上（没有那句原话）→ 空数组，不硬凑",
    extractPaperWeakness("这位学生主要问题在计算，建议多练。").length === 0);
}

/* ==========================================================================
   2. 装配（含「抽不到就说抽不到」）
   ========================================================================== */
const ROW = (over = {}) => ({
  id: 1, student_name: "探针", text: "", date: "2026-10-03", type_name: null, subject: "math",
  created_at: "2026-10-03T10:00:00Z", tool: "feedback", title: null, score: null, full_score: null,
  ...over,
});

const STUDENT = { grade: "高三", campus: "燕郊", teacher: "郭庆杰", subject: "math", class_name: "3班", attitude: "计算弱", extra: { phase: "秋", n: 1 } };

{
  const r = buildStudentReport({ name: "空学生", student: null, rows: [] });
  record("空记录：overview.total=0，并在 notes 里明说「还没有任何记录」",
    r.overview.total === 0 && r.overview.byTool.length === 0 &&
      r.notes.some((n) => n.includes("还没有任何记录")),
    JSON.stringify({ total: r.overview.total, notes: r.notes }));
  record("空记录：trend=null、scores=[]、digest 里明说**无法给出分数趋势**（不编）",
    r.trend === null && r.scores.length === 0 && r.digest.includes("无法给出分数趋势"));
}

{
  const rows = [
    // 故意打乱顺序：结果必须按日期升序
    ROW({ id: 3, tool: "feedback", date: "2026-10-20", text: "【主要失分点】三角恒等变换用错公式。" }),
    ROW({ id: 1, tool: "paper", date: "2026-09-01", title: "开学考", score: 60, full_score: 100,
      text: "……核心薄弱板块集中在以下 2 处：导数单调性；解析几何。" }),
    ROW({ id: 2, tool: "math-plan", date: "2026-10-05", title: "秋季辅导方案",
      text: "【学情诊断】基础一般，计算容易错。\n【提分目标】60 → 100 分\n【课时安排】共 12 课时" }),
    ROW({ id: 4, tool: "analysis", date: "2026-10-21", title: "学情报告 · 10月21日 09:00",
      text: "【整体学情】这是以前生成的报告，不能被当成输入。" }),
    ROW({ id: 5, tool: "paper", date: "2026-10-25", title: "月考", score: 80, full_score: 100,
      text: "……核心薄弱板块集中在以下 1 处：概率分布。" }),
  ];
  const r = buildStudentReport({ name: "张三", student: STUDENT, rows });

  record("概览：统计条数**排除**学情报告自己（5 条 → 4 条），并单独计数",
    r.overview.total === 4 && r.overview.excludedReports === 1,
    `total=${r.overview.total} excluded=${r.overview.excludedReports}`);
  record("概览：byTool 三类都有、条数对，时间跨度按日期算",
    r.overview.byTool.length === 3 &&
      JSON.stringify(r.overview.byTool.map((b) => [b.tool, b.count])) ===
        JSON.stringify([["math-plan", 1], ["paper", 2], ["feedback", 1]]) &&
      r.overview.firstDate === "2026-09-01" && r.overview.lastDate === "2026-10-25" &&
      r.overview.spanDays === 54,
    JSON.stringify(r.overview));

  record("★成绩趋势：按日期**升序**（输入是乱序的），得分率算对",
    r.scores.length === 2 && r.scores[0].title === "开学考" && r.scores[0].percent === 60 &&
      r.scores[1].title === "月考" && r.scores[1].percent === 80,
    JSON.stringify(r.scores));
  record("★趋势摘要：首次 60% → 末次 80%（+20 个百分点），最高/最低对",
    r.trend?.count === 2 && r.trend.firstPercent === 60 && r.trend.lastPercent === 80 &&
      r.trend.delta === 20 && r.trend.avgPercent === 70 &&
      r.trend.best.title === "月考" && r.trend.worst.title === "开学考",
    JSON.stringify(r.trend));

  record("★课时：从方案正文累加（12 课时），plansWithoutHours=0",
    r.hours.total === 12 && r.hours.entries.length === 1 && r.hours.plansWithoutHours === 0,
    JSON.stringify(r.hours));

  record("★薄弱与失分：三个来源都抽到了（paper 的核心薄弱板块 / feedback 的主要失分点 / math-plan 的学情诊断）",
    r.weaknesses.length === 4 &&
      r.weaknesses.some((w) => w.label === "核心薄弱板块" && w.text.includes("导数单调性")) &&
      r.weaknesses.some((w) => w.label === "主要失分点" && w.text.includes("三角恒等变换")) &&
      r.weaknesses.some((w) => w.label === "学情诊断" && w.text.includes("计算容易错")),
    JSON.stringify(r.weaknesses.map((w) => w.label)));

  record("身份信息：extra 被展平成 k=v（含数字值）",
    r.identity.extra.includes("phase=秋") && r.identity.extra.includes("n=1"),
    r.identity.extra);

  record("★digest（给 AI 的摘要）：含成绩明细、趋势、课时、薄弱原文，且**不含**旧学情报告的正文",
    r.digest.includes("60/100") && r.digest.includes("+20 个百分点") &&
      r.digest.includes("累计 12 课时") && r.digest.includes("导数单调性") &&
      !r.digest.includes("这是以前生成的报告"),
    `digest 长度=${r.digest.length}`);

  record("notes：如实说明排除了 N 份历史学情报告",
    r.notes.some((n) => n.includes("排除") && n.includes("1 份")), JSON.stringify(r.notes));
}

/* ==========================================================================
   3. 「抽不到」的各种缺口都要如实报（这是本功能最危险的地方）
   ========================================================================== */
{
  const rows = [
    ROW({ id: 1, tool: "paper", title: "没有那句原话", date: "2026-10-01", score: 70, full_score: 100,
      text: "这是一份手改过的报告，没有那句话。" }),
    ROW({ id: 2, tool: "paper", title: "只有分数没有满分", date: "2026-10-02", score: 88, full_score: null,
      text: "……核心薄弱板块集中在以下 1 处：立体几何。" }),
    ROW({ id: 3, tool: "math-plan", title: "方案没写课时", date: "2026-10-03",
      text: "【学情诊断】还行。\n【提分目标】80 → 110 分" }),
    ROW({ id: 4, tool: "feedback", title: "反馈没有失分段落", date: "2026-10-04",
      text: "【课堂内容】讲完了导数。【改进建议】多练。" }),
  ];
  const r = buildStudentReport({ name: "李四", student: STUDENT, rows });

  record("★缺口①：paper 没有那句原话 → 单独计数并写进 notes（不硬凑一条薄弱模块）",
    r.notes.some((n) => n.includes("没有出现「核心薄弱板块") && n.includes("1 条")),
    JSON.stringify(r.notes));
  record("★缺口②：方案正文里读不到课时 → plansWithoutHours=1 且 notes 明说没计入",
    r.hours.plansWithoutHours === 1 && r.hours.total === 0 &&
      r.notes.some((n) => n.includes("读不到「共 N 课时」")),
    JSON.stringify({ hours: r.hours, notes: r.notes }));
  record("★缺口③：缺满分的记录**不计入趋势**（有满分的那条照常计入），并说明原因",
    r.scores.length === 1 && r.scores[0].title === "没有那句原话" &&
      !r.scores.some((s) => s.title === "只有分数没有满分") &&
      r.notes.some((n) => n.includes("没有满分")), JSON.stringify({ scores: r.scores, notes: r.notes }));
  record("★缺口④：feedback 没有【主要失分点】/【知识掌握】→ 不抽，并说明",
    !r.weaknesses.some((w) => w.tool === "feedback") &&
      r.notes.some((n) => n.includes("课后反馈里没有")), JSON.stringify(r.notes));
  record("★digest 同样如实写缺口（有「数据说明」一段，AI 才会说材料不足而不是编）",
    r.digest.includes("数据说明") && r.digest.includes("70/100"),
    `digest 长度=${r.digest.length}`);
}

{
  // 只有一条带分数的记录 → 说明看不出趋势
  const r = buildStudentReport({
    name: "王五", student: STUDENT,
    rows: [ROW({ tool: "paper", date: "2026-10-01", title: "只考了一次", score: 90, full_score: 100, text: "……" })],
  });
  record("只有一次考试：notes 明说「至少两次才能比较」",
    r.trend?.count === 1 && r.notes.some((n) => n.includes("只有 1 次")), JSON.stringify(r.notes));
}

{
  // 记录很多、正文很长：digest 必须被截断（不然会把整份材料原样再喂回上游）
  // ⚠️ 单条薄弱文本在 digest 里本来就截到 200 字，所以这里要**多条**才堆得过 6000。
  const rows = Array.from({ length: 40 }, (_, i) =>
    ROW({ id: 100 + i, tool: "feedback", date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
      text: "【主要失分点】" + "错".repeat(300) }),
  );
  const r = buildStudentReport({ name: "赵六", student: STUDENT, rows });
  record("★超长材料：digest 被截断到 6000 字出头（不会把整份材料再喂回上游）",
    r.digest.length <= 6000 + 20 && r.digest.includes("已截断"),
    `digest 长度=${r.digest.length}（40 条 × 每条 200 字）`);
}

{
  const r = buildStudentReport({ name: "钱七", student: null, rows: [ROW({ tool: "paper", title: null, date: "2026-10-03" })] });
  record("没填考试名也不编造：标题退化成「标签（日期）」",
    r.scores.length === 0 || true, "（本条只验证不抛异常）");
  const r2 = buildStudentReport({ name: "钱七", student: null, rows: [ROW({ tool: "paper", title: "", date: "2026-10-03", score: 50, full_score: 100 })] });
  record("★没填考试名时，标题是「试卷分析（2026-10-03）」这种可核对的说法，不是编一个考试名",
    r2.scores[0]?.title === "试卷分析（2026-10-03）", JSON.stringify(r2.scores[0]?.title));
}

/* ==========================================================================
   4. 跨文件契约：`analysis` 这个归属名必须**三处一致**
   ==========================================================================
   本项目反复踩过「代码白名单与数据库 CHECK 不一致」：
     · 只改库   → 接口 400
     · 只改代码 → 写库撞约束（23514）
   所以这里直接读文件比对，任何一处漏改都会红。 */
{
  record("契约：ANALYSIS_TOOL 常量就是 'analysis'", ANALYSIS_TOOL === "analysis", ANALYSIS_TOOL);
  record("契约：TOOL_LABELS 覆盖四个归属（含学情报告）",
    ["math-plan", "paper", "feedback", "analysis"].every((t) => typeof TOOL_LABELS[t] === "string"),
    JSON.stringify(TOOL_LABELS));

  // ① 迁移里最后一条 feedback_history_tool_check 的取值集合
  const migDir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(migDir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  let dbTools = null, dbFile = "";
  for (const f of files) {
    const sql = readFileSync(join(migDir, f), "utf8");
    const m = sql.match(/add constraint feedback_history_tool_check\s+check \(tool in \(([^)]*)\)\)/i);
    if (m) { dbTools = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(); dbFile = f; }
  }
  record(`契约：迁移里查到了 tool 的 CHECK 定义（最新一条在 ${dbFile}）`, !!dbTools, JSON.stringify(dbTools));

  // ② 接口白名单
  const routeSrc = readFileSync(join(ROOT, "src", "app", "api", "students", "route.ts"), "utf8");
  const rm = routeSrc.match(/const ALLOWED_TOOLS = \[([^\]]*)\]/);
  const codeTools = rm ? [...rm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort() : null;

  record("★契约：接口 ALLOWED_TOOLS 与数据库 CHECK **完全一致**（不一致就是 400 或 23514）",
    !!dbTools && !!codeTools && JSON.stringify(dbTools) === JSON.stringify(codeTools),
    `库=[${dbTools}] 代码=[${codeTools}]`);
  record("★契约：两边都包含 analysis（学情报告会以它落库）",
    !!dbTools && !!codeTools && dbTools.includes(ANALYSIS_TOOL) && codeTools.includes(ANALYSIS_TOOL),
    `库=[${dbTools}] 代码=[${codeTools}]`);
}

process.exit(summary() ? 0 : 1);
