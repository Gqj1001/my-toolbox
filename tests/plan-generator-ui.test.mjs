// 工具页界面（public/tools/plan-generator/index.html）· 真浏览器回归测试
//
// 为什么必须有这一套：工具页是"所有模块拼在一起的地方"，任何一处接错都能让整页白屏 ——
// 而纯函数测试**一条都测不到**（它们不加载 HTML）。
//
// ⚠️ **测试对象是工具页本身**（`/tools/plan-generator/index.html`），**不是**外壳页
//    `/tools/plan-generator`。原因：
//      · 外壳要求 `tools` 表里有那一行（要用户跑迁移 0022）—— 没跑就是 404，界面测不了；
//      · 而工具页的"一键开关"读的是**自己的** `location.search` 与**父页**的 search，
//        所以直接开工具页能完整验到它（包括父页那条路径，下面另用一个 iframe 壳来测）。
//    这也顺带说明：**工具页不依赖数据库那一行**，只有"目录卡片"依赖它。
//
// 覆盖：
//   ① 依赖脚本全部到位、没有 JS 异常、科目包自检通过
//   ② 下拉联动（学科 → 学段 → 年级），薄弱/已完成多选
//   ③ 点「生成方案」→ 表格 26 行、每行可编辑、自检块在
//   ④ 老师手改一行 → 导出的字节里能看出改动（**从屏幕现取**，不是快照）
//   ⑤ 两个导出都拿真实字节 → python-docx/lxml 独立复核
//   ⑥ 一键开关：本页 `?nocompanyexport=1` 与**父页**参数两种都认
//
// ⚠️ 这一套会**自己起 next start 并杀掉 3000 端口** ⇒ 必须独占跑（一次只跑一个 runner）。
//
// 跑法：& <bundled node> tests\plan-generator-ui.test.mjs   （跑之前先 pnpm build）
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { startServer, startBrowser, makePageApi, makeRecorder, readUsers, readEnv, sleepMs, BASE } from "./_helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = "D:\\my-website\\.tmp-planning-samples\\plangen-ui-out";
const PYTHON = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";
const TOOL_URL = "/tools/plan-generator/index.html";
const { userEmail, password } = readUsers();
const { record, summary } = makeRecorder();

let srv = null, edge = null, cdp = null, sessionId = null;

