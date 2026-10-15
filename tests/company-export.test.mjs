#!/usr/bin/env node
/**
 * 公司模板导出（新增模块）测试
 * ==========================================================================
 * 测什么：
 *  ① 引擎能按**公司模板**产出合法 docx（三个附件各一个）
 *  ② **逐格核对**：固定文字一个字没改、该填的格填对了
 *  ③ **样例不泄漏**：模板里的语文样例（语病/文言文/红楼梦…）一个都不许出现在导出件里
 *  ④ **格式不走形**：表格样式、单元格边框数、合并格数、页面/页边距与模板一致
 *  ⑤ 浏览器里接好了：面板/按钮/下拉在，点导出能拿到字节，页面无异常
 *
 * 验证方式（关键）：导出件**不**用自己的 XML 解析器自证 —— 交给 **python-docx**
 * （另一个独立实现）解析成 JSON，再在 Node 里断言。这样"自己骗自己"的空间就没了。
 *
 * ⚠️ 浏览器那段会自己起 `next start`（会杀 3000 端口），别和其它真服务套件并行跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder, startBrowser, makePageApi } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const require = createRequire(import.meta.url);
const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const PY = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
const CDP_PORT = 9495;
const OUT_DIR = "D:\\my-website\\.tmp-planning-samples\\company-template\\out";

const { record, summary } = makeRecorder();
const CompanyDocx = require(`${PROJECT}\\public\\tools\\company-template\\company-docx.js`);
const CompanyTemplateData = require(`${PROJECT}\\public\\tools\\company-template\\template-data.js`);

/* ==========================================================================
   独立验证器：python-docx 把 docx 解析成 JSON
   ========================================================================== */
const PY_DUMP = `
import json, sys, zipfile, re
from docx import Document
p = sys.argv[1]
d = Document(p)
tables = []
for t in d.tables:
    rows = []
    for row in t.rows:
        seen, cells = set(), []
        for c in row.cells:
            if id(c._tc) in seen: continue
            seen.add(id(c._tc))
            cells.append(c.text)
        rows.append(cells)
    tables.append({"rows": len(t.rows), "cols": len(t.columns),
                   "style": t.style.name if t.style else None, "cells": rows})
s = d.sections[0]
xml = zipfile.ZipFile(p).read("word/document.xml").decode("utf-8")
out = {
  "tables": tables,
  "paras": [x.text for x in d.paragraphs if x.text.strip()],
  "page": [round(s.page_width.cm,2), round(s.page_height.cm,2)],
  "margins": [round(s.top_margin.cm,2), round(s.left_margin.cm,2)],
  "tcBorders": len(re.findall(r"<w:tcBorders>", xml)),
  "tblBorders": len(re.findall(r"<w:tblBorders>", xml)),
  "tblPrEx": len(re.findall(r"<w:tblPrEx>", xml)),
  "gridSpan": len(re.findall(r"<w:gridSpan ", xml)),
  "vMerge": len(re.findall(r"<w:vMerge", xml)),
  "allText": "\\u0001".join(c for t in tables for r in t["cells"] for c in r),
}
print(json.dumps(out, ensure_ascii=False))
`;

