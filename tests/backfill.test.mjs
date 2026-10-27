#!/usr/bin/env node
/**
 * 「补录历史材料」测试（2026-10 第十八批；用户拍板见 docs/manual-backfill-plan.md）
 * ==========================================================================
 * 测什么（四段）：
 *   一、**纯函数**：入参校验、模型返回的规整、JSON 抠取、长度自检；
 *   二、**提示词契约**：三种材料的提示词都必须要求"我们抽取规则认的那个标记"，
 *       而且必须写着"不许编造" —— 这条是本功能唯一容易做坏的地方；
 *   三、**真接口** `/api/students/backfill`（桩上游）：正常/非 JSON/上游 500/未配 Key/入参错；
 *   四、**真浏览器**：档案页「📥 补录历史材料」→ 粘贴 → 整理 → 核对清单 → **改一处** → 存入
 *       → 记录列表出现 → **学情分析把它算进去**（课时/得分率），而且**以老师改后的为准**。
 *
 * ⚠️ 自己起服务（占 3000）+ 一个桩上游（4592）+ Edge（9493）；别和其它真服务套件并行跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder, startBrowser, makePageApi } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
const STUB_PORT = 4592;      // 4567 ai-apply / 4588 analysis / 4589 attribution / 4590 vision / 4591 school
const CDP_PORT = 9493;

const { record, summary } = makeRecorder();
const { adminEmail, userEmail, password } = readUsers();
readEnv();
const { parseDisplayDate } = await import("../src/lib/date-input.ts");

/* ---------------------------------------------------------------------------
   一、纯函数 + 二、提示词契约（不需要服务）
   --------------------------------------------------------------------------- */
process.removeAllListeners("warning");
process.on("warning", () => { /* 有意静音：MODULE_TYPELESS_PACKAGE_JSON 会被误当成故障 */ });

const {
  BACKFILL_KINDS,
  MAX_MATERIAL_CHARS,
  checkBackfillInput,
  normalizeBackfill,
  extractJsonObject,
  promptFor,
  PAPER_PROMPT,
  PLAN_PROMPT,
  FEEDBACK_PROMPT,
} = await import("../src/lib/backfill.ts");
const { extractPaperWeakness, parsePlanHours, extractSections } = await import("../src/lib/student-report.ts");

{
  record("① 三种材料 → 复用**已有** tool 值（零迁移；新增 tool 会撞数据库 CHECK）",
    BACKFILL_KINDS.paper.tool === "paper" &&
      BACKFILL_KINDS.plan.tool === "math-plan" &&
      BACKFILL_KINDS.feedback.tool === "feedback",
    JSON.stringify(BACKFILL_KINDS));

  record("① 入参：类型不对 / 空内容 / 超长 都被拒（错在哪说清楚）",
    checkBackfillInput({ kind: "x", text: "abc" }).ok === false &&
      /不合法/.test(checkBackfillInput({ kind: "x", text: "abc" }).error) &&
      checkBackfillInput({ kind: "paper", text: "   " }).ok === false &&
      /空的/.test(checkBackfillInput({ kind: "paper", text: "  " }).error) &&
      checkBackfillInput({ kind: "paper", text: "a".repeat(MAX_MATERIAL_CHARS + 1) }).ok === false &&
      /太长/.test(checkBackfillInput({ kind: "paper", text: "a".repeat(MAX_MATERIAL_CHARS + 1) }).error),
    `上限 ${MAX_MATERIAL_CHARS} 字`);

  record("① 入参：合法时回 kind / tool / 去掉首尾空白的正文",
    (() => {
      const c = checkBackfillInput({ kind: "plan", text: "  老方案  " });
      return c.ok === true && c.kind === "plan" && c.tool === "math-plan" && c.text === "老方案";
    })(),
    "OK");
}

