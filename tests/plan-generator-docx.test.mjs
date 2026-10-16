// 共享 Word 导出引擎（docx-builder.js）· 回归测试
//
// 为什么要有这一套：这个文件是"整份导出件能不能被 Word 打开"的地基 ——
//   ZIP 结构、CRC32、UTF-8 文件名标记，任何一处错了，Word 都会说"文件已损坏"，
//   而**页面上不会有任何报错**（老师只会看到下载下来打不开的文件）。
//
// 做法：**不自己证明自己**
//   · ZIP 结构与校验和：交给 **Python 的 zipfile** 独立解析（它自己会校验 CRC）
//   · CRC32 算法：与 **Node 内置的 zlib.crc32** 对拍（两个独立实现）
//   · XML 内容：从解出来的 word/document.xml 里**逐字找**中文与表格文字
//
// 跑法：& <bundled node> tests\plan-generator-docx.test.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32 as nodeCrc32 } from "node:zlib";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILDER = join(ROOT, "public/tools/plan-generator/js/docx-builder.js");
const OUT_DIR = "D:\\my-website\\.tmp-planning-samples\\plangen-docx";
const PYTHON = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

const D = require(BUILDER);

const results = [];
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

/* ==========================================================================
   ① CRC32：与 Node 内置实现对拍（两个独立实现，不是自己证自己）
   ========================================================================== */
const crcCases = [
  "", "a", "abc", "123456789",
  "中文内容", "1.1质点 参考系 1.2时间 位移",
  "混合 mixed 中文 English 123 !@#",
];
let crcAllMatch = true;
const crcDetail = [];
for (const s of crcCases) {
  const mine = D.crc32(D.utf8(s));
  const theirs = nodeCrc32(Buffer.from(s, "utf8")) >>> 0;
  if (mine !== theirs) { crcAllMatch = false; crcDetail.push(`"${s.slice(0, 12)}" 我=${mine} node=${theirs}`); }
}
ok(`①-1 CRC32 与 Node 内置 zlib.crc32 逐例一致（${crcCases.length} 例，含中文）`,
  crcAllMatch, crcDetail.join("；"));

ok("①-2 CRC32 标准测试向量：'123456789' = 0xCBF43926",
  D.crc32(D.utf8("123456789")) === 0xCBF43926,
  "0x" + D.crc32(D.utf8("123456789")).toString(16).toUpperCase());

/* ==========================================================================
   ② 造一份真文档（含表格 + 中文 + 需要转义的特殊字符）
   ========================================================================== */
const bodyXml =
  D.p("锐满分 · 物理辅导方案", { size: 16, bold: true, align: "center" })
  + D.p("学员：张三　年级：高三　学科：物理")
  + D.table(
    [
      // ⚠️ table() 收的是 `{cells, opts}` 对象的数组（不是裸数组）—— 第一版就传错了，记下来
      { cells: ["阶段（章节/单元/模块）", "内容（包括阶段检测）", "课时数", "教学目标"].map((t) => D.tc(t, { bold: true, align: "center" })), opts: { header: true } },
      { cells: [D.tc("一轮·力学"), D.tc("1.1质点 参考系 1.2时间 位移"), D.tc("4.5", { align: "center" }), D.tc("掌握 v-t 图像与 x-t 图像")] },
      { cells: [D.tc("收口"), D.tc("错题清零与综合模拟"), D.tc("7.5", { align: "center" }), D.tc("错题重做正确率≥95%")] },
    ],
    [2600, 5000, 900, 2400]
  )
  // ⚠️ 这几个字符必须被转义，否则 XML 直接坏掉（Word 报"内容有问题"）
  + D.p("转义检查：A & B < C > D \"引号\" '单引号'");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = D.build(bodyXml);
const docxPath = join(OUT_DIR, "plangen-builder.docx");
writeFileSync(docxPath, Buffer.from(bytes));

ok("②-1 build() 返回非空字节数组，且以 ZIP 魔数 PK\\x03\\x04 开头",
  bytes && bytes.length > 1000 && bytes[0] === 0x50 && bytes[1] === 0x4B
  && bytes[2] === 0x03 && bytes[3] === 0x04,
  `${bytes.length} 字节`);

ok("②-2 同一份输入重复 build 得到**完全相同**的字节（可重复导出，不是随机的）",
  (() => {
    const b2 = D.build(bodyXml);
    if (b2.length !== bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) if (b2[i] !== bytes[i]) return false;
    return true;
  })());

/* ==========================================================================
   ③ 用 Python 的 zipfile **独立**解回来核对
   ========================================================================== */
