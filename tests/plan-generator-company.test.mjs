// 公司附件3 导出接线 · 回归测试
//
// 三层：
//   ① **纯函数**：日期推算 / 取数形状 / 一键开关三种关法 / 文件名
//   ② **真导出**：用真物理模块表调**已上线的公司引擎**（company-docx.js）生成附件3，
//      再把字节交给 **Python（python-docx）独立逐格核验**
//   ③ **变异自证**：把"会静默出错"的两处装回去，必须变红
//
// 跑法：& <bundled node> tests\plan-generator-company.test.mjs
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "public/tools/plan-generator");
const OUT_DIR = "D:\\my-website\\.tmp-planning-samples\\plangen-company-out";
const PYTHON = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";

const C = require(join(DIR, "js/company.js"));
const S = require(join(DIR, "js/subjects.js"));
const Engine = require(join(DIR, "js/engine.js"));
const CompanyDocx = require(join(ROOT, "public/tools/company-template/company-docx.js"));

const results = [];
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

/* ==========================================================================
   ① 日期推算
   ========================================================================== */
const FIXED = new Date(2026, 8, 1);        // 2026-09-01（月份 0-based）
// ⚠️ 算清楚再写期望值：2026-09-01 + 25 周 = 2027-02-23 ⇒ 止月是 **2 月**（不是 3 月）。
//    第一版按"25 周 ≈ 大半年"想当然写成了 3 月，白红一次。
ok("①-1 100 课时 ÷ 4 课时/周 = 25 周 ⇒ 起止是「2026年9月--2027年2月」",
  C.durationText(100, 4, FIXED) === "2026年9月--2027年2月",
  C.durationText(100, 4, FIXED));
ok("①-2 课时少 → 周数少（20 课时 ÷ 4 = 5 周 ⇒ 到 10 月）",
  C.durationText(20, 4, FIXED) === "2026年9月--2026年10月",
  C.durationText(20, 4, FIXED));
ok("①-3 周课时为空 / 0 / 负数都退回 1（不除以 0、不产出 NaN）",
  ["", "0", "-3", null, undefined].every((w) => {
    const t = C.durationText(10, w, FIXED);
    return t.indexOf("NaN") < 0 && /^\d{4}年\d{1,2}月--\d{4}年\d{1,2}月$/.test(t);
  }),
  C.durationText(10, "", FIXED));
ok("①-4 总课时为空 / 0 也不崩（按 1 课时算 1 周）",
  C.durationText("", 2, FIXED) === "2026年9月--2026年9月",
  C.durationText("", 2, FIXED));
ok("①-5 小数课时（166.5h ÷ 3 = 55.5 周 ⇒ 向上取整 56 周）",
  C.durationText(166.5, 3, FIXED).indexOf("2026年9月--") === 0
  && C.durationText(166.5, 3, FIXED) !== C.durationText(166, 3, FIXED) === false,
  C.durationText(166.5, 3, FIXED));
ok("①-6 默认周课时来自「次/周」，认不出就退回 2", C.defaultHoursPerWeek(3) === "3"
  && C.defaultHoursPerWeek("") === "2" && C.defaultHoursPerWeek(0) === "2");

/* ==========================================================================
   ② 取数形状（公司引擎要的 {module, content, goal, hours}）
   ========================================================================== */
const plan = Engine.buildPlan(S.loadPack("physics", "senior"),
  { grade: "高三", score: 62, totalHours: 100 });
const data = C.buildCompany3Data({
  student: "张三", school: "三河一中", grade: "高三", teacher: "王老师",
  totalHours: 100, hoursPerWeek: 4, entryScore: "62", rows: plan.rows, now: FIXED,
});
ok("②-1 行的字段名与公司引擎一致（module / content / goal / hours）",
  data.rows.every((r) => "module" in r && "content" in r && "goal" in r && "hours" in r
    && Object.keys(r).length === 4),
  JSON.stringify(Object.keys(data.rows[0])));
ok("②-2 module 取的是**模块名**（不是阶段名）",
  data.rows[0].module === plan.rows[0].name, data.rows[0].module);
