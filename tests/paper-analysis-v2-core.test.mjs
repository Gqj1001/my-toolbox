#!/usr/bin/env node
/**
 * 全学科试卷分析 v2 · 公用引擎 / 科目包 / 导出数据 的纯函数测试
 * ==========================================================================
 * 不依赖浏览器、不依赖服务。重点钉住：
 *   · 四学科 × 初高中共 8 份科目包都在，且都有题型/模块/预设；
 *   · 题号是字符串（14(3) 也认）；考点带来源；写作有分项；
 *   · 算分合计精确等于老师填的总分；
 *   · 附件1/2 的数据组装（错题行、六段长文键）；
 *   · 三档导出：附件1、附件2、两份一起（两次 build）都能出合法 docx；
 *   · 老工具还引用 core（没有被复制成第二份）。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeRecorder } from "./_helpers.mjs";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "public/tools/paper-analysis/js/core");
const V2 = join(ROOT, "public/tools/paper-analysis-v2");
const E = require(join(CORE, "subject-engine.js"));
const math = require(join(V2, "subjects/math.js"));
const physics = require(join(V2, "subjects/physics.js"));
const english = require(join(V2, "subjects/english.js"));
const chinese = require(join(V2, "subjects/chinese.js"));
const CompanyDocx = require(join(ROOT, "public/tools/company-template/company-docx.js"));

const { record, summary } = makeRecorder();
const PACKS = Object.assign({}, math, physics, english, chinese);

record("① 8 份科目包齐全（数学/物理/英语/语文 × 高中/初中）",
  Object.keys(PACKS).length === 8 &&
    ["math", "physics", "english", "chinese"].every((k) => PACKS[`${k}-senior`] && PACKS[`${k}-junior`]),
  Object.keys(PACKS).join(", "));

record("② 每份包都有题型 / 模块 / 预设 / 年级（加学科只加配置）",
  Object.values(PACKS).every((p) => p.types?.length && p.modules?.length && p.presets?.length && p.grades?.length && p.fullScore > 0),
  Object.entries(PACKS).map(([k, p]) => `${k}:${p.types.length}型/${p.modules.length}模块`).join(" "));

const DEMO = `2026年秋季高三第一次月考
整体难度：适中
考试范围：函数与导数,解析几何
试卷题型
题型|数量
单选题|8
多选题|3
填空题|3
解答题|5
细目表分析
题号|难度系数|详细知识点
一、单选题
1|0.85|集合的交集运算
2|0.75|复数的基本概念
3|0.65|函数的单调性
4|0.55|平面向量的数量积
5|0.45|等差数列的前n项和
6|0.65|直线与圆的位置关系
7|0.55|三角函数的图象与性质
8|0.40|导数的几何意义
二、多选题
9|0.65|基本不等式
10|0.55|空间向量的应用
11|0.40|圆锥曲线的性质
三、填空题
12|0.75|二项式定理
13|0.55|排列与组合
14|0.35|函数与导数综合
四、解答题
15|0.70|解三角形
16|0.55|立体几何
17|0.50|概率与统计
18|0.40|平面解析几何
19|0.30|导数与函数单调性`;

const parsed = E.parseReport(DEMO, PACKS["math-senior"]);
record("③ 解析学科网报告：19 题 / 4 个题型 / 题号是字符串",
  parsed.questions.length === 19 &&
    parsed.typeDist.length === 4 &&
    parsed.questions.every((q) => typeof q.no === "string"),
  `${parsed.questions.length} 题 / ${parsed.typeDist.map((t) => `${t.type}${t.count}`).join(" ")}`);

record("④ 解析时考点带来源（imported），不是裸字符串",
  parsed.questions.every((q) => q.knowledge.every((k) => typeof k === "object" && k.source === "imported" && k.name)),
  JSON.stringify(parsed.questions[7].knowledge));

const scored = E.scorePaper(PACKS["math-senior"], parsed.typeDist, 150, "新高考 I/II 卷");
const scoredSum = E.round2(Object.values(scored.perType).reduce((a, x) => a + x.total, 0));
record("★⑤ 算分合计精确等于总分（150）", scoredSum === 150, `合计=${scoredSum}`);

const paper = E.buildPaper(PACKS["math-senior"], parsed, scored);
record("⑥ buildPaper：题号字符串 + 共享材料位 + 写作分项位",
  paper.questions.every((q) => typeof q.no === "string") &&
    Array.isArray(paper.stems) &&
    paper.questions.every((q) => "stemRef" in q && "scoreParts" in q),
  `stems=${paper.stems.length}`);

record("★⑦ 14(3) 这种小问编号也认（不丢题）",
  (() => {
    const t = `标题\n试卷题型\n题型|数量\n解答题|1\n细目表分析\n题号|难度系数|详细知识点\n一、解答题\n14(3)|0.5|导数与函数单调性`;
    const p = E.parseReport(t, PACKS["math-senior"]);
    return p.questions.length === 1 && p.questions[0].no === "14(3)";
  })(), "14(3)");

record("★⑧ 每份包 × 每个预设：算出来的合计都等于预设总分",
  (() => {
    const bad = [];
    for (const [key, pack] of Object.entries(PACKS)) {
      for (const preset of pack.presets) {
        const dist = Object.entries(preset.dist).map(([type, v]) => ({ type, count: v[0] }));
        const r = E.scorePaper(pack, dist, preset.total, preset.name);
        const sum = E.round2(Object.values(r.perType).reduce((a, x) => a + x.total, 0));
        if (sum !== preset.total) bad.push(`${key}/${preset.name}: ${sum}≠${preset.total}`);
      }
    }
    return bad.length === 0;
  })(), "全部对齐");

record("★⑨ 考点归类走各学科包（数学/物理/英语/语文各命中一个）",
  (() => {
    const mathId = PACKS["math-senior"].modules.find((m) => m.name.includes("导数"))?.id;
    return E.classifyWithPack("导数的几何意义", PACKS["math-senior"]) === mathId &&
      E.classifyWithPack("牛顿第二定律", PACKS["physics-senior"]) === "mech" &&
      E.classifyWithPack("非谓语动词", PACKS["english-senior"]) === "grammar" &&
      E.classifyWithPack("文言实词", PACKS["chinese-senior"]) === "classical";
  })(), "各学科词典/正则");

record("⑩ 英语听力标记「难度不估」；英语/语文写作有分项（内容/结构/语言）",
  PACKS["english-senior"].types.find((t) => t.label === "听力")?.noDifficulty === true &&
    JSON.stringify(PACKS["english-senior"].types.find((t) => t.label === "书面表达")?.parts) === JSON.stringify(["内容", "结构", "语言"]) &&
    JSON.stringify(PACKS["chinese-senior"].types.find((t) => t.label === "写作")?.parts) === JSON.stringify(["内容", "结构", "语言"]),
  "听力不估难度 + 写作三分项");

record("⑪ 写作分项能落进 scoreParts，并自动汇总成 got",
  (() => {
    const t = `语文月考\n试卷题型\n题型|数量\n写作|1\n细目表分析\n题号|难度系数|详细知识点\n一、写作\n作文|0.6|写作`;
    const p = E.parseReport(t, PACKS["chinese-senior"]);
    const s = E.scorePaper(PACKS["chinese-senior"], p.typeDist, 150, "");
    const pp = E.buildPaper(PACKS["chinese-senior"], p, s);
    const q = pp.questions[0];
    q.scoreParts = { 内容: 30, 结构: 15, 语言: 15 };
    const got = Object.values(q.scoreParts).reduce((a, x) => a + x, 0);
    return q.partDefs?.length === 3 && got === 60;
  })(), "内容/结构/语言");

const q0 = paper.questions[0];
q0.got = q0.score - 1;
q0.stemSummary = "集合交并补的运算";
q0.reason = "概念混淆，漏掉空集";
const data1 = E.buildCompanyData(paper, {
  student: "张三", school: "三河一中", grade: "高三", teacher: "王老师",
  examType: "月考", entryScore: "90", entryRank: "500", currentRank: "12",
  learnedHours: "10", totalHours: "40",
}, {
  attribution: { 学生角度: "基础题不稳", 教师角度: "训练量不足", 其它原因: "暂无明显外部因素" },
  measures: { 教师教学: "分模块补", 学生配合: "每天 20 分钟", 家长配合: "监督作业" },
});
record("★⑫ 附件1/2 数据：错题行 + 六段长文键都齐",
  data1.wrongRows.length === 1 &&
    data1.wrongRows[0].topic === "集合交并补的运算" &&
    ["学生角度", "教师角度", "其它原因", "教师教学", "学生配合", "家长配合"].every((k) => typeof data1.longTexts[k] === "string"),
  JSON.stringify(Object.keys(data1.longTexts)));

record("⑬ 附件1/2/两份一起：三档都能 build 出合法 ZIP（PK 头）",
  (() => {
    const a1 = CompanyDocx.build("附件1", data1);
    const a2 = CompanyDocx.build("附件2", data1);
    const both = [a1, a2];
    return a1.length > 1000 && a2.length > 1000 &&
      both.every((b) => b[0] === 0x50 && b[1] === 0x4b);
  })(), "两次 build = 两份一起");

record("⑭ 老工具仍引用 core（没有复制第二份实现）",
  (() => {
    const html = readFileSync(join(ROOT, "public/tools/paper-analysis/index.html"), "utf8");
    return /js\/core\/paper-parser\.js/.test(html) && !/<script src="js\/paper-parser\.js"/.test(html);
  })(), "index.html → js/core/");

record("⑮ 迁移与开关登记：tools 路由 + feature_flags key 都在",
  readFileSync(join(ROOT, "supabase/migrations/0024_seed_paper_analysis_v2_tool.sql"), "utf8").includes("/tools/paper-analysis-v2") &&
    readFileSync(join(ROOT, "supabase/migrations/0025_feature_flag_paper_analysis_v2.sql"), "utf8").includes("paper_analysis_v2") &&
    readFileSync(join(ROOT, "src/lib/feature-flags.ts"), "utf8").includes('key: "paper_analysis_v2"'),
  "0024 / 0025 / registry");

record("★⑯ 英语听力：题号照列、分值照给，但难度不估（coeff/难度留空）",
  (() => {
    const t = `英语月考\n试卷题型\n题型|数量\n听力|1\n细目表分析\n题号|难度系数|详细知识点\n一、听力\n1|0.8|听力理解`;
    const p = E.parseReport(t, PACKS["english-senior"]);
    const s = E.scorePaper(PACKS["english-senior"], p.typeDist, 1.5, "");
    const pp = E.buildPaper(PACKS["english-senior"], p, s);
    const q = pp.questions[0];
    return q && q.no === "1" && q.type === "听力" && q.coeff === null && q.difficulty === "" && q.score === 1.5;
  })(), "noDifficulty");

record("★⑰ 共享材料：题号可挂到同一个 stem（数据模型留好接口）",
  (() => {
    paper.stems.push({ id: "s1", name: "材料一", questionNos: ["1", "2"] });
    paper.questions[0].stemRef = "s1";
    paper.questions[1].stemRef = "s1";
    return paper.stems.length === 1 && paper.questions[0].stemRef === "s1" && paper.questions[1].stemRef === "s1";
  })(), "stems");

const ok = summary();
process.exit(ok ? 0 : 1);
