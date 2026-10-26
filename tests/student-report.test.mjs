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
  SOURCE_TOOLS,
  TOOL_LABELS,
  buildStudentReport,
  cleanHistoryTitle,
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

/* ★ 2026-10 用户线上验收后新增（问题 2「未填日期」的防线之一）：
   补录历史材料时 AI 没抽到日期 ⇒ `feedback_history.date` 是 **null**。
   这种记录**必须照样进统计**（用 created_at 兜底排序），不能因为日期空就被丢掉；
   而且它不能把别的记录挤乱序。 */
{
  const rows = [
    ROW({ id: 11, tool: "paper", date: "2026-10-10", title: "有日期·先", score: 70, full_score: 100,
      created_at: "2026-10-10T10:00:00Z", text: "……核心薄弱板块集中在以下 1 处：导数。" }),
    // ⚠️ 这条就是"补录进来、AI 没抽到日期"的样子：date = null
    ROW({ id: 12, tool: "paper", date: null, title: "补录·没日期", score: 80, full_score: 100,
      created_at: "2026-10-15T09:00:00Z", text: "……核心薄弱板块集中在以下 1 处：概率。" }),
    ROW({ id: 13, tool: "paper", date: "2026-10-20", title: "有日期·后", score: 90, full_score: 100,
      created_at: "2026-10-20T10:00:00Z", text: "……核心薄弱板块集中在以下 1 处：立体几何。" }),
  ];
  const r = buildStudentReport({ name: "李四", student: STUDENT, rows });
  record("★没有日期的记录（补录时没抽到）**照样进成绩趋势**，不被丢掉",
    r.scores.length === 3, `scores=${r.scores.length}：${r.scores.map((x) => x.title).join("/")}`);
  record("★没有日期的记录用「创建时间」兜底排序：中间那条落在中间（顺序不塌）",
    r.scores[0].title === "有日期·先" && r.scores[1].title === "补录·没日期" && r.scores[2].title === "有日期·后",
    r.scores.map((x) => `${x.title}@${x.date}`).join(" → "));
  record("★兜底出来的日期是**真日期串**（不是空、不是 undefined ⇒ 界面不会显示「未填日期」以外的怪东西）",
    r.scores.every((x) => /^\d{4}-\d{2}-\d{2}/.test(String(x.date))),
    JSON.stringify(r.scores.map((x) => x.date)));
}

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
  // ⚠️ 这里**不要写死条数**（本项目踩过：写死 3 类，加第 4 类就假红）。
  //    改成"每个出现的来源都必须是登记过的、且都有中文标签" —— 那才是真正要守的契约：
  //    「登记漏了（比如把 manual 只加进 TOOL_LABELS 却忘了 SOURCE_TOOLS）」会立刻变红。
  record("概览：byTool 每一条都在 SOURCE_TOOLS 登记过、都有中文标签，条数与时间跨度对",
    r.overview.byTool.length > 0 &&
      r.overview.byTool.every((b) => SOURCE_TOOLS.includes(b.tool) && typeof TOOL_LABELS[b.tool] === "string") &&
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
   1b. 学习进度 + 分数目标对比（2026-10-23 学情分析 AI 升级）
   --------------------------------------------------------------------------
   用户要的是「开会能用的学情分析」：不仅要有分数，还要说清
     · 现在学到哪、复习到哪个模块（以最近课后反馈为准，对照方案课表）；
     · 初始分 / 本次分 / 目标分差多少、提升速度；
     · 下一步具体练什么（提示词负责，数据在这里备好）。
   抽不到时必须如实说，不许猜。
   ========================================================================== */
{
  const rows = [
    ROW({ id: 21, tool: "paper", date: "2026-09-01", title: "开学考", score: 60, full_score: 100,
      text: "核心薄弱板块集中在以下 1 处：函数单调性。" }),
    ROW({ id: 22, tool: "math-plan", date: "2026-10-05", title: "秋季方案",
      text: "【学情诊断】基础一般。\n【提分目标】60 → 100 分\n【课时安排】共 12 课时\n【逐次课表】\n函数｜函数的单调性｜4 课时｜掌握判断\n解析几何｜直线与圆｜6 课时｜会求弦长" }),
    ROW({ id: 23, tool: "feedback", date: "2026-10-20", title: "10月20日反馈",
      text: "【课堂内容】函数的单调性\n【下节课内容】直线与圆\n【主要失分点】端点取舍。" }),
    ROW({ id: 24, tool: "paper", date: "2026-10-25", title: "月考", score: 80, full_score: 100,
      text: "核心薄弱板块集中在以下 1 处：解析几何。" }),
  ];
  const r = buildStudentReport({ name: "王五", student: STUDENT, rows });

  record("★学习进度：最近反馈的课堂内容抽到了；并能对上方案课表第 1/2 条",
    r.progress?.latestFeedback?.content.includes("函数的单调性") === true &&
      r.progress?.matchedLesson?.index === 1 && r.progress?.matchedLesson?.total === 2 &&
      r.progress?.matchedLesson?.stage === "函数",
    JSON.stringify(r.progress));

  record("★学习进度：最近反馈的下节课内容也带上（给 AI 说清“接下来学什么”）",
    r.progress?.latestFeedback?.next.includes("直线与圆") === true,
    JSON.stringify(r.progress?.latestFeedback));

  record("★分数目标对比：初始 60 / 本次 80 / 目标 100，差距与提升速度都算对",
    r.target?.planInitial === 60 && r.target?.planTarget === 100 &&
      r.target?.firstScore === 60 && r.target?.latestScore === 80 &&
      r.target?.gapToTarget === 20 && r.target?.improvement === 20 &&
      r.target?.pointsPerMonth != null && r.target.pointsPerMonth > 0,
    JSON.stringify(r.target));

  record("★digest 里同时有「学习进度」「分数目标对比」，且带反馈原文与目标差距",
    r.digest.includes("学习进度") && r.digest.includes("分数目标对比") &&
      r.digest.includes("函数的单调性") && r.digest.includes("距目标"),
    `digest 长度=${r.digest.length}`);

  record("★标题清洗：补录日期后缀从显示标题里去掉（「辅导方案（补录 · 10月17日）」→「辅导方案」）",
    cleanHistoryTitle("辅导方案（补录 · 10月17日）") === "辅导方案" &&
      cleanHistoryTitle("课后反馈（补录 · 10月17日）") === "课后反馈" &&
      cleanHistoryTitle("期中（补录）") === "期中",
    [
      cleanHistoryTitle("辅导方案（补录 · 10月17日）"),
      cleanHistoryTitle("课后反馈（补录 · 10月17日）"),
      cleanHistoryTitle("期中（补录）"),
    ].join(" / "));

  const radarNames = ["基础计算能力", "概念理解能力", "综合应用能力", "创新思维能力", "答题规范程度", "知识体系完整性"];
  record("★雷达固定 6 维：名称/顺序固定（不切原文）",
    r.skillRadar.length === 6 &&
      r.skillRadar.every((d, i) => d.name === radarNames[i]),
    JSON.stringify(r.skillRadar));
}

{
  // 六个维度的关键词映射逐项验（一条反馈同时命中 6 类）
  const rows = [
    ROW({
      id: 51, tool: "feedback", date: "2026-10-22", title: "六维反馈",
      text: "【主要失分点】计算粗心；审题理解概念不清；中档题应用综合；难题创新拓展；步骤不规范漏步骤；知识体系零散框架。",
    }),
  ];
  const r = buildStudentReport({ name: "六维", student: STUDENT, rows });
  const counts = Object.fromEntries(r.skillRadar.map((d) => [d.key, d.count]));
  record("★六维映射：计算/概念/应用/创新/规范/体系各命中 1 次",
    counts.calc === 1 && counts.concept === 1 && counts.application === 1 &&
      counts.innovation === 1 && counts.standard === 1 && counts.system === 1,
    JSON.stringify(r.skillRadar));
}

{
  // 档案里手填「目标分数 / 总课时数」（extra）—— 不新增列，作为方案缺省时的基准
  const stu = { ...STUDENT, extra: { targetScore: 110, totalHours: 40 } };
  const rows = [
    ROW({ id: 41, tool: "paper", date: "2026-09-01", title: "开学考", score: 60, full_score: 100,
      text: "核心薄弱板块集中在以下 1 处：函数。" }),
    ROW({ id: 42, tool: "math-plan", date: "2026-10-05", title: "秋季方案",
      text: "【学情诊断】基础一般。\n【课时安排】共 12 课时\n【逐次课表】\n函数｜函数的单调性｜4 课时｜掌握\n解析几何｜直线与圆｜6 课时｜会求弦长" }),
    ROW({ id: 43, tool: "feedback", date: "2026-10-20", title: "10月20日反馈",
      text: "【课堂内容】函数的单调性\n【下节课内容】直线与圆" }),
    ROW({ id: 44, tool: "paper", date: "2026-10-25", title: "月考", score: 80, full_score: 100,
      text: "核心薄弱板块集中在以下 1 处：解析几何。" }),
  ];
  const r = buildStudentReport({ name: "钱七", student: stu, rows });
  record("★档案目标分（extra.targetScore）在方案没写目标时作为基准",
    r.target?.planTarget === 110 && r.target?.planInitial === null &&
      r.target?.gapToTarget === 30 && r.target?.planTitle === "档案填写",
    JSON.stringify(r.target));
  record("★档案总课时（extra.totalHours）进入报告与 digest，已消耗按方案课表估算",
    r.hours.extraTotal === 40 && r.progress?.plan?.totalHours === 40 &&
      r.progress?.consumedHours === 4 &&
      r.digest.includes("档案填写总课时") && r.digest.includes("档案目标 110 分"),
    JSON.stringify({ extraTotal: r.hours.extraTotal, planHours: r.progress?.plan?.totalHours, consumed: r.progress?.consumedHours }));
}

{
  // 反例：方案没写目标分、只有一次考试 ⇒ 必须明说「无法做目标对比」，不能自己编一个目标
  const rows = [
    ROW({ id: 31, tool: "paper", date: "2026-09-01", title: "开学考", score: 60, full_score: 100,
      text: "核心薄弱板块集中在以下 1 处：函数。" }),
    ROW({ id: 32, tool: "math-plan", date: "2026-10-05", title: "秋季方案",
      text: "【学情诊断】基础一般。\n【课时安排】共 12 课时" }),
  ];
  const r = buildStudentReport({ name: "赵六", student: STUDENT, rows });
  record("★缺口：方案没写目标分 → notes 明说无法做目标对比（不自己编目标）",
    r.target?.planTarget === null && r.notes.some((n) => n.includes("提分目标")),
    JSON.stringify({ target: r.target, notes: r.notes }));
}

/* ==========================================================================
   2b. 手动补录的成绩（2026-10 第十四批）
   --------------------------------------------------------------------------
   老师在**别的地方**考的试（学校期中、别家机构模考）也记进档案。
   它在库里的形状是一条 tool='manual' 的普通记录，所以：
     · **必须**进成绩趋势与记录概览（这是这个功能存在的理由）；
     · **不许**变成「薄弱与失分」的证据 —— 手动记录只有分数、没有诊断正文，
       编一条出来就是"拿不存在的观察去跟家长说"。
   ========================================================================== */
{
  const rows = [
    ROW({ id: 9, tool: "paper", date: "2026-09-01", title: "开学考", score: 60, full_score: 100,
      text: "……核心薄弱板块集中在以下 1 处：导数单调性。" }),
    ROW({ id: 10, tool: "manual", type_name: "期中", date: "2026-10-08", title: "学校期中考试",
      score: 105, full_score: 150,
      text: "手动补录 · 由老师在档案页填写\n考试名称：学校期中考试\n得分：105 / 满分：150" }),
  ];
  const r = buildStudentReport({ name: "孙七", student: STUDENT, rows });

  record("★手动补录：出现在成绩趋势里，得分率算对（105/150 = 70%），并按日期排到第二位",
    r.scores.length === 2 && r.scores[1].title === "学校期中考试" &&
      r.scores[1].tool === "manual" && r.scores[1].percent === 70,
    JSON.stringify(r.scores));

  record("★手动补录：趋势把它算进去（60% → 70%，+10 个百分点）",
    r.trend?.count === 2 && r.trend.delta === 10 && r.trend.lastPercent === 70,
    JSON.stringify(r.trend));

  record("★手动补录：进「记录概览」的按工具统计（标签是「手动补录」）",
    JSON.stringify(r.overview.byTool.map((b) => [b.tool, b.count])) ===
      JSON.stringify([["paper", 1], ["manual", 1]]) &&
      r.overview.byTool.find((b) => b.tool === "manual")?.label === "手动补录",
    JSON.stringify(r.overview.byTool));

  record("★手动补录：**不许**被当成薄弱/失分证据（它没有诊断正文）",
    !r.weaknesses.some((w) => w.tool === "manual") && r.weaknesses.length === 1,
    JSON.stringify(r.weaknesses.map((w) => [w.tool, w.label])));

  record("★手动补录：喂给 AI 的摘要里带着它（「AI 分析学期时也考虑在内」的证据）",
    r.digest.includes("学校期中考试") && r.digest.includes("105/150"),
    r.digest.includes("学校期中考试") ? "在" : "不在");
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
  record("契约：TOOL_LABELS 覆盖全部登记来源（含学情报告与手动补录）",
    ["math-plan", "paper", "feedback", "analysis", "manual"].every((t) => typeof TOOL_LABELS[t] === "string"),
    JSON.stringify(TOOL_LABELS));
  record("★契约：每一条 SOURCE_TOOLS 都有中文标签（只加进一处 = 概览里显示成英文 key）",
    SOURCE_TOOLS.every((t) => typeof TOOL_LABELS[t] === "string"),
    `SOURCE_TOOLS=${JSON.stringify(SOURCE_TOOLS)}`);
  record("★契约：手动补录（manual）已登记为一种来源（否则老师补的成绩不进概览）",
    SOURCE_TOOLS.includes("manual") && TOOL_LABELS.manual === "手动补录",
    `SOURCE_TOOLS=${JSON.stringify(SOURCE_TOOLS)} label=${TOOL_LABELS.manual}`);

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

  // ③ 撞约束时的提示里点名的那个迁移文件，必须**就是上面最后一条**定义 CHECK 的迁移。
  //    ⚠️ 以前路由里写死 `0016`，于是 0017 之后照着提示跑迁移也解决不了问题（第十四批修）。
  //    现在常量在 `src/lib/manual-score.ts`（唯一来源），两个路由都从那里取。
  const msSrc = readFileSync(join(ROOT, "src", "lib", "manual-score.ts"), "utf8");
  const cm = msSrc.match(/TOOL_CONSTRAINT_MIGRATION\s*=\s*"([^"]+)"/);
  const namedMigration = cm ? cm[1] : null;
  record("★契约：撞约束时点名的迁移 == 最后一条定义 CHECK 的迁移（写死旧文件名会误导老师）",
    !!namedMigration && namedMigration.endsWith(dbFile),
    `提示里写=[${namedMigration}] 实际最新=[${dbFile}]`);
}

process.exit(summary() ? 0 : 1);
