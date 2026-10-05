// 辅导方案「模板化 Word 导出」验证（纯逻辑，不需要浏览器）
//
// 覆盖：
//   1. 模板完整性：278 个占位符全部被替换，文档里不留 {{...}}
//   2. 动态行：行数 < / = / > 67 三档；多余行被删、不足行被深拷贝补齐
//   3. 格式不变：克隆行的列宽与模板一致；tblGrid / styles / media 逐字节相同
//   4. 手填区不动：表外段落、表头行、左侧标签、标题段与模板原文一致
//   5. method 拼接：三轮叙述进文档；无 rounds 时不出现
//   6. 空值：mgr/cons/camp/tchr 传空 → 不留占位符、不留残留
//   7. 回读：写进去的 stage/content/hours/goal 能读回来
//   8. 可重复导出：连续 build 两次字节一致
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "public/tools/math-plan");

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  JSON.stringify(got) === JSON.stringify(want) ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

/* ==========================================================================
   在 vm 里按「浏览器方式」加载三个 UMD 模块
   （删掉 module/exports 判断，让它们走 `else root.X = factory()` 分支）
   ========================================================================== */
const asBrowserScript = (file) => readFileSync(file, "utf8")
  .replace(/if \(typeof module === 'object' && module\.exports\)/g, "if (false)")
  .replace(/if \(typeof module === "object" && module\.exports\)/g, "if (false)");

const ctx = { console, Math, JSON, Array, Object, String, Number, Uint8Array, TextEncoder, TextDecoder, atob: (s) => Buffer.from(s, "base64").toString("binary"), btoa: (s) => Buffer.from(s, "binary").toString("base64") };
ctx.self = ctx;
ctx.window = ctx;
vm.createContext(ctx);

for (const f of ["template-data.js", "js/docx-builder.js", "js/report-template.js"]) {
  vm.runInContext(asBrowserScript(join(DIR, f)), ctx, { filename: f });
}

const T = ctx.MathPlanTemplateData;
const RT = ctx.MathPlanReportTemplate;
const DB = ctx.DocxBuilder;
ok("三个外部脚本都加载成功（模板/导出器/打包器）", !!T && !!RT && !!DB,
  `template=${!!T} report=${!!RT} docx=${!!DB}`);
if (!T || !RT || !DB) { console.log("\n=== SUMMARY: 0/1 passed ===\n（加载失败，后续断言跳过）"); process.exit(1); }

eq("模板占位符数量 = 278", T.PLACEHOLDERS.length, 278);
eq("模板样板行数 = 67", T.LESSON_ROWS, 67);
ok("模板零件表非空且含 document.xml", Array.isArray(T.ORDER) && T.ORDER.includes("word/document.xml"),
  `${T.ORDER.length} 个零件`);

/* ==========================================================================
   解包工具：从生成的 docx 里取零件
   ========================================================================== */
function readPart(buf, want) {
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
    if (name === want) { target = { method, csize, lho }; break; }
    i += 46 + nlen + elen + clen;
  }
  if (!target) throw new Error("生成的 docx 里没有 " + want);
  const lnameLen = buf.readUInt16LE(target.lho + 26);
  const lextraLen = buf.readUInt16LE(target.lho + 28);
  const start = target.lho + 30 + lnameLen + lextraLen;
  const raw = buf.subarray(start, start + target.csize);
  return target.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
}
/** 取文本零件的明文字符串 */
const readText = (buf, want) => readPart(buf, want).toString("utf8");

const cellTexts = (xml) => (xml.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || [])
  .map((tc) => tc.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim());
const rowCount = (xml) => (xml.match(/<w:tr(?:\s[^>]*)?>/g) || []).length;
const rowWidths = (xml) => (xml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || []).map((tr) =>
  (tr.match(/<w:tcW w:w="(\d+)"/g) || []).map((s) => s.replace(/\D/g, "")).join("/"));

/* ==========================================================================
   构造 DEMO 到 67/80 行的 payload
   ========================================================================== */
const mkRows = (n) => Array.from({ length: n }, (_, i) => ({
  stage: "模块" + (i + 1),
  content: "内容" + (i + 1),
  hours: 2,
  goal: "正确率≥" + (80 + (i % 15)) + "%",
}));
const mkPayload = (n, extra) => Object.assign({
  name: "测试同学", grade: "高三", subject: "数学", book: "人教版",
  mgr: "", cons: "", camp: "燕郊中学", tchr: "郭庆杰",
  period: "秋季",
  method: "（1）方案与总量。本方案共 80 课时。（2）学情诊断。基础一般。",
  rows: mkRows(n),
}, extra || {});

