#!/usr/bin/env node
/**
 * 「错因列 AI 润色」（`POST /api/paper-analysis/ai-advice` 的 `section:"attribution"`）测试
 *
 * 背景（用户 2026-10 提的）：报告里【错题分析】表的最后一列「失分情况及原因分析」是程序
 * 按规则生成的**原始诊断口气**，会冒出「知识体系尚未建立」「能力严重不足」这类**重话**，
 * 直接给家长看很扎人。用户要求**不只是改通顺，还要把口吻改对**（面向家长、温和、不下定论）。
 *
 * 本套件验三件事：
 *   1. **接口契约**：段数是硬约束（返回段数与输入不一致就拒绝，绝不错位）；
 *      提示词里真的写了「不下定论」那套口径；thinking 护栏与老路径（建议段）没被改坏；
 *   2. **鉴权**：非会员 403，且**上游一次都没被调**（不白花 AI 的钱）；
 *   3. **真浏览器端到端**：点工具页那个按钮 → **只换最后一列**，
 *      分数/题号/知识点一列不动，写「无」的行不动，失败时报告保持原样。
 *
 * 跑法（需先 pnpm build）：
 *   & "<bundled node>" tests\paper-attribution-polish.test.mjs
 * ⚠️ 自己起 next start（端口 3000，桩上游 4589）→ 别和其它真服务套件同时跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder, startBrowser, makePageApi } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN =
  "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
/** 桩上游端口（⚠️ 别撞：ai-thinking 4586 / vision 4587 / student-analysis 4588） */
const STUB_PORT = 4589;
const CDP_PORT = 9491;

const { record, summary } = makeRecorder();
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { adminEmail, userEmail, password } = readUsers();   // rolea=免费管理员 / roleb=会员

const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
  return pid;
};

/* ==========================================================================
   桩上游：按输入段落数返回同样多的行（这样"段数一致"这条契约才能被验到）
   ========================================================================== */
const calls = [];
/** ok = 正常返回 N 行；short = 少返回一行（验段数不一致被拒）；
 *  shortOnce = **只第一次**少一行（验"合并按钮失败自动重试一次"）；
 *  upstream500 = 上游报错 */
let stubMode = "ok";
/** 错因列被调了几次（`shortOnce` 要靠它区分第一次/第二次） */
let attrCalls = 0;

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
      res.end(JSON.stringify({ error: { message: "stub-attribution-boom" } }));
      return;
    }

    // 从 user 内容里解出段落（服务端发的是 JSON：{context, paragraphs}）
    let paragraphs = [];
    try { paragraphs = JSON.parse(body?.messages?.[1]?.content ?? "{}").paragraphs ?? []; } catch { /* 忽略 */ }
    if (paragraphs.length) attrCalls++;
    let lines = paragraphs.map((p, i) => `润色后第${i + 1}段：${String(p).slice(0, 8)}（面向家长的说法）`);
    const dropLine =
      (stubMode === "short" && lines.length > 1) ||
      (stubMode === "shortOnce" && attrCalls === 1 && lines.length > 1);
    if (dropLine) lines = lines.slice(0, lines.length - 1);
    // ⚠️ 老路径（建议段）发的是结构化诊断 JSON，**没有 paragraphs** —— 那种请求要回一段正文，
    //    否则本套件第 6 条（"老路径没被改坏"）会因为桩返回空串而假红。
    const content = paragraphs.length
      ? lines.join("\n")
      : "这是桩上游返回的建议段正文（老路径仍照旧）。";

    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

/* ==========================================================================
   起服务 + 两个会话
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

const vipCookie = await loginCookie(userEmail, password);
const freeCookie = await loginCookie(adminEmail, password);
record("（准备）会员与免费两个会话都拿到", !!vipCookie && !!freeCookie);

const post = (cookie, body) =>
  fetch(`${BASE}/api/paper-analysis/ai-advice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

const P3 = ["含参分类讨论不完整，知识体系尚未建立", "联立与韦达定理运算能力不足", "事件设定与步骤书写不规范"];

/** 浏览器里"造一份真实报告"的公共步骤（VIP / 非会员两段都用，**只写一份**）：
 *  载入示例 → 解析 → 填姓名 → 让 3 道题得 0 分（这样报告里才有【错题分析】行可润）→ 生成报告 */
