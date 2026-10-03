// 校验 feedback.html 内联脚本的语法（用 new Function 解析，不执行）
import { readFileSync } from "node:fs";

const FILE = "D:/my-website/my-toolbox/public/tools/feedback.html";
const html = readFileSync(FILE, "utf8");

// 抓取最后一个 <script>...</script>（主脚本，无 src）
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
console.log("内联 script 块数量:", scripts.length);

let ok = true;
scripts.forEach((code, i) => {
  try {
    // 仅解析，不执行
    new Function(code);
    console.log(`  ✅ 第 ${i + 1} 块语法正确（${code.split("\n").length} 行）`);
  } catch (err) {
    ok = false;
    console.log(`  ❌ 第 ${i + 1} 块语法错误: ${err.message}`);
    // 定位行号
    const m = err.stack?.match(/<anonymous>:(\d+)/);
    if (m) {
      const lines = code.split("\n");
      const ln = Number(m[1]);
      console.log(`     约在第 ${ln} 行:`);
      for (let j = Math.max(0, ln - 3); j < Math.min(lines.length, ln + 2); j++) {
        console.log(`     ${j + 1}: ${lines[j]}`);
      }
    }
  }
});

// 结构确认：新增的函数与常量都在
const checks = [
  ["NEXT_MODE 常量", /const NEXT_MODE = /],
  ["bootFromApi 函数", /function bootFromApi\(\)/],
  ["deleteHistoryItemAdapter", /function deleteHistoryItemAdapter\(/],
  ["deleteStudentAdapter", /function deleteStudentAdapter\(/],
  ["NEXT_MODE 分支数量", /NEXT_MODE/g],
];
console.log("\n=== 结构确认 ===");
for (const [label, re] of checks) {
  const m = html.match(re);
  const count = (html.match(re) ?? []).length;
  console.log(`  ${label}: ${count > 0 ? `✅ ${count} 处` : "❌ 缺失"}`);
}

// 确认 BYOK 分支在 next 模式下不可达（polish 中 next 分支在 BYOK 之前）
const polishIdx = html.indexOf("async function polish()");
const nextBranch = html.indexOf("if(API.mode === 'next')", polishIdx);
const byokBranch = html.indexOf("const cfg = loadApiCfg();", polishIdx);
console.log("\n=== BYOK 分支位置 ===");
console.log("  polish 函数起始:", polishIdx);
console.log("  next 分支:", nextBranch, nextBranch > polishIdx ? "✅ 在函数内" : "❌");
console.log("  BYOK 分支:", byokBranch, byokBranch > polishIdx ? "✅ 在函数内" : "❌");
console.log("  顺序:", nextBranch < byokBranch ? "next 分支在前（next 模式下先 return，BYOK 不可达）✅" : "⚠️ 顺序可疑");

process.exit(ok ? 0 : 1);