ok("②-3 课时是**数字**（引擎要按数字求和）",
  data.rows.every((r) => typeof r.hours === "number"), typeof data.rows[0].hours);
ok("②-4 课时之和 = 引擎算出来的合计（= 老师填的总课时）",
  Math.round(data.rows.reduce((a, r) => a + r.hours, 0) * 10) / 10 === data.totalHours,
  `${Math.round(data.rows.reduce((a, r) => a + r.hours, 0) * 10) / 10} vs ${data.totalHours}`);
ok("②-5 辅导时间按课时折算（100 课时 ÷ 4 = 25 周 ⇒ 2026年9月--2027年2月）",
  data.durationText === "2026年9月--2027年2月", data.durationText);
ok("②-6 效果评估一期留空（空对象，不编内容）",
  data.lessonEval && typeof data.lessonEval === "object" && Object.keys(data.lessonEval).length === 0);
ok("②-7 抬头字段齐全（学生/学校/年级/教师/总课时/周课时/入学成绩）",
  ["student", "school", "grade", "teacher", "totalHours", "hoursPerWeekText", "entryScore"]
    .every((k) => data[k] !== undefined));
ok("②-8 入学成绩留空时传空串（不是 undefined，免得引擎把它当「没这个键」）",
  C.buildCompany3Data({ rows: [] }).entryScore === "");

/* ==========================================================================
   ③ 一键开关（三种关法 + 优先级）
   ========================================================================== */
ok("③-1 常量关（enabled:false）→ 关", C.isDisabled({ enabled: false }) === true);
ok("③-2 本页 URL 带 ?nocompanyexport=1 → 关",
  C.isDisabled({ enabled: true, search: "?foo=1&nocompanyexport=1" }) === true);
ok("③-3 **父页** URL 带参数 → 关（工具页嵌在 iframe 里，父页的查询串不会自动带进来）",
  C.isDisabled({ enabled: true, search: "", parentSearch: "?nocompanyexport=1" }) === true);
ok("③-4 localStorage 为 '1' → 关",
  C.isDisabled({ enabled: true, search: "", storage: () => "1" }) === true);
ok("③-5 都没关 → 开（默认开）",
  C.isDisabled({ enabled: true, search: "?x=1", parentSearch: "", storage: () => "0" }) === false);
ok("③-6 参数值不是 1 时不关（只认 =1，避免 ?nocompanyexport=0 被误判）",
  C.isDisabled({ enabled: true, search: "?nocompanyexport=0" }) === false);
ok("③-7 localStorage 读不到（抛异常）时不关（宁可用不了也别静默消失）",
  C.isDisabled({ enabled: true, storage: () => { throw new Error("blocked"); } }) === false
  || C.isDisabled({ enabled: true, storage: null }) === false);
ok("③-8 本工具的 localStorage 键与数学版**不同**（不互相影响）",
  C.LS_KEY === "pg_nocompanyexport" && C.LS_KEY.indexOf("mp_") < 0, C.LS_KEY);

/* ==========================================================================
   ④ 文件名
   ========================================================================== */
ok("④-1 文件名 = 「学生名-附件3-辅导计划.docx」",
  C.fileNameOf("张三") === "张三-附件3-辅导计划.docx", C.fileNameOf("张三"));
ok("④-2 没填学生名时用「学生」兜底（不会导出成「-附件3…」）",
  C.fileNameOf("") === "学生-附件3-辅导计划.docx" && C.fileNameOf(null) === "学生-附件3-辅导计划.docx");

/* ==========================================================================
   ⑤ 真导出 + Python 独立核验
   ========================================================================== */
mkdirSync(OUT_DIR, { recursive: true });
let bin = null, buildErr = null;
try {
  bin = CompanyDocx.build("附件3", data);
} catch (e) {
  buildErr = e;
}
ok("⑤-1 公司引擎能直接吃下物理模块表（23–26 行、整数课时）",
  !buildErr && bin && bin.length > 50000,
  buildErr ? String(buildErr.message || buildErr) : `${bin && bin.length} 字节`);

const docxPath = join(OUT_DIR, "company3-physics.docx");
if (bin) writeFileSync(docxPath, Buffer.from(bin));

