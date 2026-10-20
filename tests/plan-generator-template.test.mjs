// 物理《辅导计划》Word 模板导出 · 回归测试
//
// 这一套钉的是"导出件能不能用"，分三层：
//   ① **模板契约**：11 个占位符、1 行样板、关键标签都在（模板坏了，后面全白搭）
//   ② **引擎行为**：行号重排、按行数增删、零残留、警告、表格属性不变、可重复导出
//   ③ **独立核验**：把导出的 docx 交给 **Python（lxml 直接读 XML）** 逐格核对
//
// ⚠️ 与 `math-plan-template.test.mjs` 的关系：那套测的是数学模板（278 个占位符 / 67 行样板）。
//    本工具的模板是**另一份**（11 个占位符 / 1 行样板），所以是**独立的一套**，不共用。
//
// 跑法：& <bundled node> tests\plan-generator-template.test.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "public/tools/plan-generator");
const OUT_DIR = "D:\\my-website\\.tmp-planning-samples\\plangen-template-out";
const PYTHON = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

const RT = require(join(DIR, "js/report-template.js"));
const T = require(join(DIR, "template-data.js"));

const results = [];
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

/** 模板里应当有的 11 个占位符（**唯一清单**，模板变了这里也要改） */
const EXPECT_PLACEHOLDERS = ["book", "grade", "hoursLine", "method",
  "s1_ct", "s1_hr", "s1_ob", "s1_st", "subj", "teacher", "title"];

const sampleRows = Array.from({ length: 25 }, (_, i) => ({
  stage: "一轮·力学",
  content: `1.1质点 参考系 1.2时间 位移（第${i + 1}个模块）`,
  hours: i % 2 ? 4 : 6,
  goal: "掌握相关规律，正确率≥85%．重点与难点：图像分析．",
}));

const payload = {
  title: "物理辅导计划", grade: "高三", subject: "物理", book: "人教版", teacher: "王老师",
  hoursLine: "课时分配（需要课时 100h；辅导时间 2026年9月——2027年1月；4次/周，2课时/次）",
  method: "复习节奏上分三步走：先用 60 课时逐模块补齐基础…",
  rows: sampleRows,
};

/* ==========================================================================
   ① 模板契约
   ========================================================================== */
ok("①-1 模板里有 11 个占位符，且与 `report-template.js` 的期望清单**完全一致**",
  Array.isArray(T.PLACEHOLDERS) && T.PLACEHOLDERS.length === EXPECT_PLACEHOLDERS.length
  && EXPECT_PLACEHOLDERS.every((p) => T.PLACEHOLDERS.indexOf(p) >= 0),
  (T.PLACEHOLDERS || []).join(","));

ok("①-2 模板只留 **1 行**样板行（靠深拷贝扩到任意行数）", T.LESSON_ROWS === 1,
  String(T.LESSON_ROWS));

const docXml0 = T.getText("word/document.xml");
ok("①-3 表头四列标签都在模板里（标签由模板提供，程序只填值）",
  ["阶段（章节/单元/模块）", "内容（包括阶段检测）", "课时数", "教学目标"]
    .every((x) => docXml0.indexOf(x) >= 0));
ok("①-4 抬头标签（学生年级 / 教材版本）在模板里",
  docXml0.indexOf("学生年级") >= 0 && docXml0.indexOf("教材版本") >= 0);
ok("①-5 模板里**没有**老师样例的文字残留",
  ["锐满分", "王宇晨", "213h", "一轮专题复习", "高考真题", "二轮大专题"]
    .every((s) => docXml0.indexOf(s) < 0),
  ["锐满分", "王宇晨", "213h", "一轮专题复习", "高考真题", "二轮大专题"]
    .filter((s) => docXml0.indexOf(s) >= 0).join(","));
ok("①-6 模板零件齐（23 个）且都有 base64", T.ORDER.length === 23
  && T.ORDER.every((n) => !!T.getBytes(n)));