function dumpDocx(file) {
  const r = spawnSync(PY, ["-c", PY_DUMP, file], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    // ⚠️ 必须强制 python 用 UTF-8 输出：Windows 下它默认按控制台代码页（GBK）写 stdout，
    //    Node 按 UTF-8 解就会变成乱码，所有中文断言都会假红（本轮踩过）。
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  if (r.status !== 0) throw new Error("python 解析失败: " + (r.stderr || "").slice(0, 400));
  return JSON.parse(r.stdout);
}

/** 模板自身的"格式指纹"（用来对比导出件有没有走形） */
function templateFingerprint(att) {
  const xml = CompanyTemplateData.getText(att, "word/document.xml");
  return {
    tblPrEx: (xml.match(/<w:tblPrEx>/g) || []).length,
    tblBorders: (xml.match(/<w:tblBorders>/g) || []).length,
    tcBorders: (xml.match(/<w:tcBorders>/g) || []).length,
    gridSpan: (xml.match(/<w:gridSpan /g) || []).length,
    vMerge: (xml.match(/<w:vMerge/g) || []).length,
    rows: (xml.match(/<w:tr>/g) || []).length + (xml.match(/<w:tr /g) || []).length,
  };
}

/* ==========================================================================
   1. 生成三个附件（Node 侧，纯函数）
   ========================================================================== */
const DATA = {
  student: "探针同学", school: "天津一中", grade: "高三", teacher: "郭庆杰", subject: "数学",
  learnedHours: "10小时", totalHours: "40小时", examType: "月考",
  entryScore: "90分", entryRank: "500名", currentScore: "85分", currentRank: "12名",
  wrongRows: [
    { no: 12, topic: "导数与单调性", point: "导数与单调性", reason: "含参分类讨论不完整" },
    { no: 17, topic: "椭圆的方程", point: "椭圆的方程", reason: "联立与韦达定理运算" },
    { no: 21, topic: "数列求和", point: "数列求和", reason: "错位相减未掌握" },
  ],
  longTexts: {},
  // ★ 2026-10 第十八批：附件3 的逐次课表（**按模块合并**后填进度表）。
  //   刻意用**同名相邻**两行来验"合并"：`导数…` 两条 + `解析几何` 两条 ⇒ 进度表应只有 2 个模块行。
  rows: [
    { module: "导数与函数单调性极值（概念与公式梳理）", content: "单调区间求解", goal: "会求单调区间", hours: 2 },
    { module: "导数与函数单调性极值（真题精讲）", content: "含参分类讨论", goal: "不重不漏", hours: 2 },
    { module: "解析几何（联立与韦达定理）", content: "联立求交点", goal: "步骤规范", hours: 4 },
    { module: "解析几何（真题精讲）", content: "定点定值", goal: "拿步骤分", hours: 2 },
  ],
  durationText: "2026年10月--2027年1月",
  hoursPerWeekText: "2",
  lessonEval: {},
};

mkdirSync(OUT_DIR, { recursive: true });
const FILES = {};
for (const att of ["附件1", "附件2", "附件3"]) {
  let bytes;
  try { bytes = CompanyDocx.build(att, DATA); }
  catch (e) { record(`${att} 能生成`, false, String(e.message)); continue; }
  const f = `${OUT_DIR}\\单位测试-${att}.docx`;
  writeFileSync(f, Buffer.from(bytes));
  FILES[att] = f;
  record(`${att} 生成成功且是合法 ZIP（PK 头）`,
    bytes.length > 5000 && bytes[0] === 0x50 && bytes[1] === 0x4b, `${bytes.length} 字节`);
}

/* ==========================================================================
   2. 逐格核对（python-docx 独立解析）
   ========================================================================== */
const D = {};
for (const att of Object.keys(FILES)) {
  try { D[att] = dumpDocx(FILES[att]); }
  catch (e) { record(`${att} 能被 python-docx 打开`, false, String(e.message)); }
}

/* ---- ★ 附件3 的"按模块合并"在测试侧**独立复算**一遍（不是自证） ----
   引擎的口径：**同名相邻**的模块合并成一行；`stage` 里的「（概念与公式梳理）」这类后缀要去掉。
   放这一层（而不是 2.1 块里）是因为后面 2.2b 也要用它。 */
const MERGED_MODULES = [];
for (const r of DATA.rows) {
  const mod = String(r.module || "").replace(/[（(][^（()）]*[)）]\s*$/, "").trim();
  if (MERGED_MODULES.length && mod && MERGED_MODULES[MERGED_MODULES.length - 1] === mod) continue;
  MERGED_MODULES.push(mod);
}
const N3 = MERGED_MODULES.length;

/* ---- 2.1 尺寸与格式不走形 ---- */
{
  // ⚠️ 顺序：**先算好各类"动态行数"与模板基线**，再拿它们去折算预期值
  //    （第一版把这些放在下面，`dims` 用到了还没声明的变量 ⇒ TDZ 直接崩）。
  const fp = Object.fromEntries(["附件1", "附件2", "附件3"].map(a => [a, templateFingerprint(a)]));
  // 附件2 的错题行是**动态**的：样例 8 行 → 实际 N 行
  const N = DATA.wrongRows.length, SAMPLE_ROWS = 8;
  record(`（准备）附件3 的课表 ${DATA.rows.length} 条 → 按模块合并成 ${N3} 行（测试侧独立复算）`,
    N3 === 2 && MERGED_MODULES[0] === "导数与函数单调性极值" && MERGED_MODULES[1] === "解析几何",
    JSON.stringify(MERGED_MODULES));

  // ⚠️ 预期值不再写死"39 行"这种数字，而是**从模板基线折算**：
  //    · 附件1：13 行（不变）
  //    · 附件2：11 固定 + N 错题行
  //    · 附件3：**24 = 39 − 17 样例行 + 2 实际模块行**（2026-10 第十八批接了进度表之后）
  //  ⚠️ 格式计数的**折算口径**（用 python 直接数模板反推出来的，别凭感觉改）：
  //    模板里每个"进度/错题样例行"各带 1 个 tblBorders + 1 个 tblPrEx；
  //    合并格：附件2 每样例行带 1 个 gridSpan + 2 个 vMerge，附件3 每样例行带 1 个 gridSpan + **2** 个 vMerge
  //    （实测 34 → 14：少 20 = 10 行 × 2 —— 纵向合并"首格"与其延续格各算一次）。
  const dims = { "附件1": [13, 5], "附件2": [11 + N, 7], "附件3": [39 - 17 + N3, 6] };
  for (const [att, [rows, cols]] of Object.entries(dims)) {
    const t = D[att]?.tables?.[0];
    record(`${att}：表格 ${rows} 行 × ${cols} 列（附件2 = 11 固定行 + 3 错题行）`,
      t?.rows === rows && t?.cols === cols && t?.style === "Table Grid",
      `实际 ${t?.rows}×${t?.cols} style=${t?.style}`);
  }
  record("三个附件都只有 1 张表、0 个正文段落（切分干净，没有把别的附件带进来）",
    Object.values(D).every(d => d.tables.length === 1 && d.paras.length === 0),
    Object.entries(D).map(([k, d]) => `${k}:${d.tables.length}表/${d.paras.length}段`).join(" "));
  record("页面与页边距与公司模板一致（A4 纵向 21×29.7cm、上 2.54/左 1.91）",
    Object.values(D).every(d => JSON.stringify(d.page) === "[21,29.7]" &&
      JSON.stringify(d.margins) === "[2.54,1.91]"),
    JSON.stringify(D["附件2"]?.page) + " " + JSON.stringify(D["附件2"]?.margins));
  // （模板基线 fp 与各类动态行数 N / N3 已在本段开头算好，见上面的说明）
  record("格式不走形①：表格边框（tblBorders）与**行级表格属性**（tblPrEx）都没丢",
    ["附件1", "附件2", "附件3"].every(a => {
      // 每个"被替换掉的样例行"少了 1 个 tblBorders + 1 个 tblPrEx（口径见上面的说明）
      const cut = a === "附件2" ? SAMPLE_ROWS - N : a === "附件3" ? 17 - N3 : 0;
      return D[a].tblBorders === fp[a].tblBorders - cut &&
             D[a].tblPrEx === fp[a].tblPrEx - cut;
    }),
    ["附件1", "附件2", "附件3"].map(a =>
      `${a}: tblBorders ${D[a]?.tblBorders}/${fp[a].tblBorders} tblPrEx ${D[a]?.tblPrEx}/${fp[a].tblPrEx}`).join(" | "));
  record("格式不走形②：合并格数对得上（附件1 不变；附件2/3 按被替换掉的样例行折算）",
    ["附件1", "附件2", "附件3"].every(a => {
      // ⚠️ 口径（用 python 逐格数模板反推出来的，**别凭感觉"找规律"**）：
      //    · 附件2 每个错题样例行 = **2 个 gridSpan + 1 个 vMerge**（实测 43→33 / 12→7，正好 5 行）
      //    · 附件3 每个进度样例行 = **1 个 gridSpan**；vMerge 没有整齐规律
      //      （r32 那行是 0 个、其余多为 2 个：15 行共 26 个 vMerge，但只能减掉 20 →
      //       另有 6 个 vMerge 在"未被替换"的行上）。**第一版按"每行 2 个"算 ⇒ 假红**，
      //       所以附件3 的 vMerge 直接钉实测值（种子固定，值是确定的）。
      const cutRows = a === "附件2" ? SAMPLE_ROWS - N : a === "附件3" ? 17 - N3 : 0;
      const gsPer = a === "附件2" ? 2 : 1;
      const vmPer = a === "附件2" ? 1 : 0;
      return D[a].gridSpan === fp[a].gridSpan - cutRows * gsPer &&
             D[a].vMerge === fp[a].vMerge - cutRows * vmPer - (a === "附件3" ? 20 : 0);
    }),
    ["附件1", "附件2", "附件3"].map(a =>
      `${a}: gridSpan ${D[a]?.gridSpan}/${fp[a].gridSpan} vMerge ${D[a]?.vMerge}/${fp[a].vMerge}`).join(" | "));
  // ★ 这条才是"格式不走形"真正要防的事：**样例行没被清干净**（语文样例整块漏进导出件）。
  //   因果护栏：进度表行数 = 模块数 ⇒ 合并格数必须**明显低于**模板基线（留 17 行就必然超标）。
  record("★★格式护栏：附件3 的合并格数**明显少于**模板（证明确实把 17 行样例换掉了，而不是留着）",
    D["附件3"].gridSpan <= fp["附件3"].gridSpan - 10 &&
    D["附件3"].vMerge <= fp["附件3"].vMerge - 15,
    `gridSpan ${D["附件3"].gridSpan} vs 基线 ${fp["附件3"].gridSpan}；vMerge ${D["附件3"].vMerge} vs 基线 ${fp["附件3"].vMerge}`);
  record("格式不走形③：单元格级边框（tcBorders）也没丢",
    ["附件1", "附件2", "附件3"].every(a => D[a].tcBorders === fp[a].tcBorders),
    ["附件1", "附件2", "附件3"].map(a => `${a}: ${D[a]?.tcBorders}/${fp[a].tcBorders}`).join(" | "));
}

/* ---- 2.2 抬头逐格 ---- */
function cellOf(att, rowNeedle, colNeedle) {
  const rows = D[att].tables[0].cells;
  for (const r of rows) {
    if (r.some(c => c.indexOf(rowNeedle) >= 0)) {
      if (colNeedle == null) return r;
      const i = r.findIndex(c => c.indexOf(colNeedle) >= 0);
      if (i >= 0 && i + 1 < r.length) return r[i + 1];
    }
  }
  return null;
}
function rowOf(att, needle) {
  return D[att].tables[0].cells.find(r => r.some(c => c.indexOf(needle) >= 0)) || null;
}

record("附件1/2 抬头：学生姓名、学校年级、教师姓名、任教学科都填对了",
  cellOf("附件1", "学生姓名", "学生姓名") === "探针同学" &&
  cellOf("附件1", "学生姓名", "学校年级") === "天津一中高三" &&
  cellOf("附件1", "教师姓名", "教师姓名") === "郭庆杰" &&
  cellOf("附件1", "教师姓名", "任教学科") === "数学" &&
  cellOf("附件2", "学生姓名", "学校年级") === "天津一中高三",
  JSON.stringify([cellOf("附件1", "学生姓名", "学生姓名"), cellOf("附件1", "学生姓名", "学校年级")]));
record("附件1/2 抬头：已学课时/单科总课时（手填）、考试类型（下拉）都对",
  cellOf("附件1", "已学课时", "已学课时") === "10小时/40小时" &&
  cellOf("附件1", "考试类型", "考试类型") === "月考" &&
  cellOf("附件2", "考试类型", "考试类型") === "月考",
  JSON.stringify([cellOf("附件1", "已学课时", "已学课时"), cellOf("附件1", "考试类型", "考试类型")]));
record("附件1/2 抬头：入学成绩/排名、本次成绩/排名都对（排名手填）",
  cellOf("附件1", "入学成绩", "入学成绩") === "90分/500名" &&
  cellOf("附件1", "本次成绩", "本次成绩") === "85分/12名",
  JSON.stringify([cellOf("附件1", "入学成绩", "入学成绩"), cellOf("附件1", "本次成绩", "本次成绩")]));
record("附件3 抬头：学生姓名 / 学校年级 / 教师姓名 / 辅导课时（只有 4 格）",
  cellOf("附件3", "学生姓名", "学生姓名") === "探针同学" &&
  cellOf("附件3", "教师姓名", "辅导课时") === "40小时",
  JSON.stringify([cellOf("附件3", "学生姓名", "学生姓名"), cellOf("附件3", "教师姓名", "辅导课时")]));

/* ---- 2.2b ★ 附件3 进度表（2026-10 第十八批接线；逐格核对） ---- */
{
  const rows = D["附件3"].tables[0].cells;
  const head = rowOf("附件3", "知识模块");
  record("★附件3 进度表表头**原样保留**（知识模块 | 具体知识点（含检测）及预期目标 | 课时数 | 效果评估（比对目标）及方案调整）",
    head && head.join("|") === "知识模块|具体知识点（含检测）及预期目标|课时数|效果评估（比对目标）及方案调整",
    JSON.stringify(head));

  const hi = rows.indexOf(head);
  const dataRows = rows.slice(hi + 1, hi + 1 + N3);
  const totalRow = rows[hi + 1 + N3];

  record(`★★附件3 进度表 = **${N3} 行**（4 条课表按模块合并成 ${N3} 行，17 行语文样例一行不留）`,
    dataRows.length === N3 && dataRows.every(r => r && r.length === 4),
    `实际 ${dataRows.length} 行：${JSON.stringify(dataRows.map(r => r?.[0]))}`);

  record("★★附件3 合并正确：模块列只在**第一行**写模块名、延续行留空（模板样例就是这个形状）",
    dataRows[0]?.[0] === "导数与函数单调性极值" && dataRows[1]?.[0] === "解析几何",
    JSON.stringify(dataRows.map(r => r?.[0])));

  record("★★附件3 合并正确：课时数 = 该模块**各次课之和**（2+2=4、4+2=6）",
    dataRows[0]?.[2] === "4小时" && dataRows[1]?.[2] === "6小时",
    JSON.stringify(dataRows.map(r => r?.[2])));

  record("★★附件3 合并正确：同一模块的多次课，知识点与目标**都保留**（用「；」连排，不是只留最后一次）",
    /单调区间求解/.test(dataRows[0]?.[1] ?? "") && /含参分类讨论/.test(dataRows[0]?.[1] ?? "") &&
    /联立求交点/.test(dataRows[1]?.[1] ?? "") && /定点定值/.test(dataRows[1]?.[1] ?? ""),
    JSON.stringify(dataRows.map(r => (r?.[1] ?? "").slice(0, 40))));

  record("★附件3 知识点的写法与模板样例同款（「知识点：…目标：…」两段连排）",
    /^知识点：.+目标：/.test(dataRows[0]?.[1] ?? ""),
    (dataRows[0]?.[1] ?? "").slice(0, 50));

  record("★★附件3 合计行 = 课时数之和（2+2+4+2 = 10小时；**不是**模板样例的 40小时）",
    totalRow?.[2] === "10小时" && !(totalRow ?? []).includes("40小时"),
    `合计格=${JSON.stringify(totalRow?.[2])}（抬头那格「辅导课时」填的是计划总课时 40 小时，两者本来就不同：一个是计划、一个是逐次课表之和）`);

  record("★附件3「效果评估」列一期留空（工具没有过程数据，不许编；也给老师手写留位置）",
    dataRows.every(r => (r?.[3] ?? "") === "") && (totalRow?.[3] ?? "") === "",
    JSON.stringify(dataRows.map(r => r?.[3])));

  const dur = rowOf("附件3", "辅导进度及结果验收");
  record("★附件3 辅导时间按输入填入固定那句话里（其余固定文字一个字没动）",
    dur && dur[0] === "辅导进度及结果验收（辅导时间： 2026年10月--2027年1月；周课时: 2 课时/周）",
    JSON.stringify(dur?.[0]));

  // ⚠️ 「补习后」是那一行的**最后一格且是合并格**（后面没有别的格），所以不能用
  //    `cellOf(...)` 那套"标签的下一格"去找它 —— 直接看整行（第一版就是这么假红的）。
  const sr = rowOf("附件3", "成绩结果统计") ?? [];
  record("★附件3 「入学成绩」填了、「补习后」留空（一期口径：只填能确定的，其余手写）",
    sr.includes("90分") && sr.some(c => c === "") && !sr.some(c => /90.*-.*85/.test(c)),
    JSON.stringify(sr));
}

/* ---- 2.3 附件2 错题表逐格 ---- */
{
  const rows = D["附件2"].tables[0].cells;
  const head = rowOf("附件2", "错因");
  record("附件2 错题表头**原样保留**（错题分析 | 题号 | 题目 | 考点 | 错因）",
    head && head.join("|") === "错题分析|题号|题目|考点|错因", JSON.stringify(head));
  const headIdx = rows.indexOf(head);
  const data = rows.slice(headIdx + 1, headIdx + 4);
  record("附件2 三行错题逐格对位（题号/题目/考点/错因）",
    data[0]?.[1] === "12" && data[0]?.[4] === "含参分类讨论不完整" &&
    data[1]?.[1] === "17" && data[2]?.[1] === "21",
    JSON.stringify(data.map(r => r.slice(1))));
  record("附件2「题目」列 = 「考点」列 = 知识点（用户 2026-10 定的口径：题目没有题干，用知识点顶替）",
    data.every(r => r[2] === r[3] && r[2].length > 0),
    JSON.stringify(data.map(r => [r[2], r[3]])));
  const none = CompanyDocx.build("附件2", Object.assign({}, DATA, { wrongRows: [] }));
  const f2 = `${OUT_DIR}\\单位测试-附件2-无错题.docx`;
  writeFileSync(f2, Buffer.from(none));
  const d2 = dumpDocx(f2);
  record("附件2：没有错题时样例行**一行都不留**（11 行），不会把语文样例带出去",
    d2.tables[0].rows === 11 && !/语病|文言文|红楼梦|虚词|实词/.test(d2.allText),
    `行数=${d2.tables[0].rows}`);
}

/* ---- 2.4 一期留空的格：必须真留空，且标签还在 ---- */
{
  // ⚠️ 模板里不少标签带硬换行（`学科知识⏎掌握情况` / `非学科⏎层面`），
  //    比对前一律去掉所有空白，否则会假红（python-docx 读出来是 "\n"）。
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, "");
  const rowWith = (att, label) =>
    D[att].tables[0].cells.find(r => r.some(c => norm(c).includes(norm(label)))) || null;
  const lastCellOf = (att, label) => { const r = rowWith(att, label); return r ? r[r.length - 1] : null; };

  const long = ["学生角度", "教师角度", "其它原因", "教师教学", "学生配合", "家长配合"]
    .map(n => lastCellOf("附件1", n));
  record("附件1 六段长文**全部留空**（值格为空字符串，不是原来那堆语文样例）",
    long.every(v => v === ""), JSON.stringify(long.map(v => String(v).slice(0, 12))));
  record("附件1 六段长文的**标签格原样保留**（学生角度/教师角度/其它原因/教师教学/学生配合/家长配合）",
    ["成绩变化原因分析", "学生角度", "教师角度", "其它原因", "方案调整及应对措施", "教师教学", "学生配合", "家长配合"]
      .every(n => !!rowWith("附件1", n)), "标签齐全");

  const sub = ["学情分析", "学科知识掌握情况", "学习方法与能力", "学习态度与习惯", "其它方面",
    "拟采取的措施", "理论学习", "方法习得", "能力提升", "习惯培养",
    "预期达成的效果", "知识层面", "能力层面", "非学科层面", "三次课后", "阶段总结"];
  const miss3 = sub.filter(n => !rowWith("附件3", n));
  record("附件3 子标签全部保留（学情分析 4 项 / 措施 5 项 / 预期效果 3 项 / 三次课后·阶段总结）",
    miss3.length === 0, miss3.join(" / ") || "齐全");
  const subLabelRow = rowWith("附件3", "学科知识掌握情况");
  record("附件3 学情分析那一行：子标签在、两侧长文（三次课后/阶段总结）都留空",
    !!subLabelRow && subLabelRow.slice(2).every(v => String(v).trim() === ""),
    JSON.stringify(subLabelRow?.map(v => String(v).slice(0, 10))));
}