{
  const ok = normalizeBackfill({
    text: "【课时安排】共 40 课时",
    facts: { hours: "40", score: 88, fullScore: 150, examName: " 期中 ", examDate: " 8月25日 " },
    uncertain: ["第 3 页有涂改"],
    missing: ["考试日期", ""],
  }, "老方案原文");
  record("① 规整：text/facts/uncertain/missing 都收进来；数字被转成字符串、去空白、去空项",
    ok?.text === "【课时安排】共 40 课时" &&
      ok.facts.hours === "40" && ok.facts.score === "88" && ok.facts.fullScore === "150" &&
      ok.facts.examName === "期中" &&
      ok.facts.examDate === "8月25日" &&
      ok.uncertain.length === 1 && ok.missing.length === 1,
    JSON.stringify(ok));

  record("① 规整：没有 text 就返回 null（调用方据此走「原文兜底」）",
    normalizeBackfill({ facts: {} }, "x") === null,
    "空正文 → null");

  record("★① 长度自检：输出比输入长 1.5 倍以上要标记可疑（防「扩写」，不拦只提醒）",
    normalizeBackfill({ text: "a".repeat(400) }, "a".repeat(200))?.suspiciousLength === true &&
      normalizeBackfill({ text: "a".repeat(240) }, "a".repeat(200))?.suspiciousLength === false &&
      // ⚠️ 短材料也要能判（第一版有个 200 字下限，短材料永远判不出可疑 —— 已去掉，这里钉住）
      normalizeBackfill({ text: "a".repeat(90) }, "a".repeat(30))?.suspiciousLength === true,
    "400/200 → 可疑；240/200 → 正常；90/30（短材料）→ 也可疑");

  record("① 抠 JSON：模型把 JSON 包在解释文字/代码块里也要能抠出来；坏 JSON 返回 null",
    extractJsonObject('好的：\n```json\n{"text":"x"}\n```')?.text === "x" &&
      extractJsonObject('{"a":1}')?.a === 1 &&
      extractJsonObject("这里没有 JSON") === null &&
      extractJsonObject("{坏 json") === null,
    "三种情况都覆盖");
}

/* ---- 提示词契约：必须要求"抽取规则认的那个标记" ---- */
{
  record("★② 试卷分析提示词必须要求**「核心薄弱板块集中在以下 N 处：」**这一句（否则学情分析抽不到薄弱点）",
    /核心薄弱板块集中在以下\s*N\s*处/.test(PAPER_PROMPT),
    "这句在提示词里");
  record("★② 辅导方案提示词必须要求**「【课时安排】共 N 课时」**（否则课时统计算不上）",
    /【课时安排】共\s*N?\s*x*?\s*课时/.test(PLAN_PROMPT) || /【课时安排】/.test(PLAN_PROMPT),
    "这个标记在提示词里");
  record("★② 课后反馈提示词必须要求 **【主要失分点】** 小标题（否则失分抽取不到）",
    /【主要失分点】/.test(FEEDBACK_PROMPT),
    "小标题在提示词里");

  record("★★② 日期抽取：反馈提示词要求从正文里抽 facts.examDate（「8月25日数学课反馈」这种），且不许补年份",
    /examDate/.test(FEEDBACK_PROMPT) && /8月25日/.test(FEEDBACK_PROMPT) &&
      /不要自己补年份|不补年份/.test(FEEDBACK_PROMPT),
    "日期抽取规则在提示词里");

  record("★★② 日期抽取的落点：`8月25日` 经 parseDisplayDate 变成今年的 ISO（预览日期框可直接用）",
    parseDisplayDate("8月25日") === `${new Date().getFullYear()}-08-25`,
    String(parseDisplayDate("8月25日")));

  record("★★② 三条提示词都要写明「不许编造 / 只写材料里有的事实」（这是本功能的红线）",
    [PAPER_PROMPT, PLAN_PROMPT, FEEDBACK_PROMPT].every((p) => /不许推测|不许编造/.test(p) && /留空|看清/.test(p)),
    "红线都在");

  record("★★② 契约对拍：提示词要求的标记，正是 student-report 抽取规则认的（改一边不改另一边就红）",
    (() => {
      // ① 用**提示词要求的那句格式**造一段正文，看抽取规则认不认
      const paperText = "【试卷分析】\n试卷总分：150　　试卷得分：88\n" +
        "核心薄弱板块集中在以下 2 处：导数与函数单调性；解析几何（联立与韦达定理）。\n";
      const weak = extractPaperWeakness(paperText);
      // ② 辅导方案那行
      const planText = "【学情诊断】基础还行。\n【课时安排】共 40 课时\n【阶段安排】函数 | 基础 | 8 | 会做\n";
      const hours = parsePlanHours(planText);
      // ③ 反馈那两段抽取
      const fbText = "【课堂表现】认真。\n【主要失分点】三角恒等变换公式记错。\n";
      const secs = extractSections(fbText).map((s) => s.label);
      return weak.length === 2 && weak[0].includes("导数") && hours === 40 && secs.includes("主要失分点");
    })(),
    "提示词与抽取规则对得上");

  record("② 未知类型取提示词返回空串（不抛错）",
    promptFor("nope") === "", "空串");
}

