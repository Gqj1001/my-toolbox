#!/usr/bin/env node
/** Markdown 表格解析（学情报告渲染用）纯函数测试 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRecorder } from "./_helpers.mjs";

process.removeAllListeners("warning");
process.on("warning", () => { /* 静音 type stripping 警告 */ });

const { parseMarkdownTables } = await import("../src/lib/markdown-tables.ts");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { record, summary } = makeRecorder();

{
  const blocks = parseMarkdownTables(
    "【整体学情】\n先看总表：\n\n| 月份 | 得分率 | 变化 |\n| --- | ---: | :---: |\n| 9月 | 62% | — |\n| 10月 | 71% | +9 |\n\n结论：有提升。",
  );
  record("★报告里的 Markdown 表格被识别成 table 块（表头 + 两行）",
    blocks.some((b) => b.type === "table"), JSON.stringify(blocks));
  const t = blocks.find((b) => b.type === "table");
  record("★表头与单元格逐字正确、对齐分隔行没有被当数据",
    t?.headers.join("|") === "月份|得分率|变化" &&
      t?.rows.length === 2 &&
      t?.rows[0].join("|") === "9月|62%|—" &&
      t?.rows[1].join("|") === "10月|71%|+9",
    JSON.stringify(t));
  record("★表格前后的说明文字都保留（不会被吞掉）",
    blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").includes("先看总表") &&
      blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").includes("结论：有提升"),
    JSON.stringify(blocks.map((b) => b.type)));
}

{
  const blocks = parseMarkdownTables("普通文本，只有一个竖线 | 不是表格。\n第二行也没有表格。");
  record("不是规整表格的竖线不会被误判（保持文本）",
    blocks.length === 1 && blocks[0].type === "text" && !blocks.some((b) => b.type === "table"),
    JSON.stringify(blocks));
}

{
  const blocks = parseMarkdownTables("| A | B |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |");
  const t = blocks.find((b) => b.type === "table");
  record("列数不一致时按表头补齐/截断（渲染不错位）",
    t?.rows[0].length === 2 && t?.rows[0].join("|") === "1|" &&
      t?.rows[1].length === 2 && t?.rows[1].join("|") === "2|3",
    JSON.stringify(t));
}

{
  const src = readFileSync(join(ROOT, "src/app/dashboard/report-view.tsx"), "utf8");
  const panel = readFileSync(join(ROOT, "src/app/dashboard/analysis-panel.tsx"), "utf8");
  record("★契约：报告面板使用 ReportView 渲染（不再把整篇报告塞进 <pre>）",
    panel.includes("ReportView") && !/<pre[\s>]/.test(panel),
    "analysis-panel → ReportView");
  record("★契约：ReportView 使用 parseMarkdownTables 并渲染 table",
    src.includes("parseMarkdownTables") && src.includes("<table") && src.includes("<thead"),
    "ReportView 已接解析器");
}

process.exit(summary() ? 0 : 1);