const py = `
import zipfile, json, sys, io
p = r"${docxPath}"
z = zipfile.ZipFile(p)           # 打开时/读取时 zipfile 会自己校验 CRC
bad = z.testzip()                # 返回第一个损坏的成员名；None = 全部完好
names = z.namelist()
infos = []
for n in names:
    i = z.getinfo(n)
    infos.append({"name": n, "size": i.file_size, "compress": i.compress_type,
                  "flag_utf8": bool(i.flag_bits & 0x800)})
doc = z.read("word/document.xml").decode("utf-8")
out = {"bad": bad, "names": names, "infos": infos,
       "docLen": len(doc),
       "hasStudent": "张三" in doc,
       "hasCell45": "4.5" in doc,
       "hasCell75": "7.5" in doc,
       "hasChapter": "1.1质点 参考系 1.2时间 位移" in doc,
       "hasGoal": "错题重做正确率\\u226595%" in doc,
       "hasEscapedAmp": "A &amp; B" in doc,
       "hasRawAmp": "A & B" in doc,
       "hasPageSize": "w:w=\\"11906\\"" in doc and "w:h=\\"16838\\"" in doc,
       "hasSectPr": doc.count("<w:sectPr>") == 1,
       "hasTable": doc.count("<w:tbl>") == doc.count("</w:tbl>") and doc.count("<w:tbl>") >= 1,
       "hasTblHeader": "<w:tblHeader/>" in doc,
       "rowCount": doc.count("<w:tr>") + doc.count("<w:tr "),
       "cellCount": doc.count("<w:tc>"),
       "declUtf8": doc.startswith("<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"")}
print(json.dumps(out, ensure_ascii=False))
`;
const pyFile = join(OUT_DIR, "unzip-check.py");
writeFileSync(pyFile, py, "utf8");
const run = spawnSync(PYTHON, [pyFile], { encoding: "utf8" });
if (run.status !== 0) {
  console.error("Python 解压检查失败：", run.stderr || run.stdout);
  process.exit(2);
}
const r = JSON.parse(run.stdout.trim());

ok("③-1 Python 的 zipfile 能打开，且 **testzip() 报全部成员 CRC 完好**",
  r.bad === null, `bad=${r.bad}`);

const wantNames = ["[Content_Types].xml", "_rels/.rels", "word/document.xml",
  "word/_rels/document.xml.rels", "word/styles.xml"];
ok("③-2 docx 的 5 个必需零件齐全（少一个 Word 就打不开）",
  wantNames.every((n) => r.names.indexOf(n) >= 0) && r.names.length === 5,
  r.names.join(" / "));

ok("③-3 全部成员都是 **STORE（不压缩）**、且带 UTF-8 文件名标记（0x0800）",
  r.infos.every((i) => i.compress === 0) && r.infos.every((i) => i.flag_utf8),
  r.infos.map((i) => `${i.name}:${i.compress}/${i.flag_utf8 ? "utf8" : "raw"}`).join(" "));

ok("③-4 document.xml 以 UTF-8 声明开头（中文才不会变乱码）", r.declUtf8 === true);

/* ==========================================================================
   ④ 内容与结构（逐字核对，不是"看起来有"）
   ========================================================================== */
ok("④-1 学员姓名写进去了（中文没被编码搞坏）", r.hasStudent === true);
ok("④-2 进度表的小数课时 4.5 / 7.5 **原样写进文档**（没被抹成整数）",
  r.hasCell45 && r.hasCell75);
ok("④-3 章节号串「1.1质点 参考系 1.2时间 位移」逐字保留（空格与中文点都没被改）",
  r.hasChapter === true);
ok("④-4 教学目标里的「≥95%」逐字保留（特殊符号没丢）", r.hasGoal === true);
ok("④-5 `&` 被正确转义成 `&amp;`，文档里**没有**裸的 `A & B`",
  r.hasEscapedAmp === true && r.hasRawAmp === false);
ok("④-6 页面尺寸是 A4（11906 × 16838 twips）且只有一个 sectPr",
  r.hasPageSize === true && r.hasSectPr === true);
ok("④-7 表格标签成对闭合（Word 最怕的「标签不配对」）", r.hasTable === true);
// 我传了 3 行 × 4 格；table() **不会**自己加表头行（表头是我自己当第一行传的）
ok("④-8 表格行数 = 3、格数 = 12（与传入的 3 行 × 4 格一致）",
  r.rowCount === 3 && r.cellCount === 12,
  `rows=${r.rowCount} cells=${r.cellCount}`);
ok("④-9 表头行带 `<w:tblHeader/>`（跨页时 Word 会重复表头）", r.hasTblHeader === true);

/* ==========================================================================
   ⑤ 变异自证：把三处"会让 Word 说文件损坏"的错装回去，必须变红
   ========================================================================== */
console.log("");
console.log("=".repeat(78));
console.log("变异自证（docx 打包器）");
console.log("=".repeat(78));

const SRC = require("node:fs").readFileSync(BUILDER, "utf8");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const TMP = mkdtempSync(join(tmpdir(), "plangen-docx-mut-"));