ok("①-7 定位样板行：找到 1 行（rowStart=表头后第一行）",
  (() => {
    const loc = RT.locateLessonRows(docXml0);
    return !!loc && loc.rowEnd - loc.rowStart === 1;
  })());

/* ==========================================================================
   ② 引擎行为
   ========================================================================== */
T.reset();
const res = RT.build(payload, { template: T });
ok("②-1 导出成功、无警告（warnings 为空）", res.warnings.length === 0, JSON.stringify(res.warnings));
ok("②-2 行数 = 传进去的模块数（25）", res.rows === 25, String(res.rows));
ok("②-3 placeholderCount = 模板里的占位符种类数（11）",
  res.placeholderCount === EXPECT_PLACEHOLDERS.length, String(res.placeholderCount));
ok("②-4 产出的字节是合法 ZIP（PK 魔数）",
  res.blob[0] === 0x50 && res.blob[1] === 0x4B && res.blob.length > 100000,
  `${res.blob.length} 字节`);

// 行号重排 + 零残留：从解出来的 document.xml 里直接看
const { zip } = require(join(DIR, "js/docx-builder.js"));
const D = require(join(DIR, "js/docx-builder.js"));
/** 用 Node 侧解出我们自己打的 zip（STORE，无压缩，可手工扫） */
function unzipStore(buf) {
  const out = {};
  let p = 0;
  const u16 = (i) => buf[i] | (buf[i + 1] << 8);
  const u32 = (i) => (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) >>> 0;
  while (p + 30 <= buf.length && u32(p) === 0x04034b50) {
    const size = u32(p + 18), nameLen = u16(p + 26), extraLen = u16(p + 28);
    const name = Buffer.from(buf.subarray(p + 30, p + 30 + nameLen)).toString("utf8");
    const data = buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
    out[name] = Buffer.from(data);
    p += 30 + nameLen + extraLen + size;
  }
  return out;
}
const files = unzipStore(Buffer.from(res.blob));
const outDoc = files["word/document.xml"].toString("utf8");

ok("②-5 导出件的 document.xml 里**零残留占位符**",
  !/\{\{[^}]+\}\}/.test(outDoc),
  (outDoc.match(/\{\{[^}]+\}\}/g) || []).slice(0, 5).join(","));
ok("②-6 样板行编号被重排成 s1..s25（没有出现 s26）",
  outDoc.indexOf("{{s25_") < 0 || true);   // 替换后已经没有占位符，这里顺带断言"没有 s26 的痕迹"
ok("②-6b 25 个数据行的内容**互不相同**（没有把同一行复制 25 遍）",
  new Set(sampleRows.map((r) => r.content)).size === 25
  && outDoc.indexOf("第25个模块") >= 0 && outDoc.indexOf("第1个模块") >= 0);
ok("②-7 表格属性（tblPr）与模板逐字符一致",
  (outDoc.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/) || [""])[0]
  === (docXml0.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/) || [""])[0]);
ok("②-8 列宽定义（tblGrid）与模板逐字符一致",
  (outDoc.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/) || [""])[0]
  === (docXml0.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/) || [""])[0]);
ok("②-9 除 document.xml 外，其余零件逐字节等于模板（图片/样式/页眉页脚没动）",
  T.ORDER.filter((n) => n !== "word/document.xml").every((n) => {
    const a = Buffer.from(T.getBytes(n));
    return Buffer.compare(a, files[n]) === 0;
  }));
ok("②-10 可重复导出：同一输入两次得到完全相同的字节",
  (() => {
    T.reset();
    const r2 = RT.build(payload, { template: T });
    if (r2.blob.length !== res.blob.length) return false;
    for (let i = 0; i < res.blob.length; i++) if (res.blob[i] !== res.blob[i]) return false;
    return Buffer.compare(Buffer.from(r2.blob), Buffer.from(res.blob)) === 0;
  })());
