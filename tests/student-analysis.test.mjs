#!/usr/bin/env node
/**
 * 学情分析（`POST /api/students/analysis`）的集成测试
 *
 * 覆盖三件事：
 *   1. **鉴权口径**：未登录/非会员 403、封禁别的情形不在本套；且**非会员不该白花一次上游调用**；
 *   2. **喂给 AI 的东西**：system 提示词带四个小标题与「不许编造」约束，
 *      user 消息就是服务端算好的结构化摘要（含成绩、课时、薄弱原文），
 *      并且**不能把以前生成的学情报告再喂回去**（报告不能吃自己）；
 *   3. **落库**：生成的报告以 `tool='analysis'` 存成一条记录，可在 `/api/students` 里读回。
 *
 * ⚠️ 落库依赖数据库那条 CHECK 已经放开（迁移 `0017_history_tool_allow_analysis.sql`）。
 *    没跑那段 SQL 时，本套件**不会假装通过**：它会断言
 *    「返回 409 + 点名迁移文件 + 报告正文照常返回（不白花一次 AI 调用）」，
 *    并明确打印"跑完 0017 再回来跑一次才能验落库"。
 *    这样做是因为「测试要能证伪」：把缺迁移说成"跳过"就等于永远不验。
 *
 * 跑法（需先 pnpm build）：
 *   & "<bundled node>" tests\student-analysis.test.mjs
 * ⚠️ 自己起 next start（端口 3000）→ 别和其它真服务套件同时跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN =
  "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
/** 桩上游端口（⚠️ 别和别的套件撞：ai-thinking 4586 / vision 4587 / ai-apply 4567） */
const STUB_PORT = 4588;

const { record, summary } = makeRecorder();
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { adminEmail, userEmail, password } = readUsers();   // rolea=免费管理员 / roleb=会员

/** 探针学生（用独立名字，避免污染别的套件的数据） */
const STU = "__学情分析探针";
const REPORT_MARK = "【整体学情】这是桩上游生成的学情报告正文。";

const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
  return pid;
};

/* ==========================================================================
   桩上游
   ========================================================================== */
const calls = [];
/** ok（正常） / empty（空正文） / upstream500（上游报错） */
let stubMode = "ok";

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 保留 null */ }
    calls.push({ path: req.url, auth: req.headers.authorization ?? "", body });
    res.setHeader("content-type", "application/json");
    if (stubMode === "upstream500") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "stub-upstream-boom" } }));
      return;
    }
    const content = stubMode === "empty"
      ? ""
      : REPORT_MARK + "\n【优势】基础尚可。\n【薄弱与原因】导数与解析几何不稳。\n【下一步建议】① 先补导数单调性。";
    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 800, completion_tokens: 400 },
    }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

/* ==========================================================================
   起服务 + 登录
   ========================================================================== */
killPort3000();
await sleep(1500);
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], {
  cwd: PROJECT,
  stdio: "ignore",
  env: {
    ...process.env,
    AI_KEY: "stub-key",
    AI_MODEL: "deepseek-flash",
    AI_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  },
});
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch { /* 等 */ }
}

const vipCookie = await loginCookie(userEmail, password);     // roleb = 会员
const freeCookie = await loginCookie(adminEmail, password);   // rolea = 免费
record("（准备）会员与免费两个会话都拿到了", !!vipCookie && !!freeCookie);

