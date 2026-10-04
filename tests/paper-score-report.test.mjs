// 第二批验收第 2 条：改完逐题分值后，生成的 Word 报告里分值是否正确
//
// 这条链路是纯函数：app.js collectCtx() → Narrator → ReportTemplate.build() → docx bytes。
// 所以不用浏览器也能证明「逐题分值真的进了文档」，而且比肉眼看更严格。
//
// 做法：造一份解答题分值各不相同的试卷 → 给几个学生得分 → 走完整链路生成 docx
//      → 从生成的 docx 里抽回 document.xml 文本 → 断言每题分值/得分/总分都对得上。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JS = join(ROOT, "public/tools/paper-analysis/js");

const PaperParser = require(join(JS, "paper-parser.js"));
const Narrator = require(join(JS, "narrator.js"));
const ErrorEngine = require(join(JS, "error-engine.js"));
const KnowledgeClassifier = require(join(JS, "knowledge-classifier.js"));
const ReportTemplate = require(join(JS, "report-template.js"));
const TemplateData = require(join(JS, "template-data.js"));
const ReportDocx = require(join(JS, "report-docx.js"));

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
const r2 = (x) => Math.round((parseFloat(x) || 0) * 100) / 100;

/* ---------- 从 zip 里抽 word/document.xml（与 paper-extract.ts 同一算法） ---------- */
const unzipDocumentXml = (buf) => {
  let i = 0, target = null;
  while (true) {
    i = buf.indexOf(Buffer.from("PK\x01\x02"), i);
    if (i < 0) break;
    const method = buf.readUInt16LE(i + 10);
    const csize = buf.readUInt32LE(i + 20);
    const nlen = buf.readUInt16LE(i + 28);
    const elen = buf.readUInt16LE(i + 30);
    const clen = buf.readUInt16LE(i + 32);
    const lho = buf.readUInt32LE(i + 42);
    const name = buf.subarray(i + 46, i + 46 + nlen).toString("utf8");
    if (name === "word/document.xml") { target = { method, csize, lho }; break; }
    i += 46 + nlen + elen + clen;
  }
  if (!target) throw new Error("生成的 docx 里没有 word/document.xml");
  const lnameLen = buf.readUInt16LE(target.lho + 26);
  const lextraLen = buf.readUInt16LE(target.lho + 28);
  const start = target.lho + 30 + lnameLen + lextraLen;
  const raw = buf.subarray(start, start + target.csize);
  return target.method === 0 ? raw.toString("utf8") : inflateRawSync(raw).toString("utf8");
};
// 表格行文本 → 便于断言
const xmlToLines = (xml) => (xml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || [])
  .map((tr) => (tr.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
    .map((t) => t.replace(/<[^>]+>/g, ""))
    .join(" | "));

/* ==========================================================================
   造卷：新高考 I/II 卷（8 单选 / 3 多选 / 3 填空 / 5 解答，共 150）
   解答题逐题分值改成 13/15/15/17/17（总和仍是 77）
   ========================================================================== */
const typeDist = [
  { type: "单选题", count: 8 }, { type: "多选题", count: 3 },
  { type: "填空题", count: 3 }, { type: "解答题", count: 5 },
];
const scoreAssign = PaperParser.assignScores(typeDist, 150, "新高考 I/II 卷");
const jd = scoreAssign.perType["解答题"];
jd.spread = [13, 15, 15, 17, 17];
jd.total = r2(jd.spread.reduce((a, x) => a + x, 0));
jd.per = r2(jd.total / jd.count);
scoreAssign.fullScore = r2(Object.values(scoreAssign.perType).reduce((a, x) => a + x.total, 0));

// 题号：单选 1-8，多选 9-11，填空 12-14，解答 15-19
const questions = [];
let no = 1;
const push = (type, count, per) => {
  for (let k = 0; k < count; k++) {
    const full = Array.isArray(per) ? per[k] : per;
    questions.push({
      no: no, section: type, grade: k % 3 === 0 ? "easy" : (k % 3 === 1 ? "mid" : "hard"),
      difficulty: k % 3 === 0 ? "较易" : (k % 3 === 1 ? "中等" : "较难"),
      coeff: 0.5 + (k % 5) * 0.1, knowledge: ["函数与导数"],
      // 让解答题里有两道「部分分」，验证得分也会跟着分值走
    });
    no++;
  }
};
push("单选题", 8, scoreAssign.perType["单选题"].spread || scoreAssign.perType["单选题"].per);
push("多选题", 3, scoreAssign.perType["多选题"].spread || scoreAssign.perType["多选题"].per);
push("填空题", 3, scoreAssign.perType["填空题"].spread || scoreAssign.perType["填空题"].per);
push("解答题", 5, jd.spread);

const paper = {
  title: "2026年10月月考", overallDifficulty: "适中", scope: ["函数与导数"],
  typeDist, questions,
};

// records：全部满分，只有第 15、19 题给了部分分
const records = {};
paper.questions.forEach((q) => {
  const info = scoreAssign.perType[q.section];
  const idx = paper.questions.filter((x) => x.section === q.section).findIndex((x) => x.no === q.no);
  const full = Array.isArray(info.spread) && info.spread[idx] != null ? info.spread[idx] : info.per;
  records[q.no] = { full, got: full, note: "" };
});
records[15].got = 7;     // 13 分题得 7 分
records[19].got = 12;    // 17 分题得 12 分

/* ---------- 复现 app.js collectCtx() ---------- */
const collectCtx = () => {
  const band = ErrorEngine.bandOf(
    Object.values(records).reduce((a, r) => a + r.got, 0),
    Object.values(records).reduce((a, r) => a + r.full, 0) || 150);
  const diags = ErrorEngine.diagnoseAll(paper, records);
  const modules = ErrorEngine.byModule(diags, KnowledgeClassifier, paper.questions, records);
  const typeAgg = ErrorEngine.byType(diags);
  const questionRows = Narrator.buildQuestionRows(paper, records, diags);
  const typeSummary = Narrator.buildTypeSummary(paper, records);
  const score = r2(Object.values(records).reduce((a, r) => a + r.got, 0));
  const full = r2(Object.values(records).reduce((a, r) => a + r.full, 0));
  const skeleton = ErrorEngine.pickSkeleton("10月月考", score);
  return { diags, modules, typeAgg, questionRows, typeSummary, band, skeleton, score, full };
};
const ctx = collectCtx();

const totalFull = r2(Object.values(records).reduce((a, r) => a + r.full, 0));
const totalGot = r2(Object.values(records).reduce((a, r) => a + r.got, 0));
console.log(`\n      逐题满分合计 ${totalFull}（应为 150），得分合计 ${totalGot}`);
ok("逐题满分合计 = 150（逐题分值之和自洽）", totalFull === 150, String(totalFull));
eq("解答题逐题分值 = 13/15/15/17/17",
  ctx.questionRows.filter((r) => r.section === "解答题" || r.type === "解答题").map((r) => r2(r.full)),
  [13, 15, 15, 17, 17]);

/* ---------- 走完整导出链路 ---------- */
const payload = {
  name: "测试同学", gender: "男", grade: "高三", subject: "数学",
  teacher: "郭庆杰", manager: "",
  score: ctx.score, full: ctx.full,
  examDate: "2026年10月15日", examName: "2026年10月月考",
  duration: "120min", examScope: "函数与导数", taughtContent: "", progress: "",
  paper, records,
  questionRows: ctx.questionRows, typeSummary: ctx.typeSummary,
  advice: "（测试用建议段）", fillClass: false, className: "",
};

let bin = null, usedTemplate = false, warnings = [];
try {
  const res = ReportTemplate.build(payload, { template: TemplateData });
  bin = res.blob; usedTemplate = true; warnings = res.warnings || [];
  console.log(`      模板导出成功：${bin.length} 字节，warnings=${JSON.stringify(warnings)}，questionRows=${res.questionRows}`);
} catch (e) {
  console.log(`      模板导出失败：${e.message}`);
}
ok("模板化 Word 导出成功", !!bin && usedTemplate, bin ? `${bin.length} 字节` : "无输出");

if (bin) {
  const xml = unzipDocumentXml(Buffer.from(bin));
  const lines = xmlToLines(xml);
  const all = lines.join("\n");

  // 表3 错题分析：题号 | 题型 | 分值 | 得分 | …
  const findRow = (qno) => lines.find((l) => new RegExp(`^${qno} \\|`).test(l.trim()));
  const row15 = findRow(15), row19 = findRow(19), row16 = findRow(16);

  ok("Word 里能找到第 15 题那一行", !!row15, row15);
  ok("Word 里第 15 题分值 = 13（编辑后的值，不是平均 15.4）",
    !!row15 && /\|\s*13\s*\|/.test(row15), row15);
  ok("Word 里第 15 题得分 = 7", !!row15 && /\|\s*13\s*\|\s*7\s*\|/.test(row15), row15);
  ok("Word 里第 19 题分值 = 17", !!row19 && /\|\s*17\s*\|/.test(row19), row19);
  ok("Word 里第 19 题得分 = 12", !!row19 && /\|\s*17\s*\|\s*12\s*\|/.test(row19), row19);
  ok("Word 里第 16 题仍为 15（未被误改）", !!row16 && /\|\s*15\s*\|/.test(row16), row16);
  ok("Word 里不再出现平均值 15.4", !/15\.4/.test(all), /15\.4/.test(all) ? "仍出现 15.4" : "无 15.4");

  // 表2 题型分布的解答题总分应为 77
  const jdLine = lines.find((l) => /^解答题\s*\|/.test(l.trim()));
  ok("Word 题型分布里解答题总分 = 77", !!jdLine && /\|\s*77\s*\|/.test(jdLine), jdLine);

  // 卷面总分 150
  ok("Word 里卷面总分仍为 150", /150/.test(all), "");
  // 学生总分 = 150 - (13-7) - (17-12) = 139
  ok("Word 里学生总分 = 139", new RegExp(`\\b${ctx.score}\\b`).test(all) && ctx.score === 139,
    `ctx.score=${ctx.score}`);
  console.log(`      得分合计 ctx.score=${ctx.score}（150 - 6 - 5 = 139）`);
}

/* ---------- 兜底渲染器也要一致 ---------- */
try {
  const fallback = ReportDocx.build(payload);
  ok("内置兜底渲染器也能导出", !!fallback && fallback.length > 0, `${fallback ? fallback.length : 0} 字节`);
  if (fallback) {
    const fx = xmlToLines(unzipDocumentXml(Buffer.from(fallback))).join("\n");
    ok("兜底渲染器里解答题分值也是 13/15/15/17/17",
      /13/.test(fx) && /17/.test(fx) && !/15\.4/.test(fx), "");
  }
} catch (e) {
  ok("内置兜底渲染器也能导出", false, e.message);
}

console.log(`\n=== SUMMARY: ${results.filter(Boolean).length}/${results.length} passed ===`);
process.exit(results.every(Boolean) ? 0 : 1);
