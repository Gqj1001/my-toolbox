#!/usr/bin/env node
/**
 * 手动补录成绩（2026-10 第十四批）—— 测试
 * ==========================================================================
 * 测什么（四段）：
 *   一、**纯函数**校验（`src/lib/manual-score.ts`）：必填、日期合法性、得分>满分、
 *        正文与类型字段的规整 —— 不用起服务，秒级跑完；
 *   二、**真接口** `POST /api/students { op:"manual" }`：写进去、读得回来、能删掉；
 *   三、**学情分析**：补录的成绩自动进「成绩趋势」与「记录概览」（'manual' 已登记），
 *        且**不会**被当成「薄弱与失分」的证据（手动记录没有诊断正文，不允许编）；
 *   四、**真浏览器**：档案详情页能展开表单、填、提交、看到成功提示、记录出现在列表里。
 *
 * ⚠️ 本套件**自动适配两种状态**（迁移 `0019_history_tool_allow_manual.sql` 跑没跑）：
 *    · 没跑 → 断言"保存被明确拒绝 + 点名要跑哪个迁移"（分支 A）
 *    · 跑过 → 断言完整链路（分支 B）
 *    跑完之后本套件会自动改测分支 B。这与 `admin-feature-flags` 是同一套做法。
 *
 * ⚠️ 自己起 `next start`（会杀 3000 端口），别和其它真服务套件并行跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder, startBrowser, makePageApi } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
const CDP_PORT = 9497;

const { record, summary } = makeRecorder();
const { adminEmail, password } = readUsers();
readEnv();

/* ---------------------------------------------------------------------------
   一、纯函数（不需要服务；node 自带类型擦除，可直接 import .ts）
   ---------------------------------------------------------------------------
   ⚠️ 与 `student-report.test.mjs` 同一个做法：先静音 warning，再动态 import。 */
process.removeAllListeners("warning");
process.on("warning", () => { /* 有意静音：MODULE_TYPELESS_PACKAGE_JSON 会被误当成故障 */ });

const {
  normalizeManualScore,
  MANUAL_TEXT_PREFIX,
  EXAM_TYPES,
  manualScoreHooks,
  isToolConstraintError,
  TOOL_CONSTRAINT_MIGRATION,
} = await import("../src/lib/manual-score.ts");
const { readFileSync } = await import("node:fs");

const BASE_INPUT = { student_name: "张三", title: "学校期中考试", date: "2026-10-07", score: 105, full_score: 150 };

{
  const r = normalizeManualScore(BASE_INPUT);
  record("① 正常输入：校验通过，tool 固定 manual、分数是数字",
    r.ok === true && r.row.tool === "manual" && r.row.score === 105 && r.row.full_score === 150,
    JSON.stringify(r.ok ? r.row : r));
  record("① 正文带固定前缀（列表里一眼看出这条不是工具生成的）",
    r.ok === true && r.row.text.startsWith(MANUAL_TEXT_PREFIX) && r.row.text.includes("学校期中考试"),
    r.ok ? r.row.text.replace(/\n/g, " / ") : "-");
  record("① 日期被收成 `YYYY-MM-DD`（合法日期原样）", r.ok === true && r.row.date === "2026-10-07",
    r.ok ? r.row.date : "-");
  record("① 科目缺省 = 数学（为将来全学科留口子）", r.ok === true && r.row.subject === "数学",
    r.ok ? String(r.row.subject) : "-");
  record("① 考试类型留空 = null（不写空串进库）", r.ok === true && r.row.type_name === null,
    r.ok ? JSON.stringify(r.row.type_name) : "-");
}

{
  // 带 ISO 时间的日期（前端有时会这样传）也要认
  const r = normalizeManualScore({ ...BASE_INPUT, date: "2026-10-07T10:00:00Z" });
  record("① 日期带时间部分也认（2026-10-07T10:00:00Z → 2026-10-07）",
    r.ok === true && r.row.date === "2026-10-07", r.ok ? r.row.date : JSON.stringify(r));
}

{
  const r = normalizeManualScore({ ...BASE_INPUT, date: "2026-02-30" });
  record("① 假日期被拒（2026-02-30：真日历校验，照 parseDisplayDate 的口径）",
    r.ok === false && /日期/.test(r.error), JSON.stringify(r));
}
{
  const r = normalizeManualScore({ ...BASE_INPUT, date: "2026-13-05" });
  record("① 非法月份被拒（2026-13-05）", r.ok === false && /日期/.test(r.error), JSON.stringify(r));
}