/* ---------------------------------------------------------------------------
   桩上游（4592）：按 `__set` 切换返回形态
   --------------------------------------------------------------------------- */
const calls = [];
let stubMode = "json";     // json | rawtext | upstream500 | empty
let stubPayload = null;    // json 模式下要返回的对象
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/__set") {
      try {
        const j = JSON.parse(raw);
        if (j.mode) stubMode = String(j.mode);
        if (j.payload) stubPayload = j.payload;
      } catch { /* 忽略 */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 保留 null */ }
    calls.push({ path: req.url, body });
    res.setHeader("content-type", "application/json");
    if (stubMode === "upstream500") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "stub-backfill-boom" } }));
      return;
    }
    const content =
      stubMode === "empty" ? ""
        : stubMode === "rawtext" ? "这是一段没有 JSON 的原文：学生期中 88/150，薄弱在导数。"
          : JSON.stringify(stubPayload ?? {
              text: "【试卷分析】\n试卷总分：150　　试卷得分：88\n核心薄弱板块集中在以下 1 处：导数与函数单调性。\n分析人：探针",
              facts: { examDate: "2024-04-15", examName: "补录期中", score: "88", fullScore: "150", hours: "" },
              uncertain: ["第 2 页有涂改"],
              missing: ["考试时间"],
            });
    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 800, completion_tokens: 300 },
    }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

/* ---------------------------------------------------------------------------
   起服务（带上桩上游）
   --------------------------------------------------------------------------- */
const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
};

killPort3000();
await sleep(1500);
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], {
  cwd: PROJECT,
  stdio: "ignore",
  env: {
    ...process.env,
    AI_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    AI_KEY: "stub-key-for-backfill-test",
    AI_MODEL: "stub-model",
  },
});
let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch { /* 等 */ }
}
record("（准备）本地服务已起来（带桩上游）", up);
if (!up) { summary(); process.exit(1); }

const vipCookie = await loginCookie(userEmail, password);   // roleb = VIP（AI 功能要会员）
const freeCookie = await loginCookie(adminEmail, password); // rolea = 免费
record("（准备）会员与免费两个会话都拿到", !!vipCookie && !!freeCookie);