const BROWSER_SETUP = `
  w.document.getElementById('btnDemo').click();
  w.document.getElementById('btnParse').click();
  w.document.getElementById('stuName').value = '探针同学';
  let zeroed = 0;
  for (const no of [1, 2, 3]) {
    const el = w.document.querySelector('#scoreList input[data-got="' + no + '"]');
    if (el) { el.value = '0'; el.dispatchEvent(new w.Event('input', { bubbles: true })); zeroed++; }
  }
  w.document.getElementById('btnGen').click();
  const t = w.document.getElementById('reportText').textContent;
  return { zeroed, hasAttr: t.includes('【错题分析】'), hasAdvice: t.includes('【教学辅导建议/安排】'),
           rows: t.split('\\n').filter(l => /^[0-9]+ \\| /.test(l)).length };
`;

/** 读报告：建议段是否已是桩文本、错题分析有几行被润色 / 仍是原文；按钮的文案与 title */
const BROWSER_READ = `
  const t = w.document.getElementById('reportText').textContent;
  const all = t.split('\\n');
  const rows = all.filter(l => /^[0-9]+ \\| /.test(l));
  const btn = w.document.getElementById('btnPolishAll');
  const i = t.indexOf('【错题分析】');
  return { adviceIsAI: /桩上游返回的建议段正文/.test(t),
           attrIsAI: rows.filter(l => /润色后第/.test(l)).length,
           // "没被润色" = 这一行的最后一列**不是**桩返回的润色文案
           // ⚠️ 别去匹配具体的诊断措辞：真实报告的原因文字是叙述者按规则生成的
           //    （合成报告里那几句只在第 7 节出现过），匹配措辞会假红
           attrRaw: rows.filter(l => !/润色后第/.test(l)).length,
           rows: rows.length, rowSample: rows.slice(0, 1).join('').slice(0, 90),
           attrArea: i < 0 ? '(没有错题分析段)' : t.slice(i, i + 160),
           label: btn.textContent.trim(), title: btn.title };
`;