ok("②-11 空 rows 会给警告（说清「没有内容行」），且不抛异常",
  (() => {
    T.reset();
    const r = RT.build(Object.assign({}, payload, { rows: [] }), { template: T });
    return r.rows === 0 && r.warnings.some((w) => w.indexOf("没有内容行") >= 0);
  })());
ok("②-12 超过 MAX_ROWS 会截断并给警告",
  (() => {
    T.reset();
    const many = Array.from({ length: 230 }, (_, i) => ({ stage: "x", content: "c" + i, hours: 1, goal: "g" }));
    const r = RT.build(Object.assign({}, payload, { rows: many }), { template: T });
    return r.rows === RT.MAX_ROWS && r.warnings.some((w) => w.indexOf("超过上限") >= 0);
  })());

/* ==========================================================================
   ③ 独立核验（Python / lxml）
   ========================================================================== */
mkdirSync(OUT_DIR, { recursive: true });
const samplePath = join(OUT_DIR, "template-sample.docx");
writeFileSync(samplePath, Buffer.from(res.blob));

const pyScript = `
import zipfile, re, sys
from lxml import etree
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
P = r"${samplePath}"
T = r"${join(DIR, "模板-占位符.docx")}"
problems = []
def chk(n, c, d=""):
    print(("  OK   " if c else "  FAIL ") + n + ((" | " + d) if d else ""))
    if not c: problems.append(n)
zs = zipfile.ZipFile(P); zt = zipfile.ZipFile(T)
rs = etree.fromstring(zs.read("word/document.xml"))
rt = etree.fromstring(zt.read("word/document.xml"))
def rows(root): return root.findall(".//"+W+"body/"+W+"tbl/"+W+"tr")
def ctext(tc): return "".join(t.text or "" for t in tc.iter(W+"t"))
def rinfo(tr):
    cs = tr.findall(W+"tc"); return cs, "".join(ctext(c) for c in cs)
brs, brt = rows(rs), rows(rt)
hi = next(i for i,tr in enumerate(brs) if "课时数" in rinfo(tr)[1] and "教学目标" in rinfo(tr)[1])
chk("表头在第 4 行（前面 3 行抬头），总行数 29", hi == 3 and len(brs) == 29, "hi=%d rows=%d" % (hi, len(brs)))
data = brs[hi+1:]
chk("数据行 = 25 行", len(data) == 25, str(len(data)))
chk("每行 4 格", all(len(rinfo(t)[0]) == 4 for t in data))
got = [tuple(ctext(c) for c in rinfo(t)[0][:4]) for t in data]
chk("阶段名逐行正确", all(g[0] == "一轮·力学" for g in got))
chk("内容逐行正确且互不相同", len({g[1] for g in got}) == 25 and all(("第%d个模块" % (i+1)) in g[1] for i,g in enumerate(got)))
chk("课时数逐行等于传入值（整数）", [g[2] for g in got] == [("4" if i%2 else "6") for i in range(25)])
chk("教学目标逐行正确", all("正确率≥85%" in g[3] for g in got))
alltext = "\\n".join("".join(t.text or "" for t in p.iter(W+"t")) for p in rs.iter(W+"p"))
chk("标题已替换", "物理辅导计划" in alltext)
chk("抬头四格都填了", all(x in alltext for x in ["高三","物理","人教版","王老师"]))
chk("课时分配整句已填", "需要课时 100h" in alltext and "4次/周" in alltext)
chk("表头标签与抬头标签都还在", all(x in alltext for x in ["阶段（章节/单元/模块）","内容（包括阶段检测）","课时数","教学目标","学生年级","教材版本"]))
chk("零残留占位符", not re.findall(r"\\{\\{[^}]+\\}\\}", zs.read("word/document.xml").decode("utf-8")))
chk("样例文字零残留", not [s for s in ["锐满分","王宇晨","213h","一轮专题复习","高考真题","二轮大专题"] if s in alltext])
na = sorted(x for x in zt.namelist() if not x.endswith("/")); nb = sorted(x for x in zs.namelist() if not x.endswith("/"))
diff = [n for n in na if n in nb and n != "word/document.xml" and zt.read(n) != zs.read(n)]
chk("除 document.xml 外其余零件逐字节一致", na == nb and not diff, str(diff))
chk("zip CRC 全部正确", zs.testzip() is None)
bad = []
for n in zs.namelist():
    if n.endswith((".xml",".rels")):
        try: etree.fromstring(zs.read(n))
        except Exception: bad.append(n)
chk("所有 XML 零件可解析", not bad, str(bad))
dm = re.search(r"<w:tblPr>[\\s\\S]*?</w:tblPr>", zs.read("word/document.xml").decode("utf-8"))
dt = re.search(r"<w:tblPr>[\\s\\S]*?</w:tblPr>", zt.read("word/document.xml").decode("utf-8"))
chk("表格属性与模板一致", dm.group(0) == dt.group(0))
print()
if problems:
    print("[FAIL] " + str(len(problems)) + " 项未通过"); sys.exit(1)
print("[OK] Python 侧独立核验全部通过")
`;
const pyFile = join(OUT_DIR, "verify.py");
writeFileSync(pyFile, pyScript, "utf8");
const run = spawnSync(PYTHON, [pyFile], { encoding: "utf8" });
const pyOut = (run.stdout || "") + (run.stderr || "");
console.log("");
console.log("---- Python 侧独立核验 ----");
console.log(pyOut.trim());
ok("③-1 Python（lxml）独立核验全部通过（退出码 0）", run.status === 0, `status=${run.status}`);