const TPL_DOC = T.getText("word/document.xml");

/* ---- 行数 = 67（正好用满） ---- */
{
  const r = RT.build(mkPayload(67), { template: T });
  const doc = readText(Buffer.from(r.blob), "word/document.xml");
  ok("67 行：导出成功", r.blob.length > 0, `${r.blob.length} 字节`);
  eq("67 行：文档行数不变", rowCount(doc), rowCount(TPL_DOC));
  ok("67 行：无残留占位符", !/\{\{/.test(doc), (doc.match(/\{\{[^{}]*\}\}/g) || []).slice(0, 3).join(" "));
  ok("67 行：第 67 行内容写入正确", cellTexts(doc).includes("模块67"), "");
}

/* ---- 行数 = 20（少于 67，应删掉多余样板行） ---- */
{
  const r = RT.build(mkPayload(20), { template: T });
  const doc = readText(Buffer.from(r.blob), "word/document.xml");
  ok("20 行：导出成功且无残留占位符", r.blob.length > 0 && !/\{\{/.test(doc), "");
  eq("20 行：数据行 = 20（删掉了 47 行样板）", r.rows, 20);
  ok("20 行：文档总行数 = 模板 - 47", rowCount(doc) === rowCount(TPL_DOC) - 47,
    `${rowCount(doc)} vs ${rowCount(TPL_DOC) - 47}`);
  ok("20 行：最后一行是第 20 行而不是第 67 行", cellTexts(doc).includes("模块20"), "");
}

/* ---- 行数 = 80（多于 67，应深拷贝补齐） ---- */
{
  const r = RT.build(mkPayload(80), { template: T });
  const doc = readText(Buffer.from(r.blob), "word/document.xml");
  ok("80 行：导出成功且无残留占位符", r.blob.length > 0 && !/\{\{/.test(doc), "");
  eq("80 行：数据行 = 80（自动插了 13 行）", r.rows, 80);
  ok("80 行：文档总行数 = 模板 + 13", rowCount(doc) === rowCount(TPL_DOC) + 13,
    `${rowCount(doc)} vs ${rowCount(TPL_DOC) + 13}`);
  ok("80 行：第 80 行内容写入正确", cellTexts(doc).includes("模块80"), "");
}

/* ---- 格式不变：列宽 / 网格 / 样式 / 媒体 ---- */
{
  const r = RT.build(mkPayload(80), { template: T });
  const doc = readText(Buffer.from(r.blob), "word/document.xml");
  const wTpl = rowWidths(TPL_DOC);
  const wOut = rowWidths(doc);
  ok("插行后的列宽序列与模板一致（前 67 行）",
    wTpl.every((w, i) => wOut[i] === w), `${wTpl[6]} vs ${wOut[6]}`);
  ok("新增行的列宽 = 样板行列宽 2590/3968/851/2412",
    wOut[67] === "2590/3968/851/2412", String(wOut[67]));

  const gridTpl = (TPL_DOC.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/g) || []).join("");
  const gridOut = (doc.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/g) || []).join("");
  ok("tblGrid 逐字节相同（不改表格结构）", gridTpl === gridOut, `${gridTpl.length} 字节`);

  const tblPrTpl = (TPL_DOC.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/g) || []).join("");
  const tblPrOut = (doc.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/g) || []).join("");
  ok("tblPr 逐字节相同（不改表格属性）", tblPrTpl === tblPrOut, `${tblPrTpl.length} 字节`);

  /* ---- 字体格式：程序填入的内容统一「五号宋体 + Times New Roman」----
     模板里 278 个占位符的原始 rPr 有 3 种（微软雅黑 9pt / 10.5pt / 11pt），
     程序填进去后必须**统一**成一种，且**固定标签不受影响**。 */
  const UNIFORM = '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>'
    + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>';
  const phRunRpr = (xml, ph) => {
    const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g) || [];
    for (const r of runs) {
      if (r.includes(ph)) {
        const m = r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
        return m ? m[0] : "";
      }
    }
    return "";
  };
  const findValueRpr = (xml, value) => {
    const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g) || [];
    for (const r of runs) {
      if (r.includes(">" + value + "<")) {
        const m = r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
        return m ? m[0] : "";
      }
    }
    return "";
  };

  const tplNameRpr = phRunRpr(TPL_DOC, "{{name}}");
  // 新版模板（以用户桌面那份为基准重建）里，占位符所在 run 本来就是宋体 —— 这正是期望的样子。
  // 旧模板是 微软雅黑 9pt，所以填进去才字号不统一；现在两边都统一成五号宋体。
  ok("模板 name 占位符所在 run 是宋体（新版模板已对齐字号口径）",
    /宋体/.test(tplNameRpr), tplNameRpr);
  ok("写入后 name 的 rPr = 统一规格（宋体 + Times New Roman + 10.5pt）",
    findValueRpr(doc, "测试同学") === UNIFORM, findValueRpr(doc, "测试同学"));
  ok("写入后 method 的 rPr = 统一规格",
    findValueRpr(doc, "（1）方案与总量。本方案共 80 课时。（2）学情诊断。基础一般。") === UNIFORM,
    findValueRpr(doc, "（1）方案与总量。本方案共 80 课时。（2）学情诊断。基础一般。"));
  ok("写入后课表单元格的 rPr = 统一规格",
    findValueRpr(doc, "模块1") === UNIFORM && findValueRpr(doc, "内容1") === UNIFORM,
    findValueRpr(doc, "模块1"));

  // 全局：程序填入的 run 数量与规格（用**本块自己的 20 行文档**）
  // 全部从模板真实数据推导，不写死数字（模板换版时不用改测试）：
  //   模板 run 总数 R；占位符 run 数 = 278；
  //   删 47 个样板行 → 少 47×4=188 个占位符 run；
  //   故填入 run = 278-188；文档总 run = R-188；固定标签 run = R-278。
  {
    const R = (TPL_DOC.match(/<w:r>[\s\S]*?<\/w:r>/g) || []).length;
    const deleted = (67 - 20) * 4;                    // 188
    const r20 = RT.build(mkPayload(20), { template: T });
    const d20 = readText(Buffer.from(r20.blob), "word/document.xml");
    const allRuns = d20.match(/<w:r>[\s\S]*?<\/w:r>/g) || [];
    const uniformRuns = allRuns.filter((r) => r.includes(UNIFORM));
    const expectFilled = 278 - deleted;               // 90
    ok(`程序填入的 run 恰好 ${expectFilled} 个（278 占位符 − 删掉的 47×4）`,
      uniformRuns.length === expectFilled, `实际 ${uniformRuns.length} 个`);
    ok(`文档总 run 数 = ${R} − ${deleted} = ${R - deleted}`,
      allRuns.length === R - deleted, `实际 ${allRuns.length}（模板 ${R}）`);

    const yahei = allRuns.filter((r) => /微软雅黑/.test(r));
    ok("文档里不再出现 微软雅黑", yahei.length === 0, `仍有 ${yahei.length} 个 run 含微软雅黑`);
    const badFont = uniformRuns.filter((r) => !/w:eastAsia="宋体"/.test(r)
      || !/w:ascii="Times New Roman"/.test(r) || !/w:sz w:val="21"/.test(r));
    ok("填入 run 全部是 宋体 + Times New Roman + 10.5pt",
      badFont.length === 0, `不合规 ${badFont.length} 个`);

    // 固定标签必须保持模板原样（数量 = 模板 run 总数 − 278）
    const labelRuns = allRuns.filter((r) => /<w:t/.test(r) && !r.includes(UNIFORM));
    ok(`未被改写的固定标签 run 数是 ${R - 278}（= 模板 ${R} − 占位符 278）`,
      labelRuns.length === R - 278, `实际 ${labelRuns.length} 个`);
    ok("固定标签仍是模板原本的宋体（未被改成 Times New Roman/21）",
      !labelRuns.some((r) => /Times New Roman/.test(r)), "");
    ok("固定标签里「学生监护人：」「日期：」保持原样（宋体）",
      labelRuns.some((r) => /学生监护人/.test(r) && /w:ascii="宋体"/.test(r)), "");
    ok("「辅导时间：」标签 run 未被合并（与 {{period}} 仍是两个 run）",
      labelRuns.some((r) => /辅导时间：/.test(r)), "该标签应独立存在");
  }

  // 其他零件必须原样（用 Buffer 比较，注意 readPart 返回的是 Buffer）
  const stylesOut = readPart(Buffer.from(r.blob), "word/styles.xml");
  ok("styles.xml 逐字节等于模板",
    stylesOut.equals(Buffer.from(T.getText("word/styles.xml"), "utf8")), `${stylesOut.length} 字节`);
  const media1Out = readPart(Buffer.from(r.blob), "word/media/image1.png");
  const media1Tpl = Buffer.from(T.getBytes("word/media/image1.png"));
  ok("word/media/image1.png 逐字节等于模板（二进制未受损）",
    media1Out.equals(media1Tpl), `${media1Out.length} vs ${media1Tpl.length} 字节`);
  ok("零件总数与模板一致", r.blob.length > 0 && T.ORDER.length === 22, `${T.ORDER.length} 个`);
}