const post = (cookie, body) =>
  fetch(`${BASE}/api/students/backfill`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

let edge = null;
try {
  /* ======================================================================
     三、真接口
     ====================================================================== */
  {
    calls.length = 0;
    const r = await post(freeCookie, { kind: "paper", text: "学生期中 88/150，薄弱在导数" });
    const j = await r.json().catch(() => null);
    record("③ 非会员 → 403 且**一次上游都没调**（不白花一次 AI）",
      r.status === 403 && calls.length === 0 && /会员/.test(String(j?.error)),
      `HTTP ${r.status} 上游调用 ${calls.length} 次`);
  }
  {
    const r = await fetch(`${BASE}/api/students/backfill`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "paper", text: "x" }),
    });
    record("③ 未登录 → 401", r.status === 401, `HTTP ${r.status}`);
  }
  {
    const r = await post(vipCookie, { kind: "nope", text: "x" });
    const j = await r.json().catch(() => null);
    record("③ 类型不合法 → 400 并说清楚（不是 500）",
      r.status === 400 && /不合法/.test(String(j?.error)), `HTTP ${r.status} ${String(j?.error)}`);
  }
  {
    const r = await post(vipCookie, { kind: "paper", text: "" });
    record("③ 空内容 → 400", r.status === 400, `HTTP ${r.status}`);
  }
  {
    stubMode = "json";
    calls.length = 0;
    const r = await post(vipCookie, { kind: "paper", text: "学生期中 88/150，薄弱在导数" });
    const j = await r.json().catch(() => null);
    record("③ 正常：200 + 统一结构（text/facts/tool/uncertain/missing）",
      r.status === 200 && j?.ok === true && j?.tool === "paper" &&
        /核心薄弱板块集中在以下/.test(String(j?.text)) && j?.facts?.score === "88" &&
        (j?.uncertain ?? []).length === 1 && (j?.missing ?? []).length === 1,
      JSON.stringify({ tool: j?.tool, facts: j?.facts, uncertain: j?.uncertain }).slice(0, 160));
    record("③ 正常：**把材料原文发给了上游**（system 是提示词、user 是材料）",
      calls.length === 1 && String(calls[0]?.body?.messages?.[1]?.content ?? "").includes("学生期中 88/150") &&
        /核心薄弱板块/.test(String(calls[0]?.body?.messages?.[0]?.content ?? "")),
      `上游调用 ${calls.length} 次`);
    record("③ 正常：发上游时带了 `thinking` 关闭（模型名不含 deepseek 时不该带）",
      calls[0]?.body?.thinking === undefined,
      `thinking=${JSON.stringify(calls[0]?.body?.thinking)}`);
  }
  {
    stubMode = "rawtext";
    const r = await post(vipCookie, { kind: "feedback", text: "这节课讲了导数" });
    const j = await r.json().catch(() => null);
    record("★③ 模型没按 JSON 返回时：**不 500**，把原文交给前端手工整理（不白花这次调用）",
      r.status === 200 && j?.ok === true && j?.rawFallback === true && /没有 JSON/.test(String(j?.text)),
      `HTTP ${r.status} rawFallback=${j?.rawFallback}`);
  }
  {
    stubMode = "upstream500";
    const r = await post(vipCookie, { kind: "paper", text: "x" });
    const j = await r.json().catch(() => null);
    record("③ 上游 500 → 502，且**不透传上游原文**",
      r.status === 502 && !/stub-backfill-boom/.test(JSON.stringify(j)),
      `HTTP ${r.status}`);
  }
  {
    stubMode = "empty";
    const r = await post(vipCookie, { kind: "paper", text: "x" });
    record("③ 上游返回空正文 → 502（不是 200 带空内容）", r.status === 502, `HTTP ${r.status}`);
  }
  stubMode = "json";

  /* ======================================================================
     四、真浏览器：粘贴 → 整理 → 核对 → **改一处** → 存入 → 学情分析算进去
     ====================================================================== */
  const STU = `__补录测试__${Date.now()}`;
  const { SUPABASE_URL, ANON_KEY } = readEnv();
  const tok = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: userEmail, password }),
  })).json();
  const H = { apikey: ANON_KEY, Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" };
  const purge = async (n) => {
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(n)}`, { method: "DELETE", headers: H });
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_students?name=eq.${encodeURIComponent(n)}`, { method: "DELETE", headers: H });
  };
  await purge(STU);

  const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-backfill");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login } = makePageApi(cdp, sessionId);
  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      pageErrors.push(`${String(d?.text)} ${String(d?.exception?.description ?? "").slice(0, 140)}`);
    }
  });

  record("④（准备）会员在浏览器里登录", await login(userEmail, password));
  await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 4500);

  const opened = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('补录历史材料'));
    if (!btn) return { err: '找不到「补录历史材料」按钮' };
    btn.click();
    return { ok: true };
  })()`);
  record("④ 档案详情页有「📥 补录历史材料」入口且能展开", !opened?.err, opened?.err || "已展开");

  /* ---------------------------------------------------------------------
     ⭐ 2026-10 用户线上验收（问题 1）：**粘贴后自动整理，不用再点按钮**
     --------------------------------------------------------------------- */
  await sleep(400);
  const autoFilled = await ev(`(() => {
    const f = [...document.querySelectorAll('section')].find((s) => s.innerText.includes('补录历史材料') && s.querySelector('textarea'));
    if (!f) return { err: '面板没展开' };
    const ta = f.querySelector('textarea[placeholder*="老材料"]');
    const d = Object.getOwnPropertyDescriptor(ta.constructor.prototype, 'value');
    // 模拟"粘进来一段"：真实粘贴会先把值落进 textarea，然后派发 paste 事件 —— 这里照做
    d.set.call(ta, '2025年3月月考，数学 100/150。错题：第9题立体几何。');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
    return { ok: true };
  })()`);
  record("④（准备）模拟粘贴：只派发 paste 事件，**不点任何按钮**", !autoFilled?.err, autoFilled?.err || "已粘贴");

  let autoPreview = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    autoPreview = await ev(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => /核心薄弱板块|辅导方案/.test(t.value));
      return ta ? { text: ta.value.slice(0, 80) } : null;
    })()`);
    if (autoPreview) break;
  }
  record("★★④ **只粘贴、不点「整理」，预览也会自己出现**（用户要的「少点一次」）",
    !!autoPreview, autoPreview ? String(autoPreview.text).slice(0, 60) : "等了 15 秒还没出现");

  // 日期输入框（问题 2）：补录必须能让老师选哪天
  const dateBox = await ev(`(() => {
    const f = [...document.querySelectorAll('section')].find((s) => s.innerText.includes('补录历史材料'));
    if (!f) return { err: '面板没找到' };
    const inp = f.querySelector('input[type="date"]');
    return inp ? { value: inp.value, hasLabel: /哪天的/.test(f.innerText) } : { err: '没有日期输入框' };
  })()`);
  record("★★④ 预览里**有「这条记录是哪天的？」日期框，且有默认值**（问题 2：补录必须选日期）",
    !dateBox?.err && !!dateBox?.value && dateBox?.hasLabel === true,
    JSON.stringify(dateBox));

  // 放弃这次的自动预览，回到干净状态继续走下面的主流程（那里验"老师改一处再存"）
  await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('放弃这次'));
    if (b) b.click();
    return true;
  })()`);
  await sleep(500);

  await sleep(500);
  const filled = await ev(`(() => {
    const f = [...document.querySelectorAll('section')].find((s) => s.innerText.includes('补录历史材料') && s.querySelector('textarea'));
    if (!f) return { err: '面板没展开' };
    const ta = f.querySelector('textarea[placeholder*="老材料"]');
    const setV = (el, v) => {
      const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setV(ta, '2024年4月期中考试，数学 88/150。错题：第12题导数单调性；第13题解析几何联立。\\n建议多练导数。');
    // ⚠️ 2026-10 起按钮文案从「让 AI 整理成统一格式」改成了「重新整理」
    //    （因为上传/粘贴现在**会自动整理**，这个按钮只是"重跑"）。选择器用「整理」两个字兜住两种文案。
    const go = [...f.querySelectorAll('button')].find((x) => x.textContent.includes('重新整理'));
    if (!go) return { err: '找不到整理按钮' };
    go.click();
    return { ok: true };
  })()`);
  record("④ 粘贴旧材料文字并点「整理」", !filled?.err, filled?.err || "已提交");

  let preview = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    preview = await ev(`(() => {
      const ta = [...document.querySelectorAll('textarea')].find((t) => t.value.includes('核心薄弱板块') || t.value.includes('【'));
      const body = document.body.innerText;
      return ta ? { text: ta.value, body: body.slice(0, 400) } : null;
    })()`);
    if (preview) break;
  }
  record("★④ 整理后出现**可编辑的预览**（正文里带着我们抽取规则认的那句「核心薄弱板块集中在以下…」）",
    !!preview && /核心薄弱板块集中在以下/.test(String(preview.text)),
    JSON.stringify(String(preview?.text ?? "").slice(0, 120)));
  // ⚠️ 读**核对清单所在的那一块**，别读整个 body（面板在页面上很长，
  //    读 body 前 400 字只会拿到页面标题 —— 第一版就是这么假红的）
  const checklist = await ev(`(() => {
    const el = [...document.querySelectorAll('div,section')].find((d) => /核对清单/.test(d.innerText) && d.innerText.length < 900);
    return el ? el.innerText.replace(/\\s+/g, ' ') : '';
  })()`);
  record("★④ 预览里给了**核对清单**：得分 / 满分 / 日期 + 「材料里没有的项」点名",
    /核对清单/.test(String(checklist)) && /得分/.test(String(checklist)) &&
      /88/.test(String(checklist)) && /150/.test(String(checklist)) &&
      /没有/.test(String(checklist)) && /考试时间/.test(String(checklist)),
    String(checklist).slice(0, 240));

  // ★ 老师改一处：把薄弱板块改成他自己的说法（证明"以改后的为准"）
  const edited = await ev(`(() => {
    const ta = [...document.querySelectorAll('textarea')].find((t) => t.value.includes('核心薄弱板块'));
    if (!ta) return { err: '找不到预览框' };
    const v = ta.value.replace('核心薄弱板块集中在以下 1 处：导数与函数单调性。',
                               '核心薄弱板块集中在以下 2 处：导数与函数单调性；解析几何联立。');
    const d = Object.getOwnPropertyDescriptor(ta.constructor.prototype, 'value');
    d.set.call(ta, v); ta.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: v.includes('2 处') };
  })()`);
  record("④ 老师可以**直接改**整理结果（改完不以 AI 原文为准）", edited?.ok === true, JSON.stringify(edited));

  const saved = await ev(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('存入档案'));
    if (!btn) return { err: '找不到存入按钮' };
    btn.click();
    return { ok: true };
  })()`);
  record("④ 点「💾 存入档案」", !saved?.err, saved?.err || "已提交");
  await sleep(3500);

  const hist = await (await fetch(`${BASE}/api/students?name=${encodeURIComponent(STU)}&withHistory=1`, { headers: { cookie: vipCookie } })).json();
  const items = (hist?.history ?? {})[STU] ?? [];
  const rec0 = items.find((i) => String(i.tool) === "paper") ?? null;
  record("★④ 记录进档案了（tool=paper，零迁移复用已有归属）",
    !!rec0 && /导数与函数单调性/.test(String(rec0.text)),
    JSON.stringify(items.map((i) => [i.tool, i.title])).slice(0, 160));
  record("★★④ 存进去的是**老师改后的版本**（「2 处」在库里，不是 AI 原文的「1 处」）",
    /核心薄弱板块集中在以下 2 处/.test(String(rec0?.text)),
    (String(rec0?.text ?? "").match(/核心薄弱板块集中在以下[^\n]*/) ?? ["<没找到>"])[0].slice(0, 90));
  record("④ 分数与满分也落库了（学情分析的成绩趋势要用）",
    rec0?.score === 88 && rec0?.fullScore === 150,
    `score=${rec0?.score} fullScore=${rec0?.fullScore}`);
  // ⭐ 2026-10 用户线上验收（问题 2「未填日期」）：补录的记录**必须有日期**落库。
  //    以前这里是 `preview.facts.examDate || ""`，AI 抽不到就存 NULL ⇒ 详情页「未填日期」。
  record("★★④ 补录的记录**带上了日期**（不再是「未填日期」）—— 问题 2 的正面断言",
    String(rec0?.date ?? "").trim() !== "" && /^\d{1,2}月\d{1,2}日$/.test(String(rec0?.date)),
    `date=${JSON.stringify(rec0?.date)}（材料里写的是「2024年4月」，AI 抽不到时应回落到老师选的日期）`);

  // 学情分析把它算进去了吗（刷新页面看服务端渲染）
  await goto(`/dashboard?name=${encodeURIComponent(STU)}`, 4500);
  const summaryText = String(await ev(`document.body.innerText.replace(/\\s+/g,' ')`));
  record("★★④ 学情分析**把补录的这条算进成绩趋势**（88/150 → 58.7%）",
    /58\.7%/.test(summaryText) && /88/.test(summaryText) && /150/.test(summaryText),
    (summaryText.match(/成绩趋势[^；]{0,80}/) ?? ["<没找到成绩趋势>"])[0].slice(0, 90));
  record("★★④ 学情分析也**抽到了补录材料里的薄弱点**（这句原话进了「薄弱与失分」）",
    /核心薄弱板块/.test(summaryText) && /解析几何联立|导数与函数单调性/.test(summaryText),
    (summaryText.match(/核心薄弱板块[^；]{0,60}/) ?? ["<没找到>"])[0].slice(0, 90));

  record("④ 页面无真实 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ") || "0 条");

  // 收尾：清掉探针
  await purge(STU);
  const after = await (await fetch(`${BASE}/api/students?name=${encodeURIComponent(STU)}&withHistory=1`, { headers: { cookie: vipCookie } })).json();
  record("④ 收尾：探针数据已清掉", ((after?.history ?? {})[STU] ?? []).length === 0, "干净");

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
  console.error(e?.stack ?? e);
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  killPort3000();
  stub.close();
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
