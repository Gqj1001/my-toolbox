// 校验生成的 SQL 是否语法安全（引号配对、括号平衡、无换行污染）
import { readFileSync } from "node:fs";

const SQL = "D:/my-website/my-toolbox/supabase/migrations/0004_feedback_tables.sql";
const sql = readFileSync(SQL, "utf8");

console.log("=== 1. 单引号配对检查（逐行） ===");
let unbalanced = [];
sql.split("\n").forEach((line, i) => {
  const stripped = line.replace(/--.*$/, ""); // 去掉行尾注释
  const count = (stripped.match(/'/g) ?? []).length;
  if (count % 2 !== 0) unbalanced.push({ line: i + 1, count, text: line.slice(0, 100) });
});
if (unbalanced.length) {
  console.log(`⚠️ 有 ${unbalanced.length} 行引号数为奇数：`);
  for (const u of unbalanced.slice(0, 10)) console.log(`   ${u.line}: (${u.count}) ${u.text}`);
} else {
  console.log("✅ 所有行的单引号都是成对的");
}

console.log("\n=== 2. 括号平衡（去掉字符串字面量后统计） ===");
let depth = 0;
let minDepth = 0;
let lineNo = 1;
let badLine = null;
for (let i = 0; i < sql.length; i++) {
  const ch = sql[i];
  if (ch === "\n") lineNo++;
  if (ch === "'") {
    // 跳过字符串字面量（含 '' 转义）
    i++;
    while (i < sql.length) {
      if (sql[i] === "'") {
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        break;
      }
      if (sql[i] === "\n") lineNo++;
      i++;
    }
    continue;
  }
  if (ch === "(") depth++;
  else if (ch === ")") {
    depth--;
    if (depth < minDepth) {
      minDepth = depth;
      badLine = lineNo;
    }
  }
}
console.log("最终括号深度:", depth, depth === 0 ? "✅ 平衡" : "❌ 不平衡");
console.log("最小深度:", minDepth, minDepth < 0 ? `❌ 有提前闭合（行 ${badLine}）` : "✅ 无提前闭合");

console.log("\n=== 3. 关键字里的换行/回车/制表符污染 ===");
const tainted = [];
sql.split("\n").forEach((line, i) => {
  // 数据行形如 ('math', '课堂内容', '关键词', 1)
  const m = line.match(/^\s*\('([a-z]+)', '(.+?)', '(.*)'/);
  if (m) {
    const kw = m[3];
    if (/[\r\t]/.test(kw)) tainted.push({ line: i + 1, kw });
  }
});
console.log(tainted.length ? `⚠️ ${tainted.length} 条含异常字符` : "✅ 无换行/制表符污染");

console.log("\n=== 4. 数据行数量与结构 ===");
const dataLines = sql.split("\n").filter((l) => /^\s*\('[a-z]+', '.+', '.+', \d+\),?\s*$/.test(l));
console.log("匹配到规范数据行:", dataLines.length);
const phraseLines = sql.split("\n").filter((l) => /^\s*\('.+', \d+\),?\s*$/.test(l) && !l.includes("'math'") && !l.includes("'english'") && !l.includes("'chinese'") && !l.includes("'physics'") && !l.includes("'history'") && !l.includes("'politics'") && !l.includes("'chemistry'") && !l.includes("'general'"));
console.log("疑似短语行:", phraseLines.length);

console.log("\n=== 5. 各科目关键词数（从 SQL 直接统计） ===");
const counts = {};
for (const line of sql.split("\n")) {
  const m = line.match(/^\s*\('([a-z]+)', '/);
  if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
}
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);

console.log("\n=== 6. 含转义单引号的数据行（应使用 '' 形式） ===");
const escaped = sql.split("\n").filter((l) => /^\s*\('.+''.+/.test(l));
console.log(escaped.length ? `有 ${escaped.length} 行含 '' 转义（正常）` : "无（数据里没有单引号）");
if (escaped.length) for (const l of escaped.slice(0, 3)) console.log("   " + l.trim().slice(0, 90));