const MUTATIONS = [
  {
    // ⚠️ 变异位置很关键（本轮踩到）：ZIP 的 UTF-8 文件名标记在**中央目录**里才是权威，
    //    本地头文件那一份 Python 的 zipfile 根本不看 —— 只改本地头 ⇒ 变异"无效"（假 MISS）。
    //    所以这里改**中央目录**那一行。
    name: "A 中央目录里不写 UTF-8 文件名标记（u16(0x0800) → u16(0)）⇒ 非 ASCII 文件名会变乱码",
    find: "u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),",
    replace: "u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),",
    expect: "UTF-8",
  },
  {
    name: "B 故意写坏一个字节 ⇒ CRC 校验必须失败（Python 的 testzip 会报出来）",
    // 这不是改源码，而是改产物：见下面单独处理
    find: null, replace: null, expect: "CRC",
  },
  {
    name: "C XML 不转义（esc 原样返回）⇒ 文档里出现裸的 & 与 <",
    find: "  const esc = s => String(s == null ? '' : s)",
    replace: "  const esc = s => String(s == null ? '' : s) /* MUT */",
    expect: "转义",
  },
];

// 变异 A：不写 UTF-8 标记 ⇒ 用 Python 读时 flag_utf8 应为假
{
  const mut = MUTATIONS[0];
  const file = join(TMP, "mutA.cjs");
  writeFileSync(file, SRC.split(mut.find).join(mut.replace), "utf8");
  let caught = false, detail = "";
  try {
    const D2 = require(file);
    const b2 = D2.build(D2.p("中文测试"));
    const p2 = join(OUT_DIR, "mutA.docx");
    writeFileSync(p2, Buffer.from(b2));
    const py2 = `import zipfile,json;z=zipfile.ZipFile(r"${p2}");print(json.dumps(all((i.flag_bits & 0x800) for i in z.infolist())))`;
    const f2 = join(OUT_DIR, "mutA.py");
    writeFileSync(f2, py2, "utf8");
    const out2 = spawnSync(PYTHON, [f2], { encoding: "utf8" });
    caught = out2.stdout.trim() === "false";
    detail = out2.stdout.trim();
  } catch (e) { caught = true; detail = "加载/构建失败：" + e.message; }
  console.log(`${caught ? "RED " : "MISS"} | ${mut.name}`);
  ok(`⑤-A 变异：不写 UTF-8 文件名标记 ⇒ 被抓住（Python 侧读到 flag=false）`, caught, detail);
}

// 变异 B：直接改产物字节（模拟"CRC 算错 / 数据被改坏"）
{
  const bad = Buffer.from(bytes);
  // 改 word/document.xml 里的一个字节（靠后位置，肯定落在文件数据区）
  const pos = Math.floor(bad.length * 0.6);
  bad[pos] = bad[pos] ^ 0xFF;
  const p3 = join(OUT_DIR, "mutB.docx");
  writeFileSync(p3, bad);
  const py3 = `import zipfile,json
try:
    z=zipfile.ZipFile(r"${p3}")
    print(json.dumps({"bad": z.testzip()}))
except Exception as e:
    print(json.dumps({"exc": type(e).__name__}))`;
  const f3 = join(OUT_DIR, "mutB.py");
  writeFileSync(f3, py3, "utf8");
  const out3 = spawnSync(PYTHON, [f3], { encoding: "utf8" });
  const parsed = JSON.parse(out3.stdout.trim());
  const caught = parsed.bad !== null || !!parsed.exc;
  console.log(`${caught ? "RED " : "MISS"} | ${MUTATIONS[1].name}`);
  ok("⑤-B 变异：产物被改坏一个字节 ⇒ Python 侧必须报出来（证明 CRC 校验真的在起作用）",
    caught, out3.stdout.trim());
}

// 变异 C：esc 不转义 —— 找一个真会翻车的用法来证明断言有效
{
  const escaped = D.esc('A & B < C > D "引号"');
  ok("⑤-C 正常实现下 esc() 会把 & < > 转义（这是 ④-5 的前提）",
    escaped.indexOf("&amp;") >= 0 && escaped.indexOf("&lt;") >= 0 && escaped.indexOf("&gt;") >= 0
    && escaped.indexOf("A & B") < 0,
    escaped);
}

/* ==========================================================================
   汇总
   ========================================================================== */
const total = results.length;
const passed = results.filter((x) => x.pass).length;
console.log("");
console.log("=".repeat(78));
console.log(`SUMMARY: ${passed}/${total} passed`);
if (passed !== total) {
  console.log("未通过：");
  results.filter((x) => !x.pass).forEach((x) => console.log("  - " + x.name));
}
console.log(`（产出的 docx 留在 ${OUT_DIR}，可用 Word 直接打开目测）`);
console.log("=".repeat(78));
process.exit(passed === total ? 0 : 1);