/* ---- 2.5 签字栏：标签在、值格空（三附件） ---- */
{
  const signs = {
    "附件1": ["教师签字", "学管师签字", "教管主任签字", "家长签字"],
    "附件2": ["教师签字", "学管师签字", "教管主任签字", "家长签字"],
    "附件3": ["学科教师签字", "学管签字", "教管主任签字", "家长签字"],
  };
  let ok = true, detail = [];
  for (const [att, labels] of Object.entries(signs)) {
    for (const lab of labels) {
      const found = D[att].tables[0].cells.some(r => r.includes(lab));
      if (!found) { ok = false; detail.push(`${att} 缺 ${lab}`); }
    }
    // 签字行里不能有 XXX
    const signRows = D[att].tables[0].cells.filter(r => r.some(c => /签字/.test(c)));
    if (signRows.some(r => r.some(c => /XXX/.test(c)))) { ok = false; detail.push(`${att} 还留着 XXX`); }
  }
  record("签字栏：四个标签都在、且**值格一律留空**（没有 XXX，打印后手写）",
    ok, detail.join(" / ") || "三附件都干净");
}

/* ---- 2.6 固定文字全集 + 样例泄漏扫描 ---- */
{
  // 逐个附件列它**应该有**的固定文字（跨附件拉一张大表会假红：附件1 本来没有「错题分析」）
  const T1 = "行未来教育集团个性化试卷分析模板", T3 = "行未来教育集团个性化辅导方案模板";
  const SIGN12 = ["教师签字", "学管师签字", "教管主任签字", "家长签字"];
  const FIXED_BY_ATT = {
    "附件1": [T1, "学生姓名", "学校年级", "教师姓名", "任教学科", "已学课时/单科总课时", "考试类型",
      "入学成绩/排名", "本次成绩/排名", "成绩变化原因分析", "学生角度", "教师角度", "其它原因",
      "方案调整及应对措施", "教师教学", "学生配合", "家长配合", ...SIGN12],
    "附件2": [T1, "学生姓名", "学校年级", "教师姓名", "任教学科", "已学课时/单科总课时", "考试类型",
      "入学成绩/排名", "本次成绩/排名", "错题分析", "题号", "题目", "考点", "错因",
      "方案调整及应对措施", "教师教学", "学生配合", "家长配合", ...SIGN12],
    "附件3": [T3, "学生姓名", "学校年级", "教师姓名", "辅导课时", "项目", "具体内容", "三次课后", "阶段总结",
      "学情分析", "学科知识掌握情况", "学习方法与能力", "学习态度与习惯", "其它方面",
      "拟采取的措施", "理论学习", "方法习得", "能力提升", "习惯培养",
      "预期达成的效果", "知识层面", "能力层面", "非学科层面", "成绩结果统计", "入学成绩", "补习后",
      "辅导进度及结果验收", "知识模块", "具体知识点（含检测）及预期目标", "课时数",
      "效果评估（比对目标）及方案调整", "学科教师签字", "学管签字", "教管主任签字", "家长签字"],
  };
  const strip = (s) => String(s == null ? "" : s).replace(/\s+/g, "");
  const missing = [];
  for (const [att, labels] of Object.entries(FIXED_BY_ATT)) {
    const hay = strip(D[att].allText);
    for (const label of labels) if (!hay.includes(strip(label))) missing.push(`${att}:${label}`);
  }
  record("固定文字一个字没改：各附件的标题行 + 全部行列标签都还在（按附件分别核对）",
    missing.length === 0, missing.slice(0, 6).join(" / ") || "全部齐全");

  // 语文样例关键词（这些**绝不能**出现在导出件里）
  const SAMPLE = ["语病", "文言文", "红楼梦", "乡土中国", "散文", "诗歌", "名著", "虚词", "实词",
    "作文审题", "非连续性文本", "语言表达连贯", "图文转换", "文化常识", "天津高三", "语文",
    "语病的辨析与修改", "知识体系尚未建立", "孩子"];
  const leaks = [];
  for (const att of ["附件1", "附件2", "附件3"]) {
    for (const kw of SAMPLE) {
      if (D[att].allText.includes(kw)) leaks.push(`${att}:${kw}`);
    }
  }
  record("★★样例不泄漏：语文样例关键词（语病/文言文/红楼梦/天津高三/语文…）一个都不出现",
    leaks.length === 0, leaks.slice(0, 8).join(" / ") || "干净");
  record("★样例不泄漏（原始模板里确实有这些词，防假绿）",
    ["语病", "语文", "红楼梦"].every(kw =>
      CompanyTemplateData.getText("附件2", "word/document.xml").includes(kw)),
    "模板原文里能搜到 语病/语文/红楼梦 ⇒ 上面的扫描是有意义的");
}