let edge = null;
try {
  /* ======================================================================
     1. 会员：正常润色（段数一致）
     ====================================================================== */
  stubMode = "ok";
  calls.length = 0;
  const r1 = await post(vipCookie, { section: "attribution", paragraphs: P3, context: { subject: "数学", examName: "月考" } });
  const j1 = await r1.json().catch(() => null);
  const b1 = calls.at(-1)?.body;
  const sys1 = b1?.messages?.[0]?.content ?? "";
  const usr1 = b1?.messages?.[1]?.content ?? "";

  record("① 会员调用 → 200 且返回**按段**的 lines（段数与输入一致）",
    r1.status === 200 && j1?.ok === true && j1?.section === "attribution" &&
      Array.isArray(j1?.lines) && j1.lines.length === 3,
    `HTTP ${r1.status} ${JSON.stringify(j1).slice(0, 160)}`);
  record("① 桩**真的被打了**（否则上面那条可能是假绿）",
    calls.length === 1 && calls[0].path === "/chat/completions" && calls[0].auth === "Bearer stub-key",
    `path=${JSON.stringify(calls[0]?.path)}`);

  record("★提示词：明确写了「面向家长 / 不下定论 / 不贴标签 / 保留全部事实」",
    /家长/.test(sys1) && /不下定论|不要贴标签/.test(sys1) && /保留/.test(sys1) &&
      /能力严重缺失|知识体系尚未建立/.test(sys1),   // 禁止清单里点名了这些"重话"
    JSON.stringify(sys1.slice(0, 90)));
  record("★提示词：要求「每段一行、行数必须与输入一致」（段数是契约）",
    /行数必须与输入完全一致|行数必须与输入一致/.test(sys1.replace(/\*\*/g, "")),
    "");
  record("护栏：模型名含 deepseek → 带 thinking:{type:\"disabled\"}；错因用更小的预算与更低的温度",
    b1?.thinking?.type === "disabled" && b1?.max_tokens === 4000 && b1?.temperature === 0.3 &&
      b1?.model === "deepseek-flash",
    `thinking=${JSON.stringify(b1?.thinking)} max_tokens=${b1?.max_tokens} temperature=${b1?.temperature}`);
  record("入参透传：三段原文原样发给模型（没有分数、没有题号）",
    (() => {
      try {
        const parsed = JSON.parse(usr1);
        return JSON.stringify(parsed.paragraphs) === JSON.stringify(P3) && !/题号|\d+\s*分/.test(usr1.replace(/第\d段/g, ""));
      } catch { return false; }
    })(),
    JSON.stringify(usr1).slice(0, 160));

  /* ======================================================================
     2. 非会员：403 且不花 AI 的钱
     ====================================================================== */
  {
    const before = calls.length;
    const r = await post(freeCookie, { section: "attribution", paragraphs: P3 });
    const j = await r.json().catch(() => null);
    record("★非会员 → 403，且提示写明「会员专属」",
      r.status === 403 && /会员专属/.test(j?.error ?? ""), `HTTP ${r.status} ${JSON.stringify(j?.error)}`);
    record("★被拒时**上游一次都没被调**（不白花 AI 的钱）", calls.length === before, `桩被调用 ${calls.length - before} 次`);
  }

  /* ======================================================================
     3. 段数不一致 → 拒绝（否则前端会把文案贴到错误的题上）
     ====================================================================== */
  {
    stubMode = "short";
    const r = await post(vipCookie, { section: "attribution", paragraphs: P3 });
    const j = await r.json().catch(() => null);
    record("★AI 返回段数与原文不一致 → 502 且提示明确（绝不错位贴文案）",
      r.status === 502 && /段落数/.test(j?.error ?? ""), `HTTP ${r.status} ${JSON.stringify(j?.error)}`);
    stubMode = "ok";
  }

  /* ======================================================================
     4. 入参校验
     ====================================================================== */
  {
    const bad = await post(vipCookie, { section: "attribution", paragraphs: "不是数组" });
    record("入参：paragraphs 不是数组 → 400", bad.status === 400, `HTTP ${bad.status}`);
    const empty = await post(vipCookie, { section: "attribution", paragraphs: [] });
    record("入参：空数组 → 400（没有可润色的段）", empty.status === 400, `HTTP ${empty.status}`);
    const blank = await post(vipCookie, { section: "attribution", paragraphs: ["   ", ""] });
    record("入参：全是空白串 → 400（不留空段错位）", blank.status === 400, `HTTP ${blank.status}`);
    const tooMany = await post(vipCookie, { section: "attribution", paragraphs: Array.from({ length: 61 }, (_, i) => `第${i}段原因`) });
    record("入参：超过 60 段 → 413（拒绝而不是静默截断）", tooMany.status === 413, `HTTP ${tooMany.status}`);
  }

  /* ======================================================================
     5. 上游异常：502 且不透传原文
     ====================================================================== */
  {
    stubMode = "upstream500";
    const r = await post(vipCookie, { section: "attribution", paragraphs: P3 });
    const j = await r.json().catch(() => null);
    record("★上游 5xx → 502，且**不透传上游原文**（可能带 key/账户信息）",
      r.status === 502 && !/stub-attribution-boom/.test(JSON.stringify(j)), `HTTP ${r.status} ${JSON.stringify(j)}`);
    stubMode = "ok";
  }

  /* ======================================================================
     6. ★老路径回归：不带 section 的那份（建议段）必须一字未改地照旧工作
     ====================================================================== */
  {
    calls.length = 0;
    const r = await post(vipCookie, { task: "advice", name: "张三", score: 88, full: 150, typeSummary: [{ 题型: "解答题", 得分率: "60%" }] });
    const j = await r.json().catch(() => null);
    const b = calls.at(-1)?.body;
    record("★老路径（建议段）未被改坏：仍 200、返回 `text`（不是 lines）、提示词仍是建议段那份",
      r.status === 200 && j?.ok === true && typeof j?.text === "string" && j.text.length > 0 &&
        !Array.isArray(j.lines) && /教学辅导建议/.test(b?.messages?.[0]?.content ?? ""),
      `HTTP ${r.status} text 长度=${String(j?.text ?? "").length}`);
  }

  /* ======================================================================
     7. ★真浏览器：点按钮 → 只换「原因」那一列
     ====================================================================== */
  {
    const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-attr");
    edge = b.edge;
    const { cdp, sessionId } = b;
    const { ev, goto, inTool, login } = makePageApi(cdp, sessionId);

    record("会员在浏览器里登录成功", await login(userEmail, password));
    await goto("/tools/paper-analysis", 5000);

    /** 合成一份最小但结构完整的报告（含【错题分析】表；第 3 行是"无"= 全对） */
    const SYNTH = [
      "锐满分教育试卷分析表",
      "【学员基本信息】",
      "学生姓名：探针　　年级：高三",
      "【试卷分析】",
      "试卷总分：100　　试卷得分：62",
      "【错题分析】",
      "题号 | 题型 | 分值 | 得分 | 难度 | 考察知识点 | 失分情况及原因分析",
      "12 | 解答题 | 15 | 5 | 中 | 导数及其应用 | 含参分类讨论不完整，知识体系尚未建立",
      "13 | 解答题 | 17 | 10 | 难 | 平面解析几何 | 联立与韦达定理运算能力不足",
      "14 | 单选题 | 5 | 5 | 易 | 集合与常用逻辑用语 | 无",
      "【教学辅导建议/安排】",
      "这里是建议段占位。",
      "分析人：郭庆杰　　学管师：＿＿＿　　家长签字：＿＿＿＿＿＿",
    ].join("\n");

    const put = await inTool(`
      const el = w.document.getElementById('reportText');
      if(!el) return { err:'报告框不存在' };
      el.textContent = ${JSON.stringify(SYNTH)};
      const btn = w.document.getElementById('btnAIPolishAttr');
      return { hasBtn: !!btn, len: el.textContent.length };
    `);
    record("★工具页里有「AI 润色错因列」按钮，且报告框存在（说明按钮与接线都在）",
      put?.hasBtn === true && put?.len > 0, JSON.stringify(put));

    const clicked = await inTool(`
      const btn = w.document.getElementById('btnAIPolishAttr');
      btn.click();
      return 'clicked';
    `);
    if (clicked !== "clicked") record("（准备）点击润色按钮", false, JSON.stringify(clicked));
    await sleep(2500);

    const after = await inTool(`
      const t = w.document.getElementById('reportText').textContent;
      return { text: t, chars: w.document.getElementById('stChars').textContent };
    `);
    const lines = String(after?.text ?? "").split("\n");
    const row12 = lines.find(l => l.startsWith("12 | ")) ?? "";
    const row13 = lines.find(l => l.startsWith("13 | ")) ?? "";
    const row14 = lines.find(l => l.startsWith("14 | ")) ?? "";

    record("★端到端：两处错因**都被润色了**（换成桩返回的文案）",
      /润色后第1段/.test(row12) && /润色后第2段/.test(row13),
      `12 → ${row12.slice(0, 90)} / 13 → ${row13.slice(0, 90)}`);
    record("★★只动最后一列：题号/题型/分值/得分/难度/知识点**逐字未变**",
      row12.startsWith("12 | 解答题 | 15 | 5 | 中 | 导数及其应用 | ") &&
        row13.startsWith("13 | 解答题 | 17 | 10 | 难 | 平面解析几何 | "),
      `row12=${row12.slice(0, 60)} / row13=${row13.slice(0, 60)}`);
    record("★写「无」的那一行（全对）**没有被送去润色**、原样保留",
      row14 === "14 | 单选题 | 5 | 5 | 易 | 集合与常用逻辑用语 | 无", JSON.stringify(row14));
    record("★报告的其它部分没被动（表头、建议段、签字栏都还在）",
      String(after?.text).includes("【教学辅导建议/安排】") &&
        String(after?.text).includes("这里是建议段占位。") &&
        String(after?.text).includes("家长签字：") &&
        String(after?.text).includes("题号 | 题型 | 分值 | 得分 | 难度 | 考察知识点 | 失分情况及原因分析"),
      `字数=${after?.chars}`);

    /* ---- 失败时**不动原文**（结构里没有【错题分析】） ---- */
    const BEFORE = "这是一份没有错题分析段的报告。\n分析人：郭庆杰";
    await inTool(`
      const el = w.document.getElementById('reportText');
      el.textContent = ${JSON.stringify(BEFORE)};
      w.document.getElementById('btnAIPolishAttr').click();
      return 'clicked';
    `);
    await sleep(1200);
    const afterBad = await inTool(`return w.document.getElementById('reportText').textContent;`);
    record("★找不到可润色的段时：**报告一个字都不改**（只提示，不弄乱）",
      String(afterBad) === BEFORE, JSON.stringify(String(afterBad).slice(0, 80)));

    /* ==================================================================
       ★ 合并按钮（第十批）：报告头「✨ AI 润色」= 建议段 + 错因列，**串行**两步
       ⚠️ 用工具自带的示例报告走**真实**的生成流程：合并按钮要润"建议段"，
          而建议段依赖生成报告时算好的诊断数据（`lastAdviceCtx`），
          所以不能像上面那样只塞一段合成文本。
       ================================================================== */
    const SETUP = BROWSER_SETUP;
    const READ = BROWSER_READ;
    const setup = await inTool(SETUP);
    record("（准备）生成一份真实报告（3 道错题，含错题分析表与建议段）",
      setup?.hasAttr === true && setup?.hasAdvice === true && setup?.zeroed === 3,
      JSON.stringify(setup));

    const polishBtn = await inTool(`
      const b = w.document.getElementById('btnPolishAll');
      return { label: b.textContent.trim(), title: b.title,
               hasAttrBtn: !!w.document.getElementById('btnAIPolishAttr'),
               hasAdviceBtn: !!w.document.getElementById('btnAIAdvice') };
    `);
    record("★报告头按钮文案写明「建议段+错因列」，且两个单独按钮都还在（想只润一个就点它）",
      /建议段\+错因列/.test(String(polishBtn?.label ?? "")) &&
        polishBtn?.hasAttrBtn === true && polishBtn?.hasAdviceBtn === true,
      JSON.stringify(polishBtn));

    /** 读报告：建议段是否已是桩文本、错因列有几行被润色（公共实现见文件上方 BROWSER_READ） */

    // ① 正常：一次点击 → 两次调用 → 两部分都变
    stubMode = "ok"; attrCalls = 0; calls.length = 0;
    await inTool(`w.document.getElementById('btnPolishAll').click(); return 'clicked';`);
    await sleep(3000);
    const both = await inTool(READ);
    record("★★合并按钮：点一次 → 上游被调 **2 次**（建议段 + 错因列各一次，串行）",
      calls.length === 2, `实际 ${calls.length} 次`);
    record("★★合并按钮：**两部分都润色了**（建议段换成 AI 文本；**有原因的那 3 道错题**最后一列都换成润色文案）",
      both?.adviceIsAI === true && both?.attrIsAI === 3,
      JSON.stringify({ 建议段是AI: both?.adviceIsAI, 润色行数: both?.attrIsAI, 表格总行数: both?.rows }));

    // ② 失败自动重试一次：让桩**第一次**少返回一行（段数不符 → 客户端重试 → 第二次成功）
    stubMode = "shortOnce"; attrCalls = 0; calls.length = 0;
    await inTool(`w.document.getElementById('btnGen').click(); return 'regenerated';`);   // 报告恢复成"没润过"
    await inTool(`w.document.getElementById('btnPolishAll').click(); return 'clicked';`);
    await sleep(4500);
    const retried = await inTool(READ);
    record("★★合并按钮：失败的那一步**自动重试一次**后成功（错因列被调 2 次、最终两部分都润色）",
      retried?.adviceIsAI === true && retried?.attrIsAI === 3 && attrCalls === 2 && calls.length === 3,
      JSON.stringify({ 上游总调用: calls.length, 错因列调用: attrCalls, 润色行数: retried?.attrIsAI }));

    // ③ 一半失败：错因列重试后仍失败 → **保留建议段的成果**，并如实告知
    stubMode = "short";
    await inTool(`w.document.getElementById('btnGen').click(); return 'regenerated';`);
    calls.length = 0;
    await inTool(`w.document.getElementById('btnPolishAll').click(); return 'clicked';`);
    await sleep(5500);
    const half = await inTool(READ);
    record("★★合并按钮：只成功一半时**保留成功的那部分**（建议段已是 AI 文本），错因列**一行都没动**",
      half?.adviceIsAI === true && half?.attrIsAI === 0 && half?.rows === 23,
      JSON.stringify({ 建议段是AI: half?.adviceIsAI, 润色行数: half?.attrIsAI, 表格行数: half?.rows,
                       首行: half?.rowSample }));
    record("★合并按钮：按钮上写明「有一步没成」且 title 里记着上次结果（用户知道下一步该做什么）",
      /没成/.test(String(half?.label ?? "")) && /建议段/.test(String(half?.title ?? "")) &&
        /错因列/.test(String(half?.title ?? "")),
      JSON.stringify({ label: half?.label, title: half?.title }));
    stubMode = "ok";

    try { await cdp.send("Browser.close"); } catch { /* ignore */ }
  }

  /* ======================================================================
     8. ★ 非会员点合并按钮：第一步就 403 → **不重试、也不再打第二步**（不白花调用）
     ====================================================================== */
  {
    const b2 = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-attr-free");
    edge = b2.edge;
    const { cdp: cdp2, sessionId: sid2 } = b2;
    const { inTool: inTool2, goto: goto2, login: login2 } = makePageApi(cdp2, sid2);

    record("免费账号在浏览器里登录成功", await login2(adminEmail, password));
    await goto2("/tools/paper-analysis", 5000);
    const setup2 = await inTool2(BROWSER_SETUP);
    record("（准备·免费账号）同样生成一份真实报告", setup2?.zeroed === 3, JSON.stringify(setup2));

    stubMode = "ok"; calls.length = 0;
    await inTool2(`w.document.getElementById('btnPolishAll').click(); return 'clicked';`);
    await sleep(3000);
    const free = await inTool2(BROWSER_READ);
    record("★★非会员点合并按钮：**上游一次都没被调**（第一步就被会员校验拦下，不重试也不打第二步）",
      calls.length === 0, `实际 ${calls.length} 次`);
    record("★非会员：报告一个字没改（AI 润色被拒不会弄乱报告）",
      free?.adviceIsAI === false && free?.attrIsAI === 0 && free?.rows === 23,
      JSON.stringify({ 建议段是AI: free?.adviceIsAI, 润色行数: free?.attrIsAI, 表格行数: free?.rows }));
    record("★非会员：错因列那一步被明确标成「未执行」（不让老师以为重试过了）",
      /未执行/.test(String(free?.title ?? "")), JSON.stringify(free?.title));

    try { await cdp2.send("Browser.close"); } catch { /* ignore */ }
  }
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