const post = (cookie, body) =>
  fetch(`${BASE}/api/students/analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

try {
  /* ======================================================================
     0. 造数据（会员账号名下）
     ====================================================================== */
  await fetch(`${BASE}/api/students?name=${encodeURIComponent(STU)}`, { method: "DELETE", headers: { cookie: vipCookie } });
  const seedStudent = await fetch(`${BASE}/api/students`, {
    method: "POST", headers: { cookie: vipCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ name: STU, grade: "高三", campus: "燕郊中学校区", teacher: "郭庆杰", subject: "math" }),
  });
  const seedHist = await fetch(`${BASE}/api/students`, {
    method: "POST", headers: { cookie: vipCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      op: "import",
      items: [
        { student_name: STU, text: "9月月考分析。核心薄弱板块集中在以下 2 处：导数单调性；解析几何第二问。",
          date: "2026-09-10", tool: "paper", title: "9月月考", score: 62, full_score: 100, subject: "math" },
        { student_name: STU, text: "【学情诊断】基础一般，计算常出错。\n【提分目标】62 → 100 分\n【课时安排】共 10 课时\n【逐次课表】…",
          date: "2026-09-20", tool: "math-plan", title: "秋季辅导方案" },
        { student_name: STU, text: "【课堂表现】认真。\n【主要失分点】三角恒等变换用错公式。\n【改进建议】多练。",
          date: "2026-10-01", tool: "feedback", title: "10月1日反馈" },
      ],
    }),
  });
  const seedStudentBody = await seedStudent.json().catch(() => null);
  const seedHistBody = await seedHist.json().catch(() => null);
  record("（准备）会员名下建好 1 个学生 + 3 条记录（paper / math-plan / feedback）",
    seedStudent.status === 200 && seedStudentBody?.ok === true &&
      seedHist.status === 200 && seedHistBody?.inserted === 3,
    `student=${seedStudent.status} history=${seedHist.status} ${JSON.stringify(seedHistBody)}`);

  /* ======================================================================
     1. 鉴权：非会员不该白花一次上游调用
     ====================================================================== */
  {
    const before = calls.length;
    const rFree = await post(freeCookie, { name: STU });
    const jFree = await rFree.json().catch(() => null);
    record("★鉴权：免费用户 → 403，且提示写明「会员专属」",
      rFree.status === 403 && /会员专属/.test(jFree?.error ?? ""),
      `HTTP ${rFree.status} ${JSON.stringify(jFree?.error)}`);
    record("★鉴权：被拒时**上游一次都没被调**（不能白花 AI 的钱）",
      calls.length === before, `桩被调用 ${calls.length - before} 次`);
  }
  {
    const rAnon = await post("", { name: STU });
    record("★鉴权：未登录 → 401", rAnon.status === 401, `HTTP ${rAnon.status}`);
  }

  /* ======================================================================
     2. 没有记录的学生 → 明确的 400（不是 500，也不是空报告）
     ====================================================================== */
  {
    const before = calls.length;
    const r = await post(vipCookie, { name: "__学情分析·查无此人" });
    const j = await r.json().catch(() => null);
    record("★没有记录的学生 → 400 且提示明确（不编一份空报告）",
      r.status === 400 && /还没有任何记录/.test(j?.error ?? ""),
      `HTTP ${r.status} ${JSON.stringify(j?.error)}`);
    record("★没有记录时不调上游（省一次 AI 调用）", calls.length === before);
  }
  {
    const r = await post(vipCookie, {});
    record("入参：缺姓名 → 400", r.status === 400, `HTTP ${r.status}`);
  }

  /* ======================================================================
     3. 正常生成：请求体 + 响应
     ====================================================================== */
  stubMode = "ok";
  calls.length = 0;
  const r1 = await post(vipCookie, { name: STU });
  const j1 = await r1.json().catch(() => null);
  const b1 = calls.at(-1)?.body;
  const sys = b1?.messages?.[0]?.content ?? "";
  const usr = b1?.messages?.[1]?.content ?? "";

  record("③ 正常生成 → 拿到上游返回的那份正文（HTTP 200 = 连落库都成了；409 = 只差数据库那半，见下）",
    String(j1?.report ?? "").startsWith(REPORT_MARK),
    `HTTP ${r1.status} ${JSON.stringify(String(j1?.report ?? j1?.error ?? "").slice(0, 60))}`);
  record("③ 桩**真的被打了**（否则上面那条可能是假绿）",
    calls.length >= 1 && calls.at(-1)?.path === "/chat/completions" && calls.at(-1)?.auth === "Bearer stub-key",
    `path=${JSON.stringify(calls.at(-1)?.path)} auth=${JSON.stringify(calls.at(-1)?.auth)}`);

  record("★提示词：system 里带四个小标题（整体学情/优势/薄弱与原因/下一步建议）",
    ["【整体学情】", "【优势】", "【薄弱与原因】", "【下一步建议】"].every((k) => sys.includes(k)),
    JSON.stringify(sys.slice(0, 80)));
  record("★提示词：明确要求「只依据材料、不许编造」并且材料不足要说出来",
    /不许编造|不得编造/.test(sys) && /材料不足|如实/.test(sys),
    JSON.stringify(sys.slice(0, 120)));
  record("护栏：模型名含 deepseek → 带 thinking:{type:\"disabled\"}，max_tokens=6000",
    b1?.thinking?.type === "disabled" && b1?.max_tokens === 6000 && b1?.model === "deepseek-flash",
    `model=${JSON.stringify(b1?.model)} thinking=${JSON.stringify(b1?.thinking)} max_tokens=${b1?.max_tokens}`);

  record("★喂给 AI 的是**服务端算好的摘要**：含成绩明细、得分率、课时累计、薄弱原文",
    usr.includes("62/100") && usr.includes("得分率 62%") && usr.includes("累计 10 课时") &&
      usr.includes("导数单调性") && usr.includes("三角恒等变换"),
    `user 摘要 ${usr.length} 字`);
  record("★摘要里带上了「数据说明」（材料缺口），AI 才有机会如实说",
    usr.includes("数据说明"), "");

  /* ======================================================================
     4. 落库（取决于 0017 是否已执行）
     ====================================================================== */
  const notMigrated = r1.status === 409 && j1?.code === "tool_constraint";
  if (notMigrated) {
    record("★落库：数据库还没放开 analysis → 409 且**点名迁移文件**（跑完 0017 这条会变成保存成功）",
      /0017_history_tool_allow_analysis\.sql/.test(j1?.error ?? ""),
      JSON.stringify(String(j1?.error ?? "").slice(0, 120)));
    record("★落库：409 时**报告正文照常返回**（不让用户白花一次 AI 调用）",
      typeof j1?.report === "string" && j1.report.length > 0, `report 长度=${String(j1?.report ?? "").length}`);
    console.log("\n  ⚠️  数据库还没执行 0017：本套件已验证「生成成功 + 409 明确提示 + 报告不丢」，");
    console.log("     但**落库那半还没验**。请在 Supabase SQL Editor 跑");
    console.log("     supabase/migrations/0017_history_tool_allow_analysis.sql 之后再跑一次本套件。\n");
  } else {
    record("★落库：生成成功后自动存进档案（ok:true + saved:true + 标题带日期时间）",
      r1.status === 200 && j1?.ok === true && j1?.saved === true && /^学情报告 · /.test(String(j1?.title ?? "")),
      `saved=${j1?.saved} title=${JSON.stringify(j1?.title)}`);

    const got = await (await fetch(
      `${BASE}/api/students?name=${encodeURIComponent(STU)}&withHistory=1`,
      { headers: { cookie: vipCookie } },
    )).json().catch(() => null);
    const list = (got?.history?.[STU] ?? []);
    const savedRow = list.find((h) => h.tool === "analysis");
    record("★落库：能在 /api/students 里读回这条记录（tool='analysis'、正文一致）",
      !!savedRow && String(savedRow.text).startsWith(REPORT_MARK) &&
        String(savedRow.title ?? "").startsWith("学情报告"),
      JSON.stringify({ tool: savedRow?.tool, title: savedRow?.title, date: savedRow?.date }));

    /* ------------------------------------------------------------------
       5. 「报告不能吃自己」：第二次生成时，摘要里不许出现第一份报告的正文
       ------------------------------------------------------------------ */
    calls.length = 0;
    const r2 = await post(vipCookie, { name: STU });
    const j2 = await r2.json().catch(() => null);
    const usr2 = calls.at(-1)?.body?.messages?.[1]?.content ?? "";
    record("★报告不吃自己：第二次生成的摘要里**不含**上一份报告的正文",
      r2.status === 200 && !usr2.includes(REPORT_MARK) && usr2.includes("数据说明"),
      `摘要里出现旧报告正文=${usr2.includes(REPORT_MARK)}`);
    record("★报告不吃自己：但会**告知**排除了 N 份历史学情报告（不静默）",
      usr2.includes("排除") && usr2.includes("学情报告"),
      JSON.stringify(usr2.split("\n").filter((l) => l.includes("排除")).join(" | ")));
  }

  /* ======================================================================
     6. 上游异常：不许静默、不许透传原文
     ====================================================================== */
  {
    stubMode = "empty";
    const r = await post(vipCookie, { name: STU });
    const j = await r.json().catch(() => null);
    record("★上游返回空正文 → 502 且提示「内容为空」（不静默给一份空报告）",
      r.status === 502 && j?.ok === false && /内容为空/.test(j?.error ?? ""),
      `HTTP ${r.status} ${JSON.stringify(j?.error)}`);
  }
  {
    stubMode = "upstream500";
    const r = await post(vipCookie, { name: STU });
    const j = await r.json().catch(() => null);
    record("★上游 5xx → 502，且**不透传上游原文**（可能带 key/账户信息）",
      r.status === 502 && !/stub-upstream-boom/.test(JSON.stringify(j)),
      `HTTP ${r.status} ${JSON.stringify(j)}`);
    stubMode = "ok";
  }
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
} finally {
  // 清理探针（会员名下）
  try {
    await fetch(`${BASE}/api/students?name=${encodeURIComponent(STU)}`, { method: "DELETE", headers: { cookie: vipCookie } });
  } catch { /* 忽略 */ }
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  killPort3000();
  stub.close();
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