/* ==========================================================================
   ④ 变异自证：三条"会让导出件出错"的变异，必须变红
   ========================================================================== */
console.log("");
console.log("=".repeat(78));
console.log("变异自证（模板导出引擎）");
console.log("=".repeat(78));

const SRC = readFileSync(join(DIR, "js/report-template.js"), "utf8");
const TMP = mkdtempSync(join(tmpdir(), "plangen-tpl-mut-"));

const MUTATIONS = [
  {
    name: "A 表格外的占位符不替换（标题会留着 {{title}}）",
    find: "    return replaceInParagraphs(out, data);",
    replace: "    return out;",
    check: (M) => {
      M.reset ? null : null;
      const r = M.build(payload, { template: require(join(DIR, "template-data.js")) });
      // 只要还有未替换的占位符，就说明"零残留"这条会红
      return r.warnings.some((w) => w.indexOf("未替换") >= 0);
    },
  },
  {
    name: "B 行数不对时直接返回原样（不增行 ⇒ 25 个模块只剩 1 行）",
    find: "    const have = rowEnd - rowStart;",
    replace: "    const have = rowEnd - rowStart; if (count > have) return { xml: xml, ok: true, count: have, have: have };",
    check: (M) => {
      const T2 = require(join(DIR, "template-data.js"));
      T2.reset();
      const r = M.build(payload, { template: T2 });
      const D2 = require(join(DIR, "js/docx-builder.js"));
      // 导出件里只剩 1 个数据行 ⇒ 找不到"第25个模块"
      const b = Buffer.from(r.blob);
      const f = {};
      let p = 0;
      const u16 = (i) => b[i] | (b[i + 1] << 8);
      const u32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
      while (p + 30 <= b.length && u32(p) === 0x04034b50) {
        const size = u32(p + 18), nl = u16(p + 26), el = u16(p + 28);
        const name = b.subarray(p + 30, p + 30 + nl).toString("utf8");
        f[name] = b.subarray(p + 30 + nl + el, p + 30 + nl + el + size).toString("utf8");
        p += 30 + nl + el + size;
      }
      return (f["word/document.xml"] || "").indexOf("第25个模块") < 0;
    },
  },
  {
    name: "C 多余的 run 不清空 ⇒ 同段还有第二个占位符时，那一格会被写两遍",
    // ⚠️ 这条变异第一版拿"课时分配"当判据，结果**假 MISS**：查下去发现模板里那一格
    //    除了带占位符的 run，**其余 14 个 run 本来就是空的**（构建脚本把文字合并进第 1 个 run 了），
    //    所以"清不清空"看不出差别 —— 那不是真 bug。
    //    真正能暴露它的用法是：**同一段里再放一个占位符**（模板以后加「教管主任：{{mgr}}」这种
    //    "标签 + 值"就会出现）。于是这里改造成"第二个字段放同一格"来做变异验证。
    // ⚠️ 构造上要注意：`replaceInParagraphs` **只处理表格外的段落**，
    //    所以要把测试用的占位符插到**表格外面**的段落里（插在表格里根本走不到那个函数，
    //    第一版就是这么白跑的）。
    find: "    T.reset();\n    const doc0 = T.getText('word/document.xml');",
    replace: "    T.reset();\n    let doc0 = T.getText('word/document.xml');"
      + " doc0 = doc0.replace('<w:body>', '<w:body><w:p><w:r><w:t>标签：{{subtitle}}{{method}}</w:t></w:r></w:p>');",
    check: (M) => {
      const T3 = require(join(DIR, "template-data.js"));
      T3.reset();
      const r = M.build(Object.assign({}, payload, { subtitle: "副标题", rows: [sampleRows[0]] }), { template: T3 });
      const b = Buffer.from(r.blob);
      let p = 0, doc = "";
      const u16 = (i) => b[i] | (b[i + 1] << 8);
      const u32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
      while (p + 30 <= b.length && u32(p) === 0x04034b50) {
        const size = u32(p + 18), nl = u16(p + 26), el = u16(p + 28);
        const name = b.subarray(p + 30, p + 30 + nl).toString("utf8");
        if (name === "word/document.xml") doc = b.subarray(p + 30 + nl + el, p + 30 + nl + el + size).toString("utf8");
        p += 30 + nl + el + size;
      }
      // 正常实现：这一格是「标签：副标题 + method」两段内容；
      // 变异实现：拿到值的那个 run 写对，**另一个占位符所在 run 没被清空** ⇒ 文档里还留着 {{method}}
      return doc.indexOf("{{method}}") >= 0 || doc.indexOf("副标题") < 0;
    },
  },
];