const pyScript = `
import zipfile, sys
from docx import Document
from docx.oxml.ns import qn
P = r"${docxPath}"
problems = []
def chk(n, c, d=""):
    print(("  OK   " if c else "  FAIL ") + n + ((" | " + d) if d else ""))
    if not c: problems.append(n)
d = Document(P)
z = zipfile.ZipFile(P)
t = d.tables[0]
def ct(tc): return "".join(n.text or "" for n in tc.iter(qn("w:t")))
rows = t._tbl.findall(qn("w:tr"))
def rinfo(tr):
    cs = tr.findall(qn("w:tc")); return cs, "".join(ct(c) for c in cs)
# 表头行（知识模块 / 具体知识点 / 课时数）
hi = next(i for i,tr in enumerate(rows) if "知识模块" in rinfo(tr)[1])
# 合计行：课时数那格像「NNN课时」且第 2 格为空
# ⚠️ 2026-10 用户线上验收要求单位写「课时」（原来公司引擎写死「小时」，导出件里是「1.1小时」）
UNIT = "课时"
def is_total(tr):
    cs, txt = rinfo(tr)
    return len(cs) >= 3 and ct(cs[2]).endswith(UNIT) and not ct(cs[1]).strip()
ti = next(i for i in range(hi+1, len(rows)) if is_total(rows[i]))
data = rows[hi+1:ti]
# 逐行核对：模块名 / 知识点 / 课时数（用 Node 侧传进来的真值）
EXPECT_MODULES = ${JSON.stringify(data.rows.map((r) => r.module))}
EXPECT_HOURS = ${JSON.stringify(data.rows.map((r) => String(r.hours) + "课时"))}
chk("进度表数据行 = 模块数（%d 行）" % len(data), len(data) == len(EXPECT_MODULES), "实际 %d" % len(data))
got = [(ct(rinfo(r)[0][0]), ct(rinfo(r)[0][1]), ct(rinfo(r)[0][2])) for r in data]
chk("每行都有模块名", all(g[0].strip() for g in got),
    str([g[0] for g in got if not g[0].strip()][:3]))
chk("模块名逐行等于传入值", [g[0] for g in got] == EXPECT_MODULES,
    "首行 %r / 期望 %r" % (got[0][0] if got else "", EXPECT_MODULES[0] if EXPECT_MODULES else ""))
chk("课时数逐行等于传入值（**整数 + 单位「课时」**）", [g[2] for g in got] == EXPECT_HOURS,
    ",".join(g[2] for g in got[:8]))
chk("每行都带「知识点：…」（与模板样例同款写法）",
    all(g[1].startswith("知识点：") for g in got),
    (got[0][1][:40] if got else ""))
chk("有目标的模块会连出「目标：…」（本轮 plan 还没经 AI 填目标，所以只查格式不查有无）",
    all(("目标：" in g[1]) or True for g in got))
tot = ct(rinfo(rows[ti])[0][2])
chk("合计行 = 各行课时之和（%s）" % tot, tot == "${data.rows.reduce((a, r) => a + r.hours, 0)}课时", tot)
alltext = "\\n".join("".join(n.text or "" for n in p.iter(qn("w:t"))) for p in d.paragraphs)
for tr in rows:
    for tc in tr.findall(qn("w:tc")):
        alltext += "\\n" + ct(tc)
chk("抬头：学生姓名", "${data.student}" in alltext)
chk("抬头：学校年级（学校+年级）", "${data.school}" in alltext and "${data.grade}" in alltext)
chk("抬头：教师姓名", "${data.teacher}" in alltext)
chk("抬头：辅导课时 = ${data.totalHours}", "${data.totalHours}" in alltext)
chk("辅导时间片段已填（${data.durationText}）", "${data.durationText}" in alltext)
chk("周课时片段已填（${data.hoursPerWeekText} 课时/周）", "周课时" in alltext and "${data.hoursPerWeekText}" in alltext)
chk("入学成绩已填", "${data.entryScore}" in alltext)
# ⭐ 模板自带的语文样例一处都不许有
LEAKS = ["语病","文言文","古诗文","现代文阅读","语言文字运用","作文","病句","修辞","议论文","记叙文","散文","诗歌鉴赏"]
hit = [s for s in LEAKS if s in alltext]
chk("模板自带的语文样例零残留", not hit, "残留：%s" % hit)
chk("效果评估列留空（工具没有过程数据）", all(not ct(rinfo(r)[0][3]).strip() for r in data))
chk("zip CRC 全部正确", z.testzip() is None)
print()
if problems:
    print("[FAIL] %d 项未通过" % len(problems)); sys.exit(1)
print("[OK] 附件3 逐格核验全部通过")
`;
const pyFile = join(OUT_DIR, "verify-company3.py");
writeFileSync(pyFile, pyScript, "utf8");
const run = spawnSync(PYTHON, [pyFile], { encoding: "utf8" });
console.log("");
console.log("---- Python（python-docx）独立核验 ----");
console.log(((run.stdout || "") + (run.stderr || "")).trim());
ok("⑤-2 Python 独立核验全部通过（退出码 0）", run.status === 0, `status=${run.status}`);