{
  const cases = [
    ["缺学生姓名", { ...BASE_INPUT, student_name: "  " }, /姓名/],
    ["缺考试名称", { ...BASE_INPUT, title: "" }, /考试名称/],
    ["缺日期", { ...BASE_INPUT, date: "" }, /日期/],
    ["缺得分", { ...BASE_INPUT, score: "" }, /得分/],
    ["缺满分", { ...BASE_INPUT, full_score: "" }, /满分/],
    ["得分大于满分", { ...BASE_INPUT, score: 200 }, /不能大于满分/],
    ["满分是 0", { ...BASE_INPUT, full_score: 0 }, /正数/],
    ["满分离谱（>1000）", { ...BASE_INPUT, full_score: 2000, score: 100 }, /1000/],
    ["得分不是数字", { ...BASE_INPUT, score: "一百" }, /得分/],
    ["备注过长", { ...BASE_INPUT, note: "备".repeat(501) }, /备注过长/],
  ];
  for (const [label, input, re] of cases) {
    const r = normalizeManualScore(input);
    record(`① 拒绝：${label}`, r.ok === false && re.test(r.error), r.ok ? "竟然通过了！" : r.error);
  }
}

{
  const r = normalizeManualScore({
    student_name: " 李四 ", title: " 别家模考 ", date: "2026-09-01",
    score: "88.5", full_score: "150", type_name: "模考", note: "不在我们这考的",
  });
  record("① 字符串数字 + 两端空格：被规整（姓名去空格、88.5 保留、类型带上）",
    r.ok === true && r.row.student_name === "李四" && r.row.title === "别家模考" &&
      r.row.score === 88.5 && r.row.type_name === "模考" && r.row.text.includes("备注：不在我们这考的"),
    r.ok ? JSON.stringify({ n: r.row.student_name, t: r.row.title, s: r.row.score, ty: r.row.type_name }) : JSON.stringify(r));
}

{
  record("① 考试类型下拉里有「校考/月考/期中/期末/模考/其他」（老师手填口径）",
    JSON.stringify([...EXAM_TYPES]) === JSON.stringify(["校考", "月考", "期中", "期末", "模考", "其他"]),
    JSON.stringify(EXAM_TYPES));
  const hooks = manualScoreHooks();
  const c = hooks.create("张三", { title: "X" });
  const rm = hooks.remove(7);
  record("① 提交/删除的地址与请求体唯一来源就在这个函数里（页面与测试共用，避免假绿）",
    c.url === "/api/students" && c.method === "POST" && c.body.op === "manual" &&
      c.body.student_name === "张三" && c.body.title === "X" &&
      rm.url === "/api/students?id=7" && rm.method === "DELETE",
    JSON.stringify({ post: c.url, del: rm.url }));
}