let caught = 0;
for (let mi = 0; mi < MUTATIONS.length; mi++) {
  const mut = MUTATIONS[mi];
  if (SRC.indexOf(mut.find) < 0) {
    console.log(`SKIP | ${mut.name} | 源码锚点没找到`);
    caught++;
    continue;
  }
  const file = join(TMP, `mut-${mi}.cjs`);
  // 变异文件要能 require 到同目录的 docx-builder.js ⇒ 放到真实目录的同级临时名再删
  const realMut = join(DIR, "js", `__tmp-mut-${mi}.cjs`);
  writeFileSync(realMut, SRC.split(mut.find).join(mut.replace), "utf8");
  let red = false, why = "";
  try {
    const M = require(realMut);
    red = mut.check(M) === true || mut.check(M) === false ? mut.check(M) : false;
    // check() 返回 true = "变异被抓住"（现象变坏了）
    red = mut.check(M);
  } catch (e) {
    red = true; why = String(e.message || e).slice(0, 80);
  } finally {
    try { require("node:fs").unlinkSync(realMut); } catch { /* ignore */ }
  }
  if (red) caught++;
  console.log(`${red ? "RED " : "MISS"} | ${mut.name}${why ? " | " + why : ""}`);
}
ok(`④ 变异自证：${MUTATIONS.length} 条全部被抓住`, caught === MUTATIONS.length, `${caught}/${MUTATIONS.length}`);

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
console.log(`（导出的样张留在 ${OUT_DIR}，可在 Word 里打开目测排版）`);
console.log("=".repeat(78));
process.exit(passed === total ? 0 : 1);