/* ---- 2.7 取值合成的边界 ---- */
{
  const I = CompanyDocx._internal;
  record("合成规则：成绩/排名四态（都有/只有分数/只有排名/都空）",
    I.scoreRank("90分", "500名") === "90分/500名" && I.scoreRank("90分", "") === "90分" &&
    I.scoreRank("", "500名") === "/500名" && I.scoreRank("", "") === "",
    JSON.stringify([I.scoreRank("90分", "500名"), I.scoreRank("90分", ""), I.scoreRank("", ""), ]));
  record("合成规则：课时四态（已学/总）",
    I.hoursPair("10小时", "40小时") === "10小时/40小时" &&
    I.hoursPair("", "40小时") === "/40小时" && I.hoursPair("", "") === "",
    JSON.stringify([I.hoursPair("10小时", "40小时"), I.hoursPair("", "40小时"), I.hoursPair("", "")]));
  record("合成规则：学校年级拼接（学校 + 年级）/ 只有年级",
    I.schoolGrade("天津一中", "高三") === "天津一中高三" && I.schoolGrade("", "高三") === "高三",
    JSON.stringify([I.schoolGrade("天津一中", "高三"), I.schoolGrade("", "高三")]));
  record("内部工具：按标签定位得到行、取格文字都正常（定位不到会抛错，不是静默不填）",
    I.rowText(I.splitRows("<w:tr><w:tc><w:p><w:r><w:t>X</w:t></w:r></w:p></w:tc></w:tr>")[0]) === "X",
    "最小 XML 也能解析");
}