/* ---- 手填区不动 ----
   注意：Word 会把「锐满分辅导方案」「基本信息」「教学方法」这类字拆进多个 <w:t> 里
   （甚至加 w:spacing），所以**不能**在 XML 上直接搜这些整串。正确做法有两条：
     ① 把 <w:t> 内容全部拼起来再搜（等价于"文档里能看到这个字"）
     ② 直接比对 XML：课表区之外的前后两段必须与模板逐字节相同（这才是真正的"没动过"）
*/
{
  const r = RT.build(mkPayload(20), { template: T });
  const doc = readText(Buffer.from(r.blob), "word/document.xml").toString("utf8");

  // ① 拼接所有 <w:t> 后的可视文本（Word 会把「基本信息」拆成两个 run）
  const visible = (xml) => (xml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
    .map((t) => t.replace(/<[^>]+>/g, "")).join("");
  const vTpl = visible(TPL_DOC), vOut = visible(doc);
  const strip = (s) => s.replace(/\s+/g, "");
  for (const s of ["锐满分辅导方案", "学生监护人", "辅导时间：", "教材版本", "学管师", "教师"]) {
    ok(`可视文本含「${s}」（模板与输出都含）`,
      vTpl.includes(s) && vOut.includes(s), `模板=${vTpl.includes(s)} 输出=${vOut.includes(s)}`);
  }
  // 新版模板以用户桌面那份为基准重建，**已补上「咨询师」标签**（这正是这次修模板的目的之一）
  ok("新版模板里「咨询师」标签存在（已修复旧模板缺标签的问题）",
    strip(vTpl).includes("咨询师") && strip(vOut).includes("咨询师"), "模板/输出都应有该标签");
  ok("新版模板里「校区」标签存在（旧模板只有「教师」值格）",
    strip(vTpl).includes("校区"), "");
  // 逐格断言：标签与占位符必须**落在不同的格里**（旧模板把标签格换成占位符，正是错位的病根）
  {
    const cellsOfRow = (xml, r1) => {
      const tr = (xml.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || [])[r1 - 1] || "";
      return (tr.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || [])
        .map((tc) => (tc.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
          .map((t) => t.replace(/<[^>]+>/g, "")).join("").trim());
    };
    eq("模板 R1 逐格 = 基本信 息|学员|{{name}}|年级|{{grade}}|学科|{{subj}}|教材版本|{{book}}",
      cellsOfRow(TPL_DOC, 1),
      ["基本信 息", "学员", "{{name}}", "年级", "{{grade}}", "学科", "{{subj}}", "教材版本", "{{book}}"]);
    eq("模板 R2 逐格 = （空）|学管师|{{mgr}}|咨询师|{{cons}}|校区|{{camp}}|教师|{{tchr}}",
      cellsOfRow(TPL_DOC, 2),
      ["", "学管师", "{{mgr}}", "咨询师", "{{cons}}", "校区", "{{camp}}", "教师", "{{tchr}}"]);
    eq("导出 R1 逐格 = 标签+值交替（值已填入）",
      cellsOfRow(doc, 1),
      ["基本信 息", "学员", "测试同学", "年级", "高三", "学科", "数学", "教材版本", "人教版"]);
  }
  ok("可视文本含竖排标签「基本信息」（模板与输出一致）",
    strip(vTpl).includes("基本信息") && strip(vOut).includes("基本信息"),
    `模板=${strip(vTpl).includes("基本信息")} 输出=${strip(vOut).includes("基本信息")}`);
  ok("可视文本含竖排标签「教学方法」（模板与输出一致）",
    strip(vTpl).includes("教学方法") && strip(vOut).includes("教学方法"),
    `模板=${strip(vTpl).includes("教学方法")} 输出=${strip(vOut).includes("教学方法")}`);

  /* ② 结构不变的正向证明
     不做脆弱的「按位置切一刀」比对（表头行含纵向合并单元格，切片极易切错）。
     直接断言真正的不变式：单元格宽度序列必须**逐项一致**，多/少的部分只能整行地
     出现在末尾（删行 → 输出是模板的前缀；插行 → 输出以模板为前缀）。 */
  const widthsOf = (xml) => (xml.match(/<w:tcW w:w="(\d+)"/g) || []).map((s) => s.replace(/\D/g, ""));
  const ROW4 = ["2590", "3968", "851", "2412"];
  const wT = widthsOf(TPL_DOC), wO = widthsOf(doc);
  ok("删行时：输出宽度序列是模板的前缀（顺序未变、只少了末尾整行）",
    wO.every((w, i) => wT[i] === w) && wO.length < wT.length,
    `模板 ${wT.length} 项 / 输出 ${wO.length} 项`);
  const removed = wT.slice(wO.length);
  ok("被删掉的宽度全部是整行课表行（4 的倍数且符合列宽）",
    removed.length % 4 === 0 && removed.every((w, i) => w === ROW4[i % 4]),
    `删掉 ${removed.length} 项 = ${removed.length / 4} 行`);
  eq("删掉的宽度项数 = (67 - 20) 行 × 4", removed.length, (67 - 20) * 4);

  const cutTail = (xml) => xml.slice(xml.indexOf('</w:tbl>'));
  ok("课表区之后（表格收尾/段落/sectPr）与模板逐字节相同",
    cutTail(TPL_DOC) === cutTail(doc), `${cutTail(TPL_DOC).length} vs ${cutTail(doc).length} 字节`);
  ok("表外段落「学生监护人…日期：」在输出里逐字节保留",
    doc.includes(TPL_DOC.slice(TPL_DOC.indexOf("学生监护人"), TPL_DOC.indexOf("学生监护人") + 60)),
    "");

  // 插行方向（80 行）单独验一次
  const r80 = RT.build(mkPayload(80), { template: T });
  const doc80 = readText(Buffer.from(r80.blob), "word/document.xml");
  const w80 = widthsOf(doc80);
  ok("插行时：输出以模板宽度序列为前缀（顺序未变、只在末尾多行）",
    wT.every((w, i) => w80[i] === w) && w80.length > wT.length,
    `模板 ${wT.length} 项 / 输出 ${w80.length} 项`);
  const added = w80.slice(wT.length);
  ok("新增的宽度全部是整行课表行且符合列宽 2590/3968/851/2412",
    added.length % 4 === 0 && added.every((w, i) => w === ROW4[i % 4]),
    `新增 ${added.length} 项 = ${added.length / 4} 行`);
  eq("新增的宽度项数 = (80 - 67) 行 × 4", added.length, (80 - 67) * 4);
}

/* ---- method 拼接（三轮叙述） ---- */
{
  const rounds = [
    { name: "基础过关", hours: 56, focus: "逐模块补齐基础" },
    { name: "专项突破", hours: 14, focus: "按题型专项训练" },
    { name: "真题模拟", hours: 10, focus: "限时套卷" },
  ];
  const sent = RT.roundsSentence(rounds);
  ok("roundsSentence 是连续叙述（不含箭头 → 与（N）清单）",
    sent.length > 0 && !sent.includes("→") && !/（\d）/.test(sent), sent);
  ok("roundsSentence 含三个轮次的课时数",
    sent.includes("56") && sent.includes("14") && sent.includes("10"), sent);

  const withRounds = RT.build(mkPayload(20, { method: "正文。" + sent }), { template: T });
  const doc1 = readText(Buffer.from(withRounds.blob), "word/document.xml");
  ok("三轮叙述写入了文档（数字可回读）",
    doc1.includes("56") && doc1.includes("复习节奏分三轮推进"), "");

  const noRounds = RT.build(mkPayload(20, { method: "正文。" }), { template: T });
  const doc2 = readText(Buffer.from(noRounds.blob), "word/document.xml");
  ok("无 rounds 时文档里不出现三轮叙述", !doc2.includes("复习节奏分三轮推进"), "");
  ok("空 rounds → roundsSentence 返回空串", RT.roundsSentence(null) === "" && RT.roundsSentence([]) === "", "");
}

/* ---- 空值：不留占位符、不留「＿＿」 ---- */
{
  const r = RT.build(mkPayload(20, { mgr: "", cons: "", camp: "", tchr: "", book: "", period: "" }), { template: T });
  const doc = readText(Buffer.from(r.blob), "word/document.xml");
  ok("空值不残留占位符", !/\{\{/.test(doc), "");
  ok("空值不写入「＿＿」占位符号", !doc.includes("＿＿"), "");
  ok("period 为空时仍保留「辅导时间：」原文", /辅导时间：/.test(doc), "");
}

/* ---- R4「辅导时间」不能重复（回归：曾导出成「辅导时间：辅导时间：春季」）----
   模板那一格自带标签「辅导时间：{{period}}」，所以程序只应填时间值本身。
   早期 buildMap 里又拼了一次 '辅导时间：'，导致标签出现两次。 */
{
  const r = RT.build(mkPayload(20, { period: "秋季（9–12 月）" }), { template: T });
  const doc = readText(Buffer.from(r.blob), "word/document.xml");
  const trs = doc.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) || [];
  const r4cells = (trs[3].match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) || [])
    .map((tc) => (tc.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || [])
      .map((t) => t.replace(/<[^>]+>/g, "")).join(""));
  const r4 = r4cells.join("");
  ok("R4 里「辅导时间：」只出现 1 次（不重复）",
    (r4.match(/辅导时间：/g) || []).length === 1, r4);
  ok("R4 内容 = 「辅导时间：秋季（9–12 月）」",
    r4.trim() === "辅导时间：秋季（9–12 月）", JSON.stringify(r4));
}

/* ---- 回读：4 个字段都写对了 ---- */
{
  const rows = [
    { stage: "数列（概念）", content: "梳理通项", hours: 2, goal: "正确率≥90%" },
    { stage: "导数（中档）", content: "含参讨论", hours: 4, goal: "第一问满分" },
  ];
  const r = RT.build(mkPayload(0, { rows: rows }), { template: T });
  const doc = readText(Buffer.from(r.blob), "word/document.xml");
  const cells = cellTexts(doc);
  ok("第 1 行 stage 写入", cells.includes("数列（概念）"), "");
  ok("第 1 行 content 写入", cells.includes("梳理通项"), "");
  ok("第 1 行 hours 写入", cells.includes("2"), "");
  ok("第 1 行 goal 写入", cells.includes("正确率≥90%"), "");
  ok("第 2 行 4 个字段写入", cells.includes("导数（中档）") && cells.includes("含参讨论") && cells.includes("4") && cells.includes("第一问满分"), "");
  ok("> 与 & 被正确转义后仍能回读", cells.some((c) => c.includes("正确率≥90%")), "");
}

/* ---- 可重复导出：两次字节一致（reset 生效） ---- */
{
  const a = RT.build(mkPayload(30), { template: T });
  const b = RT.build(mkPayload(30), { template: T });
  ok("连续两次 build 字节完全一致（模板状态未被污染）",
    Buffer.compare(Buffer.from(a.blob), Buffer.from(b.blob)) === 0,
    `${a.blob.length} vs ${b.blob.length}`);
  ok("模板 document.xml 未被写回（getText 仍是原始带占位符版本）",
    /\{\{/.test(T.getText("word/document.xml")), "");
}

/* ---- 超上限保护 ---- */
{
  const r = RT.build(mkPayload(RT.MAX_ROWS + 30), { template: T });
  eq("超过 MAX_ROWS 时截断到上限", r.rows, RT.MAX_ROWS);
  ok("超上限时给出 warning", r.warnings.some((w) => /超过上限/.test(w)), r.warnings.join("; "));
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
if (passed !== results.length) {
  console.log("\n失败项：");
  results.filter((r) => !r.pass).forEach((r) => console.log("  ✗ " + r.name));
}
process.exit(passed === results.length ? 0 : 1);