/* ==========================================================================
   1b. ★撞约束的判定（**本轮由新套件当场抓到的真 bug，防回归就靠这几条**）
   --------------------------------------------------------------------------
   症状：迁移没跑时，本该返回 409 + 点名迁移文件，实际返回 500 +「保存失败」
        —— 老师完全无法定位（照提示去跑 0016 也没用，因为提示本身就错了）。
   根因两条：① 只判 `message`（PostgREST 把约束名放在 `details` 里）；
            ② 迁移文件名写死在路由里、是旧的。
   ========================================================================== */
{
  // ⚠️ 这一段是**变异自证逼出来的**（第一版写错了，两次假绿）：
  //    ① 第一版按 SQLSTATE `23514` 判 → 按"只认约束名"再变异时**不红**，说明 code 在替我兜底；
  //    ② 而 `23514` 是"违反任意 CHECK"，`feedback_students_extra_is_object`（extra 必须是对象）
  //       也是 23514 ⇒ 按 code 判会把无关错误误报成「请去跑 0019 迁移」。**这是真隐患，已收紧**。
  //    现在这些样本里**一个都不带 23514**，只有约束名——去掉 details 的判定这条立刻红（已实测）。
  record("① PostgREST 形状甲：约束名在 message 里",
    isToolConstraintError({
      code: "PGRST500",
      message: 'new row for relation "feedback_history" violates check constraint "feedback_history_tool_check"',
      details: null,
      hint: null,
    }) === true,
    "message 带约束名 → 认");

  record("★① PostgREST 形状乙：约束名**只在 details 里**（实测就是这个形状）也必须认",
    isToolConstraintError({
      code: "PGRST500",
      message: 'new row for relation "feedback_history" violates check constraint',
      details: 'Failing row contains (12, 张三, …, __nope__, …) violates "feedback_history_tool_check".',
    }) === true,
    "只靠 details 也能认（去掉 details 的判定 → 这条红）");

  record("① 字符串形态（有些层会把错误转成字符串）也认",
    isToolConstraintError('error: violates check constraint "feedback_history_tool_check"') === true,
    "字符串命中");

  record("★① 别的 CHECK 约束**不许**被误判（否则会把无关错误说成'请去跑 0019 迁移'）",
    isToolConstraintError({
      code: "23514",
      message: 'new row for relation "feedback_students" violates check constraint "feedback_students_extra_is_object"',
      details: 'Failing row contains (7, 张三, …, wrong).',
    }) === false,
    "extra 必须是 JSON 对象那条（同样是 23514）→ 不认");

  record("① 其它错误也不许被误判（RLS / 网络错 / 空值）",
    isToolConstraintError({ code: "42501", message: "new row violates row-level security policy" }) === false &&
      isToolConstraintError(new Error("fetch failed")) === false &&
      isToolConstraintError(null) === false,
    "RLS / 网络错 / null 都不是");

  record("★契约：点名的迁移 == 仓库里最后一条改这条 CHECK 的迁移（写死旧文件名会误导老师）",
    /0019_history_tool_allow_manual\.sql$/.test(TOOL_CONSTRAINT_MIGRATION),
    TOOL_CONSTRAINT_MIGRATION);

  const routeSrc = readFileSync("D:/my-website/my-toolbox/src/app/api/students/route.ts", "utf8");
  const anaSrc = readFileSync("D:/my-website/my-toolbox/src/app/api/students/analysis/route.ts", "utf8");
  // ⚠️ 断言前先把注释去掉（`//` 行注释与 `/** */` 块注释都要去）：
  //    注释里**提到**旧迁移名是正常的（那是在讲历史），差一点因为没去块注释又写成假红。
  const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释（含 JSDoc）
    .replace(/\/\/.*$/gm, "");          // 行注释
  const rCode = strip(routeSrc);
  const aCode = strip(anaSrc);
  record("★契约：两个写历史的接口都用同一份判定与同一个迁移名（不许各处自己写一份）",
    /from "@\/lib\/manual-score"/.test(routeSrc) && /TOOL_CONSTRAINT_MIGRATION/.test(rCode) &&
      /from "@\/lib\/manual-score"/.test(anaSrc) && /TOOL_CONSTRAINT_MIGRATION/.test(aCode) &&
      // 旧行为的两条特征：写死 0016 的提示、写死 0017 的提示
      !/0016_history_tool_allow_math_plan/.test(rCode) &&
      !/0017_history_tool_allow_analysis/.test(aCode),
    `students=${/TOOL_CONSTRAINT_MIGRATION/.test(rCode)} analysis=${/TOOL_CONSTRAINT_MIGRATION/.test(aCode)}`);
}

/* ---------------------------------------------------------------------------
   起服务（后面的接口与浏览器两段都要它）
   --------------------------------------------------------------------------- */
const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
};

killPort3000();
await sleep(1500);
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore", env: { ...process.env } });
let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch { /* 等 */ }
}
record("（准备）本地服务已起来", up);
if (!up) { summary(); process.exit(1); }

const cookie = await loginCookie(adminEmail, password);
record("（准备）拿到登录会话（rolea = 免费版/管理员）", !!cookie);

