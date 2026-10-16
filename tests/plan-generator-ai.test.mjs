// 「辅导方案生成器」AI 生成教学目标 · 回归测试
//
// 三层，一层比一层真：
//   ① **纯函数**：`buildGoalsMessages()` 的提示词结构与内容（不用服务、秒级）
//   ② **静态契约**：路由源码上的护栏（护栏写丢了不会报错，只会静默漏掉 —— 必须钉住）
//   ③ **真服务 + 桩上游**：起 next start（AI_BASE_URL 指向本地桩），用真会员 cookie 调接口，
//      验证鉴权码、行数契约、上游错误不透传、思考模式关闭、Key 不回传
//
// ⚠️ 这一套会**自己起 next start 并杀掉 3000 端口**，所以必须独占跑（一次只跑一个 runner）。
//
// 跑法：& <bundled node> tests\plan-generator-ai.test.mjs   （跑之前先 pnpm build）
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = join(ROOT, "src/app/api/plan-generator/ai/route.ts");
const PROMPTS = join(ROOT, "src/app/api/plan-generator/ai/prompts.ts");
const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = join(ROOT, "node_modules/next/dist/bin/next");
const BASE = "http://127.0.0.1:3000";
const STUB_PORT = 4571;

const results = [];
const ok = (name, cond, detail) => {
  const pass = !!cond;
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

/* ==========================================================================
   ① 纯函数：提示词
   ========================================================================== */
// prompts.ts 是 TS，Node 直接 require 不了 ⇒ 用 tsc 编译到临时目录再 require
const tsc = join(ROOT, "node_modules/typescript/bin/tsc");
const OUT = join(ROOT, ".tmp-planning-samples/plangen-ai-out");
const tscRun = spawnSync(NODE_BIN, [
  tsc, PROMPTS,
  "--outDir", OUT, "--module", "commonjs", "--target", "es2022",
  "--skipLibCheck", "--moduleResolution", "node",
], { encoding: "utf8" });
if (tscRun.status !== 0) {
  console.error("tsc 编译 prompts.ts 失败：", tscRun.stdout || tscRun.stderr);
  process.exit(2);
}
const P = require(join(OUT, "prompts.js"));

const twoRows = [
  { name: "运动的描述", term: "必修一", lv: 1, stageName: "一轮·力学", chapters: ["1.1质点 参考系", "1.2时间 位移"], content: "1.1质点 参考系 1.2时间 位移" },
  { name: "力学实验", term: "必修一", lv: 2, stageName: "一轮·力学", chapters: ["研究匀变速直线运动"], content: "研究匀变速直线运动", hasExperiment: true },
];
const built = P.buildGoalsMessages({
  subjectName: "物理", stage: "senior", grade: "高三", bandName: "提中档",
  score: 62, targetScore: 85, totalHours: 100, rows: twoRows,
});

ok("①-1 人设按「学段 × 学科」参数化（高中物理老师，不是「高中数学」）",
  built.messages[0].content.indexOf("高中物理教师") >= 0
  && built.messages[0].content.indexOf("数学") < 0,
  built.messages[0].content.slice(0, 60));

const jr = P.buildGoalsMessages({ subjectName: "物理", stage: "junior", grade: "九年级", bandName: "补基础", rows: twoRows });
ok("①-2 换学段 ⇒ 人设与措辞规则跟着换（初中：末尾「重点：」；高中：末尾「重点与难点：」+「分值：」）",
  jr.messages[0].content.indexOf("初中物理教师") >= 0
  && jr.messages[0].content.indexOf("重点：") >= 0
  && built.messages[0].content.indexOf("重点与难点：") >= 0
  && built.messages[0].content.indexOf("分值：") >= 0);

ok("①-3 换学科名也生效（同一个函数，化学/语文不用改代码）",
  P.buildGoalsMessages({ subjectName: "化学", stage: "senior", grade: "高三", rows: twoRows })
    .messages[0].content.indexOf("高中化学教师") >= 0);

ok("①-4 硬性约束在提示词里：「只写教学目标」+「不许编造章节/考点」",
  built.messages[0].content.indexOf("只写教学目标") >= 0
  && built.messages[0].content.indexOf("不许编造") >= 0);

ok("①-5 量化指标表（三档 × 三个难度）逐行写进提示词",
  ["≥70%", "≥80%", "≥85%", "≥60%", "≥75%", "≥50%"].every((x) => built.messages[0].content.indexOf(x) >= 0));

ok("①-6 行数契约写进提示词（「行数必须正好等于条数」「多写少写都算失败」）",
  built.messages[0].content.indexOf("行数必须正好等于") >= 0
  && built.messages[0].content.indexOf("多写一行或少写一行") >= 0);

// 用户要求"让 AI 写得像老师" ⇒ few-shot 必须是**真实样例**，且带上"不要照抄"的说明
const assistantMsgs = built.messages.filter((m) => m.role === "assistant");
ok("①-7 带了 few-shot 风格示例（真实老师写的目标），且注明「只是风格示范、不要照抄内容」",
  assistantMsgs.length >= 2
  && built.messages.some((m) => m.role === "user" && m.content.indexOf("风格示范") >= 0)
  && assistantMsgs.every((m) => m.content.indexOf("重点") >= 0),
  `assistant 条数=${assistantMsgs.length}`);

ok("①-8 每条的教材小节**逐字**出现在 user 消息里（模型只能认这些，编不了别的）",
  built.messages[built.messages.length - 1].content.indexOf("1.1质点 参考系；1.2时间 位移") >= 0
  && built.messages[built.messages.length - 1].content.indexOf("研究匀变速直线运动") >= 0);

ok("①-9 含学生实验的模块被标注出来（好让目标里出现实验相关分点）",
  built.messages[built.messages.length - 1].content.indexOf("含学生实验") >= 0);

ok("①-10 用户信息（年级/档位/分数/目标分/总课时）都传进去了",
  (() => {
    const last = built.messages[built.messages.length - 1].content;
    return ["高三", "提中档", "62", "85", "100"].every((x) => last.indexOf(x) >= 0);
  })());

ok("①-11 条数 = 模块数（提示词里逐条编号，与行数契约对得上）",
  (() => {
    const last = built.messages[built.messages.length - 1].content;
    return last.indexOf("第1条") >= 0 && last.indexOf("第2条") >= 0 && last.indexOf("第3条") < 0;
  })());

/* ---------- ①-12 学科参数化（2026-10 扩到四学科时新增）----------
   ⚠️ 每个学科的老师**写法不一样**，这不是我编的 —— 是从各自真实样例里看出来的：
     物理「知道/理解/掌握」+「重点与难点：」；数学"会算会判断"；
     英语「语言模块：…；语法模块：…」两段式；语文「知识点：…；目标：…」两段式。
   判据用"该学科的特征串"是否出现 —— 换学科只改 prompts.ts，别的地方不用动。 */
const SUBJ_CASES = [
  { subject: "物理", stage: "senior", must: ["重点与难点：", "分值："], label: "物理·高中" },
  { subject: "物理", stage: "junior", must: ["重点："], label: "物理·初中" },
  { subject: "数学", stage: "junior", must: ["会算、会判断"], label: "数学·初中" },
  { subject: "英语", stage: "junior", must: ["语言模块", "语法模块"], label: "英语·初中" },
  { subject: "英语", stage: "senior", must: ["核心词汇与重点句型", "语法要点"], label: "英语·高中" },
  { subject: "语文", stage: "senior", must: ["知识点：", "目标："], label: "语文·高中" },
  { subject: "语文", stage: "junior", must: ["知识点：", "目标："], label: "语文·初中" },
];
{
  let allOk = true;
  const detail = [];
  for (const c of SUBJ_CASES) {
    const b = P.buildGoalsMessages({
      subjectName: c.subject, stage: c.stage, grade: "高三", bandName: "提中档",
      rows: [{ name: "信息类文本阅读", term: "一轮", lv: 2, stageName: "一轮专题复习",
        chapters: ["客观题命题陷阱与答题技巧"] }],
    });
    const sys = b.messages[0].content;
    const okAll = c.must.every((m) => sys.indexOf(m) >= 0)
      && sys.indexOf("高中" + c.subject + "教师") + sys.indexOf("初中" + c.subject + "教师") >= -1;
    if (!okAll) { allOk = false; detail.push(c.label); }
  }
  ok("①-12 四个学科的话术规则**各按各的样例参数化**（英语两段式 / 语文两段式 / 数学会算会判断）",
    allOk, allOk ? "全部命中特征串" : "未命中：" + detail.join("、"));
}
{
  // few-shot 也要按学科换（不能拿物理的目标去示范语文）
  const en = P.buildGoalsMessages({
    subjectName: "英语", stage: "junior", grade: "九年级", rows: twoRows,
  });
  const enFirst = en.messages.filter((m) => m.role === "assistant")[0].content;
  const ph = P.buildGoalsMessages({
    subjectName: "物理", stage: "senior", grade: "高三", rows: twoRows,
  });
  const phFirst = ph.messages.filter((m) => m.role === "assistant")[0].content;
  ok("①-13 few-shot 风格范例**按学科换**（英语示范是「语言模块…」而不是物理那套）",
    enFirst.indexOf("语言模块") >= 0 && phFirst.indexOf("质点") >= 0,
    "英:" + enFirst.slice(0, 16) + " / 物:" + phFirst.slice(0, 16));
}
{
  // 还没做科目包的学科（如化学）要**安全退回物理模板**，不能崩、也不能空
  const ch = P.buildGoalsMessages({ subjectName: "化学", stage: "senior", grade: "高三", rows: twoRows });
  ok("①-14 未接入的学科（化学）安全退回默认规则，提示词非空且含硬性约束",
    ch.messages[0].content.indexOf("硬性约束") >= 0 && ch.messages.length >= 3);
}

/* ==========================================================================
   ② 静态契约：路由源码上的护栏
   ========================================================================== */
const routeSrc = readFileSync(ROUTE, "utf8");
/** 去掉注释再断言（坑 15 的教训：注释里提到某个名字是正常的） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const code = stripComments(routeSrc);

ok("②-1 路由挂了 requireVip（未登录 401 / 封禁 403 / 非会员 403）",
  code.indexOf("requireVip") >= 0 && code.indexOf("unauthenticated") >= 0
  && code.indexOf("banned") >= 0);
ok("②-2 没有 AI_KEY 时返回 503（不是 500、也不是把 Key 缺失当业务错误）",
  code.indexOf("process.env.AI_KEY") >= 0 && code.indexOf("503") >= 0);
ok("②-3 关闭思考模式（否则 reasoning 吃光 max_tokens、正文为空）",
  code.indexOf("thinkingDisabled") >= 0 && code.indexOf("truncatedByReasoning") >= 0);
ok("②-4 行数对不上就**拒绝**（防止把 A 模块的目标贴到 B 模块上）",
  code.indexOf("lines.length !== expectLines") >= 0);
ok("②-5 **不透传**上游错误原文（前端只说一句「暂时不可用」）",
  code.indexOf('"AI 服务暂时不可用，请稍后重试。"') >= 0
  && code.indexOf("(await res.text()).slice(0, 300)") >= 0);
ok("②-6 绝不把 Key 回传给前端（响应体里不出现 apiKey）",
  !/NextResponse\.json\([^)]*apiKey/.test(code));
ok("②-7 默认模型是现行的 deepseek-flash（不是已停用的 deepseek-chat）",
  code.indexOf('"deepseek-flash"') >= 0 && code.indexOf("deepseek-chat") < 0);
ok("②-8 只生成「教学目标」，路由里没有「让模型写内容」的分支",
  code.indexOf("goals") >= 0 && !/generateContent|writeContent/.test(code));

/* ==========================================================================
   ③ 真服务 + 桩上游
   ========================================================================== */
console.log("");
console.log("起桩上游 + next start（会占用 3000 与 " + STUB_PORT + "）…");

/** 桩上游的行为可由 `stubMode` 控制 */
let stubMode = "ok";              // ok | mismatch | empty | upstream500
const captured = [];
const stub = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    captured.push({ headers: req.headers, model: body?.model, messages: body?.messages, thinking: body?.thinking });

    if (stubMode === "upstream500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "桩上游故意报错：key 是 sk-SECRET-DO-NOT-LEAK" } }));
      return;
    }
    const msgs = body?.messages ?? [];
    const last = msgs[msgs.length - 1]?.content ?? "";
    const n = (last.match(/^第\d+条/gm) || []).length;
    let content;
    if (stubMode === "mismatch") {
      content = Array.from({ length: n + 1 }, (_, i) => `桩目标${i + 1}：掌握相关规律．重点与难点：图像分析．分值：4 分到 8 分`).join("\n");
    } else if (stubMode === "empty") {
      content = "";
    } else {
      // ⚠️ 故意带上「1. 」「第1条：」这类前缀 + 前后引号，验证清洗逻辑
      content = Array.from({ length: n }, (_, i) =>
        `${i + 1}. "桩目标${i + 1}：掌握模块${i + 1}的核心规律，正确率≥85%．重点与难点：图像分析．分值：高考必考，4 分到 8 分"`,
      ).join("\n");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

function killPort3000() {
  const pid = spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
    { encoding: "utf8" }).stdout.trim();
  if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
}

// —— 用 Supabase 换一个可直接塞进请求头的会话 cookie（照 paper-analysis.test.mjs 的做法）
const env = readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/);
const SUPABASE_URL = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const ANON_KEY = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync(join(ROOT, ".test-users.json"), "utf8"));
const vipEmail = info.users.find((u) => u.email.startsWith("roleb-")).email;
const PASSWORD = info.password;