async function main() {
  srv = await startServer();
  const b = await startBrowser(9226, "D:/my-website/.edge-profile-plangen");
  cdp = b.cdp; sessionId = b.sessionId; edge = b.edge;
  const { ev, goto, login } = makePageApi(cdp, sessionId);

  // 直接开工具页时没有 iframe ⇒ 用 ev 在当前文档上求值
  const page = async (body) => ev(`(() => {
    const d = document, w = window;
    try { ${body} } catch(e){ return {__err:String(e && e.message || e)}; }
  })()`);
  /** 在"自己造的 iframe 壳"里测父页参数那条路径
   *  ⚠️ 这里**必须显式传 search 给 iframe 的 src**：工具页在 iframe 里时，
   *     父页的查询串不会自动进去，工具页正是靠"读父页 location.search"来兜这一层
   *     （`PlanGenCompany.browserDisabled()` 里那段 `window.parent.location.search`）。 */
  const parentPage = async (parentQuery, body) => ev(`(() => {
    const d = document, w = window;
    return new Promise((resolve) => {
      w.history.replaceState({}, '', ${JSON.stringify(TOOL_URL + parentQuery)});
      const f = document.createElement('iframe');
      f.style.cssText = 'width:1200px;height:800px';
      f.src = ${JSON.stringify(TOOL_URL)};
      f.onload = () => {
        const id = f.contentDocument, iw = f.contentWindow;
        setTimeout(() => {
          try { resolve((function(d, w){ ${body} })(id, iw)); }
          catch(e){ resolve({__err:String(e && e.message || e)}); }
        }, 1200);
      };
      document.body.appendChild(f);
    });
  })()`);

  // 收 JS 异常（页面里任何一个脚本报错都要看见）
  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description
        || m.params?.exceptionDetails?.text || "unknown");
    }
  });
  await cdp.send("Runtime.enable", {}, sessionId);

  const loggedIn = await login(userEmail, password);
  record("① 用 VIP 账号登录成功", loggedIn);
  if (!loggedIn) throw new Error("登录失败");

  await goto(TOOL_URL, 6000);

  /* ---------- ① 页面与依赖 ---------- */
  const deps = await page(`return {
    hasSubjects: typeof w.PlanGenSubjects !== 'undefined',
    hasEngine: typeof w.PlanGenEngine !== 'undefined',
    hasAI: typeof w.PlanGenAI !== 'undefined',
    hasCompany: typeof w.PlanGenCompany !== 'undefined',
    hasArchive: typeof w.PlanGenArchive !== 'undefined',
    hasTemplateData: typeof w.PlanGenTemplateData !== 'undefined',
    hasReportTemplate: typeof w.PlanGenReportTemplate !== 'undefined',
    hasDocxBuilder: typeof w.DocxBuilder !== 'undefined',
    hasCompanyDocx: typeof w.CompanyDocx !== 'undefined',
    hasHooks: typeof w.PlanGenHooks !== 'undefined',
    packCheck: w.PlanGenSubjects ? w.PlanGenSubjects.validate().problems : ['no subjects'],
    moduleCount: (w.PlanGenSubjects && w.PlanGenSubjects.loadPack('physics','senior'))
      ? w.PlanGenSubjects.loadPack('physics','senior').modules.length : 0,
  };`);
  record("①-1 9 个依赖脚本全部加载（科目包/引擎/AI/公司/档案/模板/打包器/钩子）",
    deps.hasSubjects && deps.hasEngine && deps.hasAI && deps.hasCompany && deps.hasArchive
    && deps.hasTemplateData && deps.hasReportTemplate && deps.hasDocxBuilder
    && deps.hasCompanyDocx && deps.hasHooks,
    JSON.stringify(deps).slice(0, 300));
  record("①-2 科目包自检 0 问题（配置写错会在这里暴露）",
    Array.isArray(deps.packCheck) && deps.packCheck.length === 0,
    JSON.stringify(deps.packCheck));
  record("①-3 高中物理 26 个模块可加载", deps.moduleCount === 26, String(deps.moduleCount));

  /* ---------- ② 下拉联动 ---------- */
  const dd = await page(`return {
    subjects: Array.from(d.querySelectorAll('#f-subject option')).map(o=>o.value),
    stages: Array.from(d.querySelectorAll('#f-stage option')).map(o=>o.value),
    grades: Array.from(d.querySelectorAll('#f-grade option')).map(o=>o.value),
    gradeValue: d.querySelector('#f-grade').value,
    books: Array.from(d.querySelectorAll('#f-book option')).map(o=>o.value),
    bandText: d.querySelector('#h-band').textContent,
  };`);
  record("②-1 学科下拉有物理", dd.subjects.indexOf("physics") >= 0, dd.subjects.join(","));
  record("②-2 学段下拉有高中与初中（同一个学科两个学段）",
    dd.stages.join(",") === "senior,junior", dd.stages.join(","));
  record("②-3 高中年级默认选中「高三」（最后一个学年最常用）",
    dd.gradeValue === "高三", dd.gradeValue);
  record("②-4 档位提示按科目包的分段线算（不写死分数）",
    dd.bandText.indexOf("档位") >= 0 && dd.bandText.indexOf("100") >= 0, dd.bandText);
  record("②-5 教材版本下拉来自科目包（人教版在前）",
    dd.books.length > 0 && dd.books[0].indexOf("人教版") >= 0, dd.books.join(","));

  // 切到初中 → 年级跟着变
  const junior = await page(`
    const s = d.querySelector('#f-stage'); s.value='junior'; s.dispatchEvent(new Event('change',{bubbles:true}));
    return {
      grades: Array.from(d.querySelectorAll('#f-grade option')).map(o=>o.value),
      value: d.querySelector('#f-grade').value,
      weakCount: d.querySelectorAll('#f-weak .pill').length,
    };`);
  record("②-6 切到初中后年级下拉变成初中的（八年级/九年级…）",
    junior.grades.indexOf("九年级") >= 0 && junior.grades.indexOf("高三") < 0,
    junior.grades.join(","));
  record("②-7 薄弱模块多选按年级筛过（初中九年级 >10 个）", junior.weakCount > 10,
    String(junior.weakCount));

  // 切回高中
  await page(`
    const s = d.querySelector('#f-stage'); s.value='senior'; s.dispatchEvent(new Event('change',{bubbles:true}));
    return true;`);

  /* ---------- ③ 生成 ---------- */
  const gen = await page(`
    d.querySelector('#f-name').value = '张三';
    d.querySelector('#f-school').value = '三河一中';
    d.querySelector('#f-teach').value = '王老师';
    d.querySelector('#f-hours').value = '100';
    d.querySelector('#f-freq').value = '4';
    d.querySelector('#f-score').value = '62';
    w.PlanGenHooks.generate();
    const rows = d.querySelectorAll('table.mods tbody tr[data-row]').length;
    const stageRows = d.querySelectorAll('table.mods tbody tr.stage').length;
    const inputs = d.querySelectorAll('table.mods td input').length;
    const goalInputs = d.querySelectorAll('table.mods input[data-f="goal"]').length;
    const aiButtons = d.querySelectorAll('table.mods [data-ai]').length;
    const checks = d.querySelectorAll('.chk').length;
    const bad = d.querySelectorAll('.chk.bad').length;
    return { rows, stageRows, inputs, goalInputs, aiButtons, checks, bad,
             state: w.PlanGenHooks.state() };`);
  record("③-1 生成出 26 个模块行", gen.rows === 26, String(gen.rows));
  record("③-2 按复习阶段分组（≥4 组，组名来自科目包）", gen.stageRows >= 4, String(gen.stageRows));
  record("③-3 每行 3 个可编辑输入（内容/课时/目标）+ 1 个 AI 按钮",
    gen.inputs === 26 * 3 && gen.goalInputs === 26 && gen.aiButtons === 26,
    `inputs=${gen.inputs} goal=${gen.goalInputs} ai=${gen.aiButtons}`);
  record("③-4 自检块都在、没有红的（合计对得上）",
    gen.checks >= 3 && gen.bad === 0, `checks=${gen.checks} bad=${gen.bad}`);
  record("③-5 课时之和 = 老师填的 100（引擎保证精确相等）",
    gen.state && gen.state.allocated === 100 && gen.state.totalHours === 100,
    JSON.stringify(gen.state && { a: gen.state.allocated, t: gen.state.totalHours }));
  record("③-6 课时保留小数（有 4.5 / 7.5 这类值）",
    gen.state && gen.state.rows.some((r) => String(r.hours).indexOf(".") > 0),
    gen.state ? gen.state.rows.slice(0, 6).map((r) => r.hours).join(",") : "");
  record("③-7 内容那一列**不是空的**（照教材目录填好了，不靠 AI 编）",
    gen.state && gen.state.rows.every((r) => String(r.content || "").trim().length > 0)
    && gen.state.rows[0].content.indexOf("1.1") >= 0,
    gen.state ? gen.state.rows[0].content.slice(0, 40) : "");

  /* ---------- ④ 手改一行 → 导出要取"屏幕现取" ---------- */
  const MARK = "老师手改的标记ABC123";
  await page(`
    const inp = d.querySelector('table.mods input[data-f="goal"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(inp, ${JSON.stringify(MARK)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;`);
  const merged = await page(`return w.PlanGenHooks.state().rows[0].goal;`);
  record("④-1 在表格里手改一格 → 状态同步更新（不是只改 DOM）", merged === MARK, String(merged));

  /* ---------- ⑤ 两个导出，拿真实字节交 Python 复核 ---------- */
  mkdirSync(OUT_DIR, { recursive: true });
  const wordOut = await page(`return w.PlanGenHooks.buildWordBytes();`);
  record("⑤-1 Word 模板导出成功、无警告", !!wordOut && wordOut.rows === 26
    && (wordOut.warnings || []).length === 0,
    wordOut ? `rows=${wordOut.rows} warnings=${JSON.stringify(wordOut.warnings)}` : "null");

  const companyOut = await page(`return w.PlanGenHooks.buildCompany3();`);
  record("⑤-2 公司附件3 导出成功（拿到字节）",
    !!companyOut && companyOut.bytes && companyOut.bytes.length > 50000,
    companyOut ? `${companyOut.bytes.length} 字节` : "null");

  const wordPath = join(OUT_DIR, "ui-word.docx");
  const compPath = join(OUT_DIR, "ui-company3.docx");
  if (wordOut) writeFileSync(wordPath, Buffer.from(wordOut.bytes));
  if (companyOut) writeFileSync(compPath, Buffer.from(companyOut.bytes));

  const py = `
import zipfile, sys, re
from lxml import etree
from docx import Document
from docx.oxml.ns import qn
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
problems = []
def chk(n,c,d=""):
    print(("  OK   " if c else "  FAIL ")+n+((" | "+d) if d else ""))
    if not c: problems.append(n)

P = r"${wordPath}"
z = zipfile.ZipFile(P)
root = etree.fromstring(z.read("word/document.xml"))
alltext = "\\n".join("".join(t.text or "" for t in p.iter(W+"t")) for p in root.iter(W+"p"))
trs = root.findall(".//"+W+"body/"+W+"tbl/"+W+"tr")
hi = next(i for i,tr in enumerate(trs) if "课时数" in "".join(t.text or "" for t in tr.iter(W+"t")))
data = trs[hi+1:]
chk("Word 模板导出：数据行 = 26", len(data) == 26, str(len(data)))
chk("Word 模板导出：零残留占位符", not re.findall(r"\\{\\{[^}]+\\}\\}", z.read("word/document.xml").decode("utf-8")))
chk("Word 模板导出：老师手改的那一格在导出件里", "${MARK}" in alltext)
# ⚠️ 本工具的 Word 模板抬头按**公司/老师原件**只有四格：
#    「学生年级 / 学科 / 教材版本 / 教师」—— **没有"学校"格、也没有"学生姓名"格**
#    （姓名进文件名）。所以这里只核这四格，不硬塞学校。
#    "学校"那一格是**公司附件3**的抬头（下面单独核）。
chk("Word 模板导出：抬头四格（学生年级/学科/教材版本/教师）都填了",
    all(x in alltext for x in ["高三", "物理", "人教版", "王老师"]),
    "（模板抬头没有学校格与学生姓名格，这是按原件来的）")
chk("Word 模板导出：表头标签没被覆盖", all(x in alltext for x in ["阶段（章节/单元/模块）","内容（包括阶段检测）","课时数","教学目标"]))
chk("Word 模板导出：zip CRC 正常", z.testzip() is None)

P2 = r"${compPath}"
d2 = Document(P2); z2 = zipfile.ZipFile(P2)
t = d2.tables[0]
def ct(tc): return "".join(n.text or "" for n in tc.iter(qn("w:t")))
rows = t._tbl.findall(qn("w:tr"))
def rt(tr):
    cs = tr.findall(qn("w:tc")); return cs, "".join(ct(c) for c in cs)
hi2 = next(i for i,tr in enumerate(rows) if "知识模块" in rt(tr)[1])
def is_total(tr):
    cs, txt = rt(tr)
    return len(cs) >= 3 and ct(cs[2]).endswith("小时") and not ct(cs[1]).strip()
ti2 = next(i for i in range(hi2+1, len(rows)) if is_total(rows[i]))
data2 = rows[hi2+1:ti2]
chk("附件3：进度表数据行 = 26", len(data2) == 26, str(len(data2)))
chk("附件3：合计行 = 100小时", ct(rt(rows[ti2])[0][2]) == "100小时", ct(rt(rows[ti2])[0][2]))
alltext2 = "\\n".join("".join(n.text or "" for n in p.iter(qn("w:t"))) for p in d2.paragraphs)
for tr in rows:
    for tc in tr.findall(qn("w:tc")): alltext2 += "\\n" + ct(tc)
chk("附件3：抬头有学生/学校/教师", all(x in alltext2 for x in ["张三","三河一中","王老师"]))
chk("附件3：老师手改的那一格也在", "${MARK}" in alltext2)
LEAKS = ["语病","文言文","古诗文","现代文阅读","语言文字运用"]
hit = [s for s in LEAKS if s in alltext2]
chk("附件3：模板自带的语文样例零残留", not hit, str(hit))
chk("附件3：zip CRC 正常", z2.testzip() is None)
print()
if problems:
    print("[FAIL] %d 项未通过" % len(problems)); sys.exit(1)
print("[OK] 两份导出件独立复核全部通过")
`;
  const pyFile = join(OUT_DIR, "verify-ui.py");
  writeFileSync(pyFile, py, "utf8");
  const run = spawnSync(PYTHON, [pyFile], { encoding: "utf8" });
  console.log("");
  console.log("---- Python 独立复核（两份导出件）----");
  console.log(((run.stdout || "") + (run.stderr || "")).trim());
  record("⑤-3 Python 独立复核两份导出件全部通过", run.status === 0, `status=${run.status}`);

  /* ---------- ⑥ 一键开关 ---------- */
  await goto(TOOL_URL + "?nocompanyexport=1", 5000);
  const off = await page(`return {
    disabled: w.PlanGenHooks.disabled(),
    btnDisplay: d.querySelector('#btnCompany3').style.display,
    panelDisplay: d.querySelector('#company3Panel').style.display,
    wordStillThere: !!d.querySelector('#btnWord'),
  };`);
  record("⑥-1 本页 ?nocompanyexport=1 时：开关判定为关、按钮与面板都消失、其它功能照常",
    off.disabled === true && off.btnDisplay === "none" && off.panelDisplay === "none"
    && off.wordStillThere === true,
    JSON.stringify(off));

  const forced = await page(`
    w.PlanGenHooks.setForm({ name:'张三', hours: 60 });
    w.PlanGenHooks.generate();
    let clicked = false;
    const a0 = d.createElement.bind(d);
    d.createElement = function(t){ const el = a0(t); if(t==='a'){ el.click = function(){ clicked = true; }; } return el; };
    const b = d.getElementById('btnCompany3Export');
    if(b) b.click();
    d.createElement = a0;
    return { clicked, toast: d.querySelector('#toast').textContent };
  `);
  record("⑥-2 关掉后强行调用导出 → 不产生下载（并给出提示）",
    forced.clicked === false, JSON.stringify(forced));

  // 父页参数那条路径（工具页嵌在 iframe 里时，父页的 search 不会自动带进来）
  await goto(TOOL_URL, 4000);
  const byParent = await parentPage("?nocompanyexport=1", `return {
    disabled: w.PlanGenHooks.disabled(),
    btnDisplay: d.querySelector('#btnCompany3').style.display,
    parentSearch: (function(){ try { return w.parent.location.search; } catch(e){ return 'ERR'; } })(),
    selfSearch: w.location.search,
  };`);
  record("⑥-3 ⭐ 父页带 ?nocompanyexport=1 时，iframe 里的工具页也认（后台关掉＝一定关）",
    byParent.disabled === true && byParent.btnDisplay === "none", JSON.stringify(byParent));

  /* ---------- ⑦ 页面没有 JS 异常 ---------- */
  record("⑦ 整轮操作期间页面**零 JS 异常**", pageErrors.length === 0,
    pageErrors.slice(0, 2).join(" | "));
}

try {
  await main();
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
} finally {
  try { if (edge) edge.kill(); } catch { /* ignore */ }
  try { if (srv) srv.kill(); } catch { /* ignore */ }
  spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
    { encoding: "utf8" });
}

const passed = summary();
console.log(`（两份导出件留在 ${OUT_DIR}，可用 Word 打开目测）`);
process.exit(passed ? 0 : 1);