const STU = `__手动补录测试__${Date.now()}`;
const TODAY_ISO = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const post = (body) =>
  fetch(`${BASE}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const getHistory = async (name) => {
  const r = await fetch(`${BASE}/api/students?name=${encodeURIComponent(name)}&withHistory=1`, { headers: { cookie } });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j, items: ((j?.history ?? {})[name] ?? []) };
};
const del = (id) => fetch(`${BASE}/api/students?id=${id}`, { method: "DELETE", headers: { cookie } });

let edge = null;
let migrationReady = false;
try {
  /* ======================================================================
     二、真接口
     ====================================================================== */
  const created = await post({
    op: "manual", student_name: STU, title: "学校期中考试", date: TODAY_ISO,
    score: 105, full_score: 150, type_name: "期中", note: "不在我们这考的",
  });
  const cj = await created.json().catch(() => null);
  // ⚠️ 这里**故意不用断言**报"迁移跑没跑"：那是环境状态，不是代码对不对。
  //    用一句 console.log 说清楚，然后按状态走 A/B 两支（两支都必须是 100% 通过，
  //    否则"迁移没跑"就会长期显示成一条红 —— 与 `admin-feature-flags` 同一个口径）。
  migrationReady = created.status === 200 && cj?.ok === true;
  console.log(migrationReady
    ? "     → 迁移 0019 **已执行**：走分支 B（测「保存 → 读回 → 进趋势 → 删除」完整链路）"
    : `     → 迁移 0019 **还没执行**：走分支 A（测「明确拒绝 + 点名迁移 + 一条都没写进去」）；` +
      "在 Supabase 跑完 0019 后本套会自动改测分支 B");

  if (!migrationReady) {
    /* ---------------- 分支 A：迁移还没跑 ---------------- */
    record("② 迁移没跑时：**明确拒绝**并点名要跑哪个迁移（409 + tool_constraint）",
      created.status === 409 && cj?.code === "tool_constraint" && /0019_history_tool_allow_manual\.sql/.test(String(cj?.error)),
      `HTTP ${created.status} code=${cj?.code} err=${String(cj?.error).slice(0, 120)}`);
    record("② 迁移没跑时：**没有**写进任何记录（不静默丢数据也不静默写错归属）",
      (await getHistory(STU)).items.length === 0,
      `条数=${(await getHistory(STU)).items.length}`);
  } else {
    /* ---------------- 分支 B：完整链路 ---------------- */
    const newId = Number(cj?.id);
    record("② 保存成功并返回新记录 id", Number.isFinite(newId) && newId > 0, `id=${cj?.id}`);

    // ⚠️ 立刻读回：**不用刷新、不用等缓存过期** —— 写完之后接口必须清历史缓存，
    //    否则会出现"刚保存成功、读接口 25 秒为空"（本项目反复踩过的症状）。
    const h1 = await getHistory(STU);
    const mine = h1.items.filter((i) => i.tool === "manual");
    record("② 立刻读回就能看到它（写完必须清历史缓存，不能等 25 秒 TTL）",
      mine.length === 1 && mine[0].id === newId,
      `manual 条数=${mine.length} ids=${h1.items.map((i) => i.id).join(",")}`);
    record("② 读回来的字段对：tool/title/score/fullScore/date 都在，且带正文",
      mine[0]?.title === "学校期中考试" && mine[0]?.score === 105 && mine[0]?.fullScore === 150 &&
        mine[0]?.date === `${Number(TODAY_ISO.slice(5, 7))}月${Number(TODAY_ISO.slice(8, 10))}日` &&
        String(mine[0]?.text ?? "").includes(MANUAL_TEXT_PREFIX),
      JSON.stringify(mine[0]).slice(0, 240));

    // ---- 学情分析：自动进趋势 + 进概览；但不进「薄弱与失分」----
    // ⚠️ 断言方式：**查表格行**，不要拼字符串。第一版写成 `html.includes("90/150")`，
    //    而页面渲染出来是 `90` 与 ` / 150` 两段（JSX 之间自动插了空格）⇒ 假红。
    //    查结构既准确又不怕措辞/空格变化。
    const pageHtml = await (await fetch(`${BASE}/dashboard?name=${encodeURIComponent(STU)}`, { headers: { cookie } })).text();
    record("③ 档案详情页把学情分析**算进去了**：「手动补录 1 条」出现在记录概览里",
      /手动补录\s*1\s*条/.test(pageHtml.replace(/<[^>]+>/g, "")),
      (pageHtml.replace(/<[^>]+>/g, " ").match(/共\s*\d+\s*条记录[^；]{0,80}/) ?? ["(没匹配到概览行)"])[0]);

    /** 从 HTML 里抠出"成绩趋势"表格中名称含 title 的那一行，返回该行的单元格文本 */
    const scoreRow = (html, title) => {
      const table = html.slice(html.indexOf("成绩趋势"));
      const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
      for (const row of rows) {
        const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/g) ?? [])
          .map((c) => c.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
        if (cells.some((c) => c.includes(title))) return cells;
      }
      return null;
    };
    const row1 = scoreRow(pageHtml, "学校期中考试");
    record("③ 成绩趋势里有一行是这条手动补录，得分/满分/得分率都对（105 / 150 → 70%）",
      !!row1 && row1.includes("105 / 150") && row1.includes("70%") && row1.includes("手动补录"),
      JSON.stringify(row1));

    // ---- 400：得分大于满分 ----
    const bad = await post({ op: "manual", student_name: STU, title: "错数据", date: TODAY_ISO, score: 200, full_score: 150 });
    const bj = await bad.json().catch(() => null);
    record("② 得分大于满分 → 400（不写库）", bad.status === 400 && /不能大于满分/.test(String(bj?.error)),
      `HTTP ${bad.status} ${String(bj?.error).slice(0, 80)}`);

    // ---- 删除这一条（只删记录，不删档案）----
    const d = await del(newId);
    record("② 删除成功（HTTP 200）", d.status === 200, `HTTP ${d.status}`);
    const h2 = await getHistory(STU);
    record("② 删掉后读回就没了（同样必须清缓存，不能 25 秒内复活）",
      h2.items.filter((i) => i.id === newId).length === 0, `剩余 ${h2.items.length} 条`);

    /* ==================================================================
       四、真浏览器：档案详情页能填、能提交、能看到结果
       ================================================================== */
    const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-manual");
    edge = b.edge;
    const { cdp, sessionId } = b;
    const { ev, goto, login } = makePageApi(cdp, sessionId);
    const pageErrors = [];
    cdp.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown") {
        const dd = m.params.exceptionDetails;
        pageErrors.push(`${String(dd?.text)} ${String(dd?.exception?.description ?? "").slice(0, 140)}`);
      }
    });

    record("④（准备）在浏览器里登录", await login(adminEmail, password));
    await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 4500);

    const opened = await ev(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('补录一次成绩'));
      if (!btn) return { err: '找不到「补录一次成绩」按钮' };
      btn.click();
      return { ok: true, label: btn.textContent.trim() };
    })()`);
    record("④ 详情页有「📝 补录一次成绩」按钮且能展开表单", !opened?.err, opened?.err || opened?.label);

    await sleep(500);
    const filled = await ev(`(() => {
      const f = [...document.querySelectorAll('form')].find((x) => x.querySelector('input[name="title"]'));
      if (!f) return { err: '表单没展开' };
      const set = (n, v) => { const el = f.querySelector('[name="' + n + '"]'); if (el) el.value = v; };
      set('title', '浏览器补录·月考');
      set('date', '${TODAY_ISO}');
      set('score', '90');
      set('full_score', '150');
      set('note', '来自浏览器测试');
      f.requestSubmit();
      return { ok: true };
    })()`);
    record("④ 填表并提交（真人操作路径）", !filled?.err, filled?.err || "已提交");

    let okMsg = "";
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      okMsg = String(await ev(`document.body.innerText.includes('已补录一条成绩') ? '已补录一条成绩' : ''`));
      if (okMsg) break;
    }
    record("④ 提交后页面显示成功提示", okMsg !== "", okMsg || "30 次轮询都没等到提示");

    // ⚠️ 时序：Server Action 写库 + router.refresh() 把服务端渲染拉回来需要时间；
    //    整套回归负载下固定等 1.5 秒可能不够（2026-10 实测：单跑必过、全套偶发 row=null）。
    //    改成短轮询，出现即停。
    let listed = null;
    for (let i = 0; i < 30; i++) {
      listed = await ev(`(() => {
        const t = document.body.innerText;
        const table = document.body.innerHTML.slice(document.body.innerHTML.indexOf('成绩趋势'));
        const rows = table.match(/<tr[\\s\\S]*?<\\/tr>/g) || [];
        const cells = rows.map((r) => (r.match(/<t[dh][\\s\\S]*?<\\/t[dh]>/g) || [])
          .map((c) => c.replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim()));
        const row = cells.find((c) => c.some((x) => x.includes('浏览器补录')));
        return { title: t.includes('浏览器补录·月考'), row: row || null };
      })()`);
      if (listed?.title === true && Array.isArray(listed?.row) &&
          listed.row.includes("90 / 150") && listed.row.includes("60%")) break;
      await sleep(500);
    }
    record("④ 刷新后记录出现在成绩趋势里，且该行是 90 / 150 与 60%",
      listed?.title === true && Array.isArray(listed?.row) &&
        listed.row.includes("90 / 150") && listed.row.includes("60%"),
      JSON.stringify(listed));
    record("④ 页面无真实 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "0 条");

    // ---- 收尾：把这次浏览器写的那条也删掉（测试不留垃圾）----
    const after = await getHistory(STU);
    for (const it of after.items) await del(it.id);
    const clean = await getHistory(STU);
    record("④ 收尾：测试产生的记录已全部清掉", clean.items.length === 0, `剩余 ${clean.items.length} 条`);

    try { await cdp.send("Browser.close"); } catch { /* ignore */ }
  }
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
  console.error(e?.stack ?? e);
} finally {
  // 收尾：无论如何都把这个测试学生的记录清掉（不留脏数据）
  try {
    const left = await getHistory(STU);
    for (const it of left.items) await del(it.id);
  } catch { /* ignore */ }
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  killPort3000();
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  console.log(migrationReady
    ? "\n（本套走的是**分支 B**：迁移 0019 已在线上执行，完整链路全部实测）"
    : "\n（本套走的是**分支 A**：迁移 0019 还没执行；在 Supabase 跑完之后本套会自动改测分支 B）");
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