/* ==========================================================================
   3. 浏览器：接线是否真的通了
   ========================================================================== */
const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
};
const { adminEmail, password } = readUsers();
readEnv();
killPort3000();
await sleep(1500);
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore", env: { ...process.env } });
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch { /* 等 */ }
}
record("（准备）本地服务已起来", (await fetch(`${BASE}/tools/paper-analysis/index.html`)).status === 200);

let edge = null;
try {
  const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-company");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, inTool, goto, login } = makePageApi(cdp, sessionId);
  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      pageErrors.push(`${String(d?.text)} ${String(d?.exception?.exception?.description ?? "").slice(0, 140)}`);
    }
  });

  record("登录成功", await login(adminEmail, password));
  await goto("/tools/paper-analysis", 5000);

  const ui = await inTool(`
    const b1 = w.document.getElementById('btnCompanyExport');
    const sel = w.document.getElementById('coExamType');
    return {
      btn: !!b1, att1: !!w.document.getElementById('coAtt1'), att2: !!w.document.getElementById('coAtt2'),
      opts: sel ? [...sel.options].map(o => o.value) : null,
      mods: { engine: !!w.CompanyDocx, data: !!w.CompanyTemplateData, hooks: !!w.CompanyExportHooks },
    };
  `);
  record("工具页有「公司模板导出」面板：导出按钮 + 附件1/2 单选",
    ui?.btn === true && ui?.att1 === true && ui?.att2 === true, JSON.stringify(ui));
  record("考试类型是**下拉**且正好 5 个选项（校考/月考/期中/期末/内部考，另有留空项）",
    Array.isArray(ui?.opts) && ["校考", "月考", "期中", "期末", "内部考"].every(v => ui.opts.includes(v)),
    JSON.stringify(ui?.opts));
  record("两个共用模块在页面里加载成功（template-data + company-docx）",
    ui?.mods?.engine === true && ui?.mods?.data === true, JSON.stringify(ui?.mods));

  // 造一份报告（导出要用报告里算好的错题与原因）
  const setup = await inTool(`
    w.document.getElementById('btnDemo').click();
    w.document.getElementById('btnParse').click();
    w.document.getElementById('stuName').value = '探针同学';
    let zeroed = 0;
    for (const no of [1, 2, 3]) {
      const el = w.document.querySelector('#scoreList input[data-got="' + no + '"]');
      if (el) { el.value = '0'; el.dispatchEvent(new w.Event('input', { bubbles: true })); zeroed++; }
    }
    w.document.getElementById('btnGen').click();
    w.document.getElementById('coSchool').value = '天津一中';
    w.document.getElementById('coExamType').value = '期中';
    w.document.getElementById('coEntryScore').value = '90分';
    w.document.getElementById('coEntryRank').value = '500名';
    w.document.getElementById('coCurrentRank').value = '12名';
    w.document.getElementById('coLearnedHours').value = '10小时';
    w.document.getElementById('coTotalHours').value = '40小时';
    return { zeroed, hasReport: w.document.getElementById('reportText').textContent.length > 200 };
  `);
  record("（准备）生成报告并填好导出参数", setup?.zeroed === 3 && setup?.hasReport === true, JSON.stringify(setup));

  const built = await inTool(`
    const r = w.CompanyExportHooks.buildBytes('附件2');
    if (!r) return { err: 'buildBytes 返回 null' };
    const d = w.CompanyExportHooks.collect();
    return { len: r.bytes.length, head: [r.bytes[0], r.bytes[1]], att: r.att,
             wrong: d.wrongRows.length, student: d.student, examType: d.examType,
             topicEqPoint: d.wrongRows.every(x => x.topic === x.point) };
  `);
  record("★浏览器里能导出附件2（拿到真实字节，PK 头正确）",
    built?.len > 20000 && built?.head?.[0] === 80 && built?.head?.[1] === 75,
    `${built?.len} 字节 head=${JSON.stringify(built?.head)}`);
  record("★导出数据取自**当前页面**（学生姓名/考试类型/错题行数都对）",
    built?.student === "探针同学" && built?.examType === "期中" && built?.wrong === 3,
    JSON.stringify({ student: built?.student, examType: built?.examType, wrong: built?.wrong }));
  record("★「题目」列口径：每一行的 题目 == 考点（都用知识点）",
    built?.topicEqPoint === true, String(built?.topicEqPoint));

  const clicked = await inTool(`
    w.document.getElementById('coAtt1').checked = true;
    w.document.getElementById('btnCompanyExport').click();
    return { hint: w.document.getElementById('coHint').textContent };
  `);
  record("点「导出所选附件」按钮有反馈（提示已导出附件1）",
    /附件1/.test(String(clicked?.hint ?? "")), JSON.stringify(clicked?.hint));

  /* ======================================================================
     ★★ 附件3（辅导计划）接线（2026-10 第十八批）
     ----------------------------------------------------------------------
     验的是"**工具页真的把数据交给了引擎**"，而不是又跑一遍引擎（引擎那段在 §1/§2 已逐格核过）。
     所以这里：填表 → 生成 → 面板取数 → 拿**真实字节** → 交给 python-docx 再核一次。
     ====================================================================== */
  {
    await goto("/tools/math-plan", 5000);
    const has3 = await inTool(`
      return { btn: !!w.document.getElementById('btnCompany3'),
               panel: !!w.document.getElementById('company3Panel'),
               hooks: !!(w.MathPlanCompany3Hooks),
               school: !!w.document.getElementById('co3School'),
               dur: !!w.document.getElementById('co3Duration'),
               freq: !!w.document.getElementById('co3Freq'),
               entry: !!w.document.getElementById('co3EntryScore'),
               mods: { engine: !!w.CompanyDocx, data: !!w.CompanyTemplateData } };
    `);
    record("★附件3：数学方案页有「🏢 公司模板导出（附件3）」按钮 + 面板（输入框齐全）",
      has3?.btn === true && has3?.panel === true && has3?.school === true &&
      has3?.dur === true && has3?.freq === true && has3?.entry === true,
      JSON.stringify(has3));
    record("★附件3：共用引擎与模板数据在数学方案页也加载成功（同一份 company-docx.js）",
      has3?.mods?.engine === true && has3?.mods?.data === true && has3?.hooks === true,
      JSON.stringify(has3?.mods));

    const filled3 = await inTool(`
      const setV = (id, v) => { const el = w.document.getElementById(id); if(!el) return false;
        el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); return true; };
      const okName = setV('f-name', '附件3探针同学');
      setV('f-campus', '燕郊中学校区'); setV('f-teach', '郭庆杰');
      const g = w.document.getElementById('f-grade');
      if (g && g.options && g.options.length) { g.selectedIndex = Math.min(2, g.options.length - 1);
        g.dispatchEvent(new w.Event('change', { bubbles: true })); }
      w.document.getElementById('btnGen').click();
      w.document.getElementById('btnCompany3').click();          // 展开面板 → 自动填默认值
      const durDefault = w.document.getElementById('co3Duration').value;
      const freqDefault = w.document.getElementById('co3Freq').value;
      setV('co3School', '天津一中');                              // 决策1 的 A：手填学校（不是校区）
      setV('co3Duration', '2026年10月--2027年1月');               // 老师改成自己的时间
      setV('co3EntryScore', '90分');
      const rows = w.MathPlanCompany3Hooks.collect().rows;
      return { okName, durDefault, freqDefault, grade: g ? g.value : null,
               rowCount: rows.length, firstModule: rows[0] && rows[0].module,
               totalHours: w.MathPlanCompany3Hooks.collect().totalHours };
    `);
    record("★附件3（准备）：生成方案 → 展开面板（默认值自动填好、逐次课表取到了）",
      filled3?.okName === true && filled3?.rowCount > 0,
      JSON.stringify(filled3));
    record("★附件3：面板默认值来自页面（辅导时间按今天+总周数推算、周课时=在校每周次数）",
      /^\d{4}年\d{1,2}月--\d{4}年\d{1,2}月$/.test(String(filled3?.durDefault ?? "")) &&
      String(filled3?.freqDefault ?? "") === "2",
      `duration=${filled3?.durDefault} freq=${filled3?.freqDefault}`);

    const built3 = await inTool(`
      const out = { stage: 'start' };
      const H = w.MathPlanCompany3Hooks;
      out.hasHooks = !!H;
      if (H) {
        const r = H.buildBytes();
        out.hasBytes = !!r;
        if (r) {
          const d = r.data;
          const merged = [];
          for (const x of d.rows) {
            const m = String(x.module || '').replace(/[（(][^（()）]*[)）]\\s*$/, '').trim();
            if (merged.length && m && merged[merged.length - 1] === m) continue;
            merged.push(m);
          }
          // ⚠️ 十几万字节**不能**当数组原样返回（JSON 序列化会把它变成超大对象数组，
          //    又慢又可能把 CDP 消息撑爆）→ 在页面里转成 base64 再传。
          // ⚠️ 浏览器里 build() 返回的是**普通数组**（不是 Uint8Array）⇒ 不能用 subarray，
          //    按下标循环（本轮实测就栽在这里：u8.subarray is not a function）。
          let bin = '';
          const u8 = r.bytes;
          for (let i = 0; i < u8.length; i += 8192) {
            const chunk = u8.slice ? u8.slice(i, i + 8192) : u8;
            bin += String.fromCharCode.apply(null, chunk);
          }
          out.len = u8.length;
          out.head = [u8[0], u8[1]];
          out.b64 = w.btoa(bin);
          out.student = d.student;
          out.school = d.school;
          out.dur = d.durationText;
          out.rowCount = d.rows.length;
          out.mergedCount = merged.length;
          out.modules = merged;
          out.stage = 'ok';
        }
      }
      return out;
    `);
    record("★附件3：浏览器里能导出（拿到真实字节，PK 头正确）",
      built3?.len > 20000 && built3?.head?.[0] === 80 && built3?.head?.[1] === 75,
      `${built3?.len} 字节 head=${JSON.stringify(built3?.head)} stage=${built3?.stage} hasHooks=${built3?.hasHooks} hasBytes=${built3?.hasBytes} err=${built3?.__err ?? ""}`);
    record("★附件3：取数取自**当前页面**（学生姓名/手填学校/改过的辅导时间都对）",
      built3?.student === "附件3探针同学" && built3?.school === "天津一中" &&
      built3?.dur === "2026年10月--2027年1月",
      JSON.stringify({ student: built3?.student, school: built3?.school, dur: built3?.dur }));
    record("★附件3：进度表行数会跟着课表变（课表 N 条 → 合并后 M 行），不是固定 17 行",
      built3?.rowCount > 0 && built3?.mergedCount > 0 && built3?.mergedCount <= built3?.rowCount,
      `课表 ${built3?.rowCount} 条 → 合并 ${built3?.mergedCount} 行：${JSON.stringify(built3?.modules)}`);

    // 把浏览器拿到的**真实字节**写出来，交给 python-docx 独立核一次
    if (typeof built3?.b64 === "string" && built3.b64.length > 1000) {
      const f3 = `${OUT_DIR}\\浏览器导出-附件3.docx`;
      writeFileSync(f3, Buffer.from(built3.b64, "base64"));
      const d3 = dumpDocx(f3);
      const r3 = d3.tables[0].cells;
      const head3 = r3.find(r => r.some(c => c.indexOf("知识模块") >= 0));
      const hi3 = r3.indexOf(head3);
      const data3 = r3.slice(hi3 + 1, hi3 + 1 + built3.mergedCount);
      record("★★附件3：浏览器导出件的进度表**逐格**与预期一致（模块名合并、课时为该模块之和）",
        data3.length === built3.mergedCount &&
        data3[0]?.[0] === built3.modules[0] &&
        data3.every(r => r && r.length === 4),
        JSON.stringify(data3.map(r => [r?.[0], r?.[2]])));
      const flat = JSON.stringify(r3);
      const hits = [];
      for (const re of [/语病|文言文|图文转换|语言表达|敬辞|谦辞|非连续文本/]) {
        const m = flat.match(new RegExp(re.source, "g"));
        if (m) hits.push(re.source + "×" + m.length);
      }
      record("★★附件3：浏览器导出件**一个语文样例都不许有**（模板样例的语文内容，尤其进度表那 17 行）",
        hits.length === 0,
        hits.length ? "命中的样例字样：" + hits.join(" / ") : "没有任何模板样例字样");
      record("★附件3：浏览器导出件的合计行 = 各模块课时之和",
        data3.length > 0 && /^\d+小时$/.test(String(r3[hi3 + 1 + built3.mergedCount]?.[2] ?? "")),
        `合计格=${JSON.stringify(r3[hi3 + 1 + built3.mergedCount]?.[2])}`);
    } else {
      record("★附件3：浏览器导出件能交给 python-docx 复核", false, "字节没拿到，跳过逐格复核");
    }

    // 一键开关（与附件1/2 同一套口径；这里验数学方案页也认）
    await goto("/tools/math-plan?nocompanyexport=1", 4500);
    const off3 = await inTool(`
      return { disabled: w.MathPlanCompany3Hooks.disabled(),
               btnShown: w.document.getElementById('btnCompany3').style.display !== 'none',
               panelShown: w.document.getElementById('company3Panel').style.display !== 'none',
               others: !!w.document.getElementById('btnDoc') && !!w.document.getElementById('btnGen') };
    `);
    record("⭐附件3：`?nocompanyexport=1` → 按钮与面板都消失",
      off3?.disabled === true && off3?.btnShown === false && off3?.panelShown === false,
      JSON.stringify(off3));
    record("⭐附件3：关掉时**其它功能照常**（旧导出、生成方案按钮都在）",
      off3?.others === true, JSON.stringify(off3));
    // 关掉时点了也不导出（点不动）
    const off3click = await inTool(`
      const before = (w.MathPlanCompany3Hooks.disabled());
      w.document.getElementById('btnCompany3Export').click();
      return { disabled: before, hint: w.document.getElementById('co3Hint').textContent };
    `);
    record("⭐附件3：关掉后点导出按钮**什么都不会发生**（不报错、不产生文件、提示为空）",
      off3click?.disabled === true && String(off3click?.hint ?? "") === "",
      JSON.stringify(off3click));
  }

  /* ======================================================================
     ⭐ 一键开关（用户 2026-10 专门要求的）：三种关法都要真的管用
     ====================================================================== */
  // ⚠️ 必须**先回到试卷分析页**：上一段测的是数学方案页，
  //    不切回来的话下面这段会在错误的页面上找 CompanyExportHooks（本轮实测踩到）。
  await goto("/tools/paper-analysis", 4500);
  {
    const on = await inTool(`
      const p = w.document.getElementById('companyPanel');
      return { disabled: w.CompanyExportHooks.disabled(),
               visible: !!p && p.style.display !== 'none' && !p.hasAttribute('hidden') };
    `);
    record("⭐ 默认是**开着**的：面板可见、开关判定为未关闭",
      on?.disabled === false && on?.visible === true, JSON.stringify(on));

    // 关法②：工具页直链加参数（最可能的用法：把工具页存书签）
    //  ⚠️ 直链时工具页是顶层文档（没有 iframe）→ 只能用 ev 在顶层求值
    await goto("/tools/paper-analysis/index.html?nocompanyexport=1", 4000);
    const off1 = await ev(`(() => {
      const p = document.getElementById('companyPanel');
      document.getElementById('btnCompanyExport').click();
      return { disabled: window.CompanyExportHooks.disabled(),
               visible: !!p && p.style.display !== 'none' && !p.hasAttribute('hidden'),
               hint: document.getElementById('coHint').textContent };
    })()`);
    record("⭐ 关法②：工具页直链加 `?nocompanyexport=1` → 面板消失、开关为已关闭",
      off1?.disabled === true && off1?.visible === false, JSON.stringify(off1));
    record("⭐ 关掉后按钮点不动（不会导出，也不会报错）",
      String(off1?.hint ?? "") === "", JSON.stringify(off1?.hint));

    // 关法②b：父页加参数（工具页在 iframe 里，必须能读到父页 search）
    await goto("/tools/paper-analysis?nocompanyexport=1", 4000);
    const off2 = await inTool(`
      const p = w.document.getElementById('companyPanel');
      return { disabled: w.CompanyExportHooks.disabled(),
               visible: !!p && p.style.display !== 'none' && !p.hasAttribute('hidden') };
    `);
    record("⭐ 关法②b：**父页**加 `?nocompanyexport=1` → iframe 里的面板同样消失（读父页 search）",
      off2?.disabled === true && off2?.visible === false, JSON.stringify(off2));

    // 关法③：localStorage（改一次就记住，不用每次带参数）
    await goto("/tools/paper-analysis/index.html", 4000);
    await ev(`localStorage.setItem('pa_nocompanyexport','1')`);
    await goto("/tools/paper-analysis", 4000);
    const off3 = await inTool(`
      const p = w.document.getElementById('companyPanel');
      return { disabled: w.CompanyExportHooks.disabled(),
               visible: !!p && p.style.display !== 'none' && !p.hasAttribute('hidden') };
    `);
    record("⭐ 关法③：`localStorage.setItem('pa_nocompanyexport','1')` 后刷新 → 面板消失",
      off3?.disabled === true && off3?.visible === false, JSON.stringify(off3));

    // 开回来 + 确认没影响别的功能
    await goto("/tools/paper-analysis/index.html", 4000);
    await ev(`localStorage.removeItem('pa_nocompanyexport')`);
    await goto("/tools/paper-analysis", 4000);
    const back = await inTool(`
      const p = w.document.getElementById('companyPanel');
      return { disabled: w.CompanyExportHooks.disabled(),
               visible: !!p && p.style.display !== 'none' && !p.hasAttribute('hidden'),
               others: !!w.document.getElementById('btnDocx') && !!w.document.getElementById('reportText') &&
                       !!w.document.getElementById('btnPolishAll') };
    `);
    record("⭐ 开回来：清掉 localStorage 后刷新 → 面板恢复",
      back?.disabled === false && back?.visible === true, JSON.stringify(back));
    record("⭐ 开关**不影响其它功能**（旧导出按钮、报告框、AI 润色按钮都还在）",
      back?.others === true, JSON.stringify(back));
  }

  record("页面无真实 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "0 条");
  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("浏览器段未异常中断", false, String(e && e.message ? e.message : e));
  console.error(e?.stack ?? e);
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  killPort3000();
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