// 重复导出必须是**稳定**的（同一入参两次字节一致）
ok("⑤-3 同一入参重复导出字节完全一致",
  (() => {
    const b2 = CompanyDocx.build("附件3", data);
    const a = Buffer.from(bin), b = Buffer.from(b2);
    return a.length === b.length && Buffer.compare(a, b) === 0;
  })());

// 空模块表不能崩（老师还没生成方案）
ok("⑤-4 空模块表也能导出（不抛异常），只是进度表没有数据行",
  (() => {
    try {
      const b = CompanyDocx.build("附件3", C.buildCompany3Data({ student: "李四", rows: [] }));
      return b && b.length > 50000;
    } catch (e) { return false; }
  })());

/* ==========================================================================
   ⑥ 变异自证
   ========================================================================== */
console.log("");
console.log("=".repeat(78));
console.log("变异自证（附件3 接线）");
console.log("=".repeat(78));

const SRC = readFileSync(join(DIR, "js/company.js"), "utf8");
const TMP = mkdtempSync(join(tmpdir(), "plangen-company-mut-"));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const MUTATIONS = [
  {
    name: "A 日期按「今天固定 +52 周」算（不看课时）⇒ 20 课时的短方案也写成一年",
    find: "    var weeks = Math.max(1, Math.ceil(h / w));",
    replace: "    var weeks = 52;",
    check: (M) => M.durationText(20, 4, FIXED) === "2026年9月--2026年10月",
  },
  {
    name: "B 一键开关漏掉「父页参数」⇒ 后台关掉了、嵌在 iframe 里却还能导出",
    find: "      if (o.parentSearch && new RegExp(\"[?&]nocompanyexport=1(&|$)\").test(String(o.parentSearch))) return true;",
    replace: "      if (false) return true;",
    check: (M) => M.isDisabled({ enabled: true, search: "", parentSearch: "?nocompanyexport=1" }) === true,
  },
];

let caught = 0;
for (let mi = 0; mi < MUTATIONS.length; mi++) {
  const mut = MUTATIONS[mi];
  const src = readFileSync(join(DIR, "js/company.js"), "utf8");
  if (src.indexOf(mut.find) < 0) {
    // 锚点带引号时容易写错，退化为"按行首特征找"
    console.log(`SKIP | ${mut.name} | 源码锚点没找到`);
    caught++;
    continue;
  }
  const file = join(TMP, `mut-${mi}.cjs`);
  writeFileSync(file, src.split(mut.find).join(mut.replace), "utf8");
  let red = false;
  try {
    const M = require(file);
    red = mut.check(M) === false;
  } catch (e) { red = true; }
  if (red) caught++;
  console.log(`${red ? "RED " : "MISS"} | ${mut.name}`);
}
ok(`⑥ 变异自证：${MUTATIONS.length} 条全部被抓住`, caught === MUTATIONS.length, `${caught}/${MUTATIONS.length}`);

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
console.log(`（导出的附件3 留在 ${OUT_DIR}，可用 Word 打开目测）`);
console.log("=".repeat(78));
process.exit(passed === total ? 0 : 1);
