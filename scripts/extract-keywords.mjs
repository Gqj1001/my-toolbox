// 从 feedback.html 提取关键词常量，生成种子 SQL（程序化提取，避免人工转录出错）
import { readFileSync, writeFileSync } from "node:fs";

const HTML = "D:/my-website/my-toolbox/public/tools/feedback.html";
const OUT = "D:/my-website/my-toolbox/supabase/migrations/0005_feedback_seed.sql";

const src = readFileSync(HTML, "utf8");
const lines = src.split(/\r?\n/);

/** 从 `const NAME = ` 开始，按括号配对找到完整语句 */
function extractConst(name) {
  const startIdx = lines.findIndex((l) => new RegExp(`^\\s*const ${name}\\s*=`).test(l));
  if (startIdx === -1) throw new Error(`未找到 const ${name}`);

  let text = "";
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    text += line + "\n";
    for (const ch of line) {
      if (ch === "{" || ch === "[") {
        depth++;
        started = true;
      } else if (ch === "}" || ch === "]") {
        depth--;
      }
    }
    if (started && depth <= 0) break;
  }

  const eq = text.indexOf("=");
  let body = text.slice(eq + 1).trim();
  if (body.endsWith(";")) body = body.slice(0, -1);
  return body;
}

function evalConst(name) {
  const body = extractConst(name);
  // 常量体是纯字面量，直接求值
  return new Function(`return (${body});`)();
}

const SUBJECTS = evalConst("SUBJECTS");
const KW = evalConst("KW");
const OTHER = evalConst("OTHER");
const CATS = evalConst("CATS");
const DEFAULT_PHRASES = evalConst("DEFAULT_PHRASES");

console.log("SUBJECTS:", SUBJECTS.length);
console.log("KW 分类字段:", Object.keys(KW).join(", "));
console.log("OTHER 科目:", Object.keys(OTHER).join(", "));
console.log("CATS:", CATS.map((c) => `${c.id}=${c.name}`).join(" | "));
console.log("DEFAULT_PHRASES:", DEFAULT_PHRASES.length, "条");

// 组装 subject -> categories
const bySubject = {};
for (const [, name] of SUBJECTS.map((s) => [s[0], s[1]])) {
  /* 占位，下面按 subj 处理 */
}
const subjectCodes = SUBJECTS.map(([code]) => code);

for (const code of subjectCodes) {
  const srcObj = code === "math" ? KW : OTHER[code] || OTHER.general;
  bySubject[code] = CATS.map((c) => ({
    subject: code,
    category: c.name,
    keywords: [...(srcObj[c.field] || [])],
  }));
}

const totalKw = Object.values(bySubject).reduce(
  (n, cats) => n + cats.reduce((m, c) => m + c.keywords.length, 0),
  0,
);
console.log("生成关键词总数:", totalKw);

// 生成 SQL
const esc = (s) => String(s).replace(/'/g, "''");

const keywordRows = [];
for (const [code, cats] of Object.entries(bySubject)) {
  for (const c of cats) {
    c.keywords.forEach((kw, i) => {
      keywordRows.push(`  ('${esc(code)}', '${esc(c.category)}', '${esc(kw)}', ${i + 1})`);
    });
  }
}

const phraseRows = DEFAULT_PHRASES.map((p, i) => `  ('${esc(p)}', ${(i + 1) * 10})`);

const sql = `-- ============================================================
-- 课后反馈工作台：初始关键词库与短语库
-- 数据来源：public/tools/feedback.html 中的 KW / OTHER / CATS / DEFAULT_PHRASES
--           （由脚本程序化提取生成，非人工录入）
-- 在 Supabase SQL Editor 整段执行；幂等（按 subject+category+keyword 去重）
-- 请先执行 0004_feedback_tables.sql
-- ============================================================

-- ---------- 1. 关键词库 ----------
insert into public.feedback_keywords (subject, category, keyword, sort_order)
select v.subject, v.category, v.keyword, v.sort_order
from (values
${keywordRows.join(",\n")}
) as v(subject, category, keyword, sort_order)
where not exists (
  select 1 from public.feedback_keywords k
  where k.subject = v.subject and k.category = v.category and k.keyword = v.keyword
);

-- ---------- 2. 结尾短语库 ----------
insert into public.feedback_phrases (phrase, sort_order)
select v.phrase, v.sort_order
from (values
${phraseRows.join(",\n")}
) as v(phrase, sort_order)
where not exists (
  select 1 from public.feedback_phrases p where p.phrase = v.phrase
);

-- ---------- 3. 自检 ----------
select '关键词' as 类型, count(*) as 条数 from public.feedback_keywords
union all
select '短语', count(*) from public.feedback_phrases;

-- 按科目分布
select subject, count(*) as 关键词数
from public.feedback_keywords group by subject order by subject;
`;

writeFileSync(OUT, sql, "utf8");
console.log("\n已写入:", OUT);
console.log("SQL 行数:", sql.split("\n").length, "| 大小:", (Buffer.byteLength(sql, "utf8") / 1024).toFixed(1), "KB");

// 抽样核对
console.log("\n抽样（math / 课堂内容 前 5 个）:");
const mathContent = bySubject.math.find((c) => c.category === "课堂内容");
console.log(" ", mathContent.keywords.slice(0, 5).join(" | "));
console.log("抽样（english / 课堂内容 前 3 个）:");
const engContent = bySubject.english.find((c) => c.category === "课堂内容");
console.log(" ", engContent.keywords.slice(0, 3).join(" | "));
console.log("抽样短语:");
console.log(" ", DEFAULT_PHRASES.slice(0, 3).join(" | "));