async function signInCookie(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const s = await r.json();
  if (!s.access_token) throw new Error("登录失败：" + JSON.stringify(s).slice(0, 200));
  return `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token=${encodeURIComponent(JSON.stringify(s))}`;
}

let srv = null;
let vipCookie = null;
const ai = (body, init = {}) => fetch(`${BASE}/api/plan-generator/ai`, {
  method: "POST",
  ...init,
  headers: { "Content-Type": "application/json", ...(vipCookie ? { cookie: vipCookie } : {}), ...(init.headers ?? {}) },
  body: JSON.stringify(body),
});

const REQ = {
  subject: "physics", subjectName: "物理", stage: "senior", grade: "高三",
  bandName: "提中档", score: 62, targetScore: 85, totalHours: 100,
  rows: twoRows,
};

try {
  killPort3000();
  await sleep(2000);
  srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], {
    cwd: ROOT, stdio: "ignore",
    env: { ...process.env, AI_KEY: "sk-local-stub-not-real", AI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1` },
  });
  let up = false;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch { /* 等 */ }
  }
  ok("③-1 next start 起来了（新路由已进构建）", up);
  if (!up) throw new Error("服务没起来（是不是忘了 pnpm build？）");

  // ---- 未登录：401 ----
  const anon = await fetch(`${BASE}/api/plan-generator/ai`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(REQ),
  });
  ok("③-2 未登录 → 401", anon.status === 401, `status=${anon.status}`);

  // ---- 免费账号（rolea 是 admin 但非会员）：403 ----
  const freeCookie = await signInCookie(info.users.find((u) => u.email.startsWith("rolea-")).email);
  const freeRes = await fetch(`${BASE}/api/plan-generator/ai`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: freeCookie }, body: JSON.stringify(REQ),
  });
  ok("③-3 非会员 → 403（AI 生成是会员专属）", freeRes.status === 403, `status=${freeRes.status}`);

  // ---- 会员正常路径 ----
  vipCookie = await signInCookie(vipEmail);
  captured.length = 0;
  stubMode = "ok";
  const r200 = await ai(REQ);
  const d200 = await r200.json();
  ok("③-4 会员 → 200，返回 ok:true 与 goals 数组", r200.status === 200 && d200.ok === true && Array.isArray(d200.goals),
    `status=${r200.status} goals=${d200.goals && d200.goals.length}`);
  ok("③-5 行数契约：返回条数 = 模块数（2 条）", d200.goals && d200.goals.length === 2,
    JSON.stringify(d200.goals));
  ok("③-6 行首编号与包裹引号被清掉（只留正文）",
    d200.goals && d200.goals.every((g) => g.indexOf("1. ") !== 0 && g[0] !== '"'),
    d200.goals && d200.goals[0]);

  const up1 = captured[captured.length - 1];
  ok("③-7 真的打到了桩上游，且**关掉了思考模式**（body.thinking.type = disabled）",
    captured.length > 0 && up1.thinking && up1.thinking.type === "disabled",
    JSON.stringify(up1.thinking));
  ok("③-8 上游请求带的是服务端读到的 Key（Authorization: Bearer sk-local-stub-not-real）",
    up1.headers.authorization === "Bearer sk-local-stub-not-real", String(up1.headers.authorization));
  ok("③-9 发给上游的 messages 里有 system + few-shot + 本次 user",
    Array.isArray(up1.messages) && up1.messages[0].role === "system"
    && up1.messages.filter((m) => m.role === "assistant").length >= 2);

  // ---- 行数不匹配：502，且**不把内容贴出去** ----
  stubMode = "mismatch";
  const rMis = await ai(REQ);
  const dMis = await rMis.json();
  ok("③-10 上游返回条数多一条 → 502 拒绝（不贴错位的目标）",
    rMis.status === 502 && dMis.ok === false && String(dMis.error).indexOf("条数") >= 0,
    `status=${rMis.status} error=${dMis.error}`);

  // ---- 上游 500：不透传原文（里面塞了假 key） ----
  stubMode = "upstream500";
  const r500 = await ai(REQ);
  const d500 = await r500.json();
  ok("③-11 上游报错 → 502，且响应里**不出现**上游原文（假 key 不泄漏）",
    r500.status === 502 && JSON.stringify(d500).indexOf("sk-SECRET") < 0
    && JSON.stringify(d500).indexOf("桩上游故意报错") < 0,
    JSON.stringify(d500));

  // ---- 上游 200 但正文为空：502 ----
  stubMode = "empty";
  const rE = await ai(REQ);
  const dE = await rE.json();
  ok("③-12 上游 200 但正文为空 → 502（并提示重试）",
    rE.status === 502 && dE.ok === false, `status=${rE.status} error=${dE.error}`);

  // ---- Key 永不回传 ----
  stubMode = "ok";
  const rKey = await ai(REQ);
  const rawKey = await rKey.text();
  ok("③-13 响应正文里绝不出现 AI Key", rawKey.indexOf("sk-local-stub-not-real") < 0);

  // ---- 入参校验 ----
  const noRows = await ai({ ...REQ, rows: [] });
  ok("③-14 空 rows → 400", noRows.status === 400, `status=${noRows.status}`);
  const badRow = await ai({ ...REQ, rows: [{ name: "" }] });
  ok("③-15 有条目没有模块名 → 400（不把空行喂给模型）", badRow.status === 400, `status=${badRow.status}`);
  const badStage = await ai({ ...REQ, stage: "university" });
  ok("③-16 学段不合法 → 400", badStage.status === 400, `status=${badStage.status}`);
  const tooMany = await ai({ ...REQ, rows: Array.from({ length: 130 }, (_, i) => ({ name: "m" + i })) });
  ok("③-17 一次超过 120 条 → 413（要求分批）", tooMany.status === 413, `status=${tooMany.status}`);
  const badJson = await fetch(`${BASE}/api/plan-generator/ai`, {
    method: "POST", headers: { "Content-Type": "application/json", cookie: vipCookie }, body: "{不是 JSON",
  });
  ok("③-18 请求体不是合法 JSON → 400", badJson.status === 400, `status=${badJson.status}`);

  // ---- 单条重写（老师对某一行不满意时的用法）----
  stubMode = "ok";
  const one = await ai({ ...REQ, rows: [twoRows[0]] });
  const dOne = await one.json();
  ok("③-19 只传 1 条也能用（这是「这一行 AI 重写」按钮的用法）",
    one.status === 200 && dOne.ok === true && dOne.goals.length === 1,
    JSON.stringify(dOne.goals));
} catch (e) {
  ok("③ 真服务测试段未异常中断", false, String(e && e.message ? e.message : e));
} finally {
  try { stub.close(); } catch { /* ignore */ }
  if (srv) { try { srv.kill(); } catch { /* ignore */ } }
  killPort3000();
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
console.log("=".repeat(78));
process.exit(passed === total ? 0 : 1);
