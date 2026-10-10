#!/usr/bin/env node
/**
 * 试卷分析「答题卡识别」（vision-scores）**启用态**的回归测试
 *
 * 背景：这条路由与前端都完整（`src/app/api/paper-analysis/vision-scores/route.ts`），
 * 但**「配上 AI_VISION_MODEL 真正启用」那条路径从来没有被自动化跑过** ——
 * 现有测试只覆盖两条降级路径（未配模型 503、非会员 403）。
 * 也就是说：`AI_VISION_MODEL` 一配、开关一开，那段代码是**第一次真的执行**。
 *
 * 用户 2026-10 已实机自测「结果不错、符合预期」，所以本套件的定位是**防将来改坏**，
 * 尤其是那条最贵的护栏：**模型名不含 deepseek 就绝不能带 `thinking` 字段**
 * （给不认识这个专有字段的厂商发过去会直接 400）。
 *
 * 做法：起一个**本地桩**冒充 `{baseUrl}/chat/completions`，用已存在的
 * `AI_VISION_BASE_URL` 指过去 —— **不改一行业务代码**。
 *
 * 覆盖的 5 条（对应 docs/next-session-todo.md 第 3 条）：
 *   ① `content` 是数组、`image_url` 块在 **user** 消息里（system 只有纯文本）
 *   ② 模型名含 deepseek → 带 `thinking`；不含（如 glm-4v-flash）→ **不带**
 *   ③ 桩返回正常 JSON → `ok:true` 且 `scores` 正确
 *   ④ 桩返回**非 JSON** → `ok:true` + `scores:[]` + 带 `raw`（**不 500**）
 *   ⑤ 未配 `AI_VISION_MODEL` → 仍返回 503
 *
 * 跑法（需先 pnpm build）：
 *   & "<bundled node>" tests\vision-scores.test.mjs
 * ⚠️ 它会**杀 3000 端口**并起两次服务（阶段① 不配模型 / 阶段② 配桩），
 *    所以别和其它真服务套件同时跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder } from "./_helpers.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN =
  "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
/** 桩上游端口（⚠️ 别和 ai-thinking-mode 的 4586 撞） */
const STUB_PORT = 4587;
/** 最小的合法 data URL（路由只校验前缀 `data:image/`） */
const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const { record, summary } = makeRecorder();
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { userEmail, password } = readUsers(); // roleb = 会员版（本路由是会员专属）

const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
  return pid;
};

/* ==========================================================================
   本地桩：冒充 {baseUrl}/chat/completions
   ========================================================================== */
/** 每次请求的原始信息（用来断言请求体，以及确认「桩真的被打了」） */
const calls = [];
/** 桩的返回模式：ok（正常 JSON） / badjson（非 JSON） / upstream500（上游报错） */
let stubMode = "ok";

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 保留 null，断言时能看出来 */ }
    calls.push({ path: req.url, auth: req.headers.authorization ?? "", body });

    res.setHeader("content-type", "application/json");
    if (stubMode === "upstream500") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "stub upstream boom" } }));
      return;
    }
    const text = stubMode === "badjson"
      ? "抱歉，这道题我看不清分数，建议你人工填一下。"
      : '{"scores":[{"no":1,"got":5}]}';
    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

/* ==========================================================================
   起服务（两次：阶段① 不配视觉模型 / 阶段② 配桩）
   ========================================================================== */
/**
 * @param extraEnv  额外注入的环境变量
 * @param dropKeys  要从子进程环境里**删掉**的键（用来模拟「没配」）
 */
async function startServerWithEnv(extraEnv, dropKeys = []) {
  killPort3000();
  await sleep(1500);
  const env = { ...process.env, ...extraEnv };
  for (const k of dropKeys) delete env[k];
  const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore", env });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/login`)).status === 200) return srv; } catch { /* 等 */ }
  }
  return srv;
}

// VIP 会话 cookie（真登录）
const sess = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: userEmail, password }),
})).json();
if (!sess?.access_token) throw new Error("会员账号登录取会话失败");
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(sess)).toString("base64url")}`;

/** 打一次 vision-scores */
async function callVision(payload = {}) {
  const r = await fetch(`${BASE}/api/paper-analysis/vision-scores`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({
      image: IMG,
      questions: [{ no: 1, full: 5 }, { no: 2, full: 5 }],
      ...payload,
    }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

const srvA = await startServerWithEnv({ AI_KEY: "stub-key" }, ["AI_VISION_MODEL"]);

try {
  /* ======================================================================
     阶段①：未配 AI_VISION_MODEL → 必须仍然是 503（清单⑤）
     ⚠️ 这条是**降级路径**、本来就有覆盖（paper-analysis.test.mjs 第 6 节），
        放这里是为了让本套件**自己就能证伪**：一旦有人把它改成 500，
        或者把「未配模型」误判成「已启用」，这里立刻红。
     ====================================================================== */
  {
    const before = calls.length;
    const r = await callVision();
    record(
      "⑤ 未配 AI_VISION_MODEL → 仍返回 503，且提示明确指出未启用（不是 500/502）",
      r.status === 503 && r.body?.ok === false && /未启用|多模态/.test(r.body?.error ?? ""),
      `HTTP ${r.status} ${JSON.stringify(r.body?.error ?? r.body)}`,
    );
    record(
      "⑤ 未配模型时**根本不会去问上游**（桩一次都没被打）",
      calls.length === before,
      `桩被调用 ${calls.length - before} 次`,
    );
  }
} finally {
  if (srvA?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srvA.pid} -Force`], { encoding: "utf8" });
}

/* ======================================================================
   阶段②：配上 AI_VISION_MODEL=deepseek-flash + 桩上游 → 启用态（清单①②③④）
   ====================================================================== */
const srvB = await startServerWithEnv({
  AI_KEY: "stub-key",
  AI_VISION_MODEL: "deepseek-flash",
  AI_VISION_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
}, ["AI_VISION_SUPPORTS_THINKING"]);

try {
  /* ---------------------------------------------------------------- ③ 正常 JSON */
  stubMode = "ok";
  calls.length = 0;
  const okCall = await callVision();
  const b1 = calls.at(-1)?.body;

  record(
    "③ 桩返回正常 JSON → HTTP 200、ok:true 且 scores 解析正确",
    okCall.status === 200 && okCall.body?.ok === true &&
      JSON.stringify(okCall.body?.scores) === JSON.stringify([{ no: 1, got: 5 }]),
    `HTTP ${okCall.status} ${JSON.stringify(okCall.body)}`,
  );
  record(
    "③ 桩**真的被打了**（否则上面那条可能是假绿：请求根本没出网）",
    calls.length >= 1 && calls.at(-1)?.path === "/chat/completions",
    `桩收到 ${calls.length} 次，path=${JSON.stringify(calls.at(-1)?.path)}`,
  );
  record(
    "③ 带了会员 Key 的 Authorization 头（上游鉴权链路没断）",
    calls.at(-1)?.auth === "Bearer stub-key",
    JSON.stringify(calls.at(-1)?.auth ?? null),
  );

  /* ---------------------------------------------------------------- ① 消息结构 */
  {
    const msgs = Array.isArray(b1?.messages) ? b1.messages : [];
    const sys = msgs[0], usr = msgs[1];
    const imgBlocks = Array.isArray(usr?.content) ? usr.content.filter((c) => c?.type === "image_url") : [];
    record(
      "① 两条消息：system 在前、user 在后，且 user 的 content 是**数组**",
      msgs.length === 2 && sys?.role === "system" && usr?.role === "user" && Array.isArray(usr?.content),
      `roles=${JSON.stringify(msgs.map((m) => m?.role))} userContent=${Array.isArray(usr?.content) ? "数组" : typeof usr?.content}`,
    );
    record(
      "① system 只有**纯文本**（图片放 system 会 400 —— 官方要求）",
      typeof sys?.content === "string" && !JSON.stringify(sys).includes("image_url"),
      `system.content 类型=${typeof sys?.content}`,
    );
    record(
      "① `image_url` 块在 user 消息里，且图片 data URL **原样**透传（没被截断/改写）",
      imgBlocks.length === 1 && imgBlocks[0]?.image_url?.url === IMG,
      `image_url 块 ${imgBlocks.length} 个，url 长度=${String(imgBlocks[0]?.image_url?.url ?? "").length}（原图 ${IMG.length}）`,
    );
    record(
      "① user 里同时有 text 块（题目清单）与 image_url 块",
      Array.isArray(usr?.content) && usr.content.some((c) => c?.type === "text") &&
        typeof usr.content.find((c) => c?.type === "text")?.text === "string",
      JSON.stringify((usr?.content ?? []).map((c) => c?.type)),
    );
  }

  /* ---------------------------------------------------------------- ② thinking 护栏 */
  record(
    "② 模型名含 deepseek → 请求体**带** `thinking:{type:\"disabled\"}`（核心护栏，删了就复发）",
    b1?.thinking?.type === "disabled" && b1?.model === "deepseek-flash",
    `model=${JSON.stringify(b1?.model)} thinking=${JSON.stringify(b1?.thinking ?? null)}`,
  );
  record(
    "② max_tokens=6000（视觉模型也默认开思考，1500 会被吃光）",
    b1?.max_tokens === 6000,
    String(b1?.max_tokens),
  );
  {
    // 前端可以用 body.model 覆盖模型名 —— 这正是「必须按模型名判断」的原因
    calls.length = 0;
    const other = await callVision({ model: "glm-4v-flash" });
    const b2 = calls.at(-1)?.body;
    record(
      "② 模型名**不含** deepseek（glm-4v-flash）→ 请求体**不带** thinking 字段（无条件带会直接 400）",
      other.status === 200 && b2?.model === "glm-4v-flash" && !("thinking" in (b2 ?? {})),
      `HTTP ${other.status} model=${JSON.stringify(b2?.model)} hasThinking=${b2 ? "thinking" in b2 : "<无请求>"}`,
    );
  }

  /* ---------------------------------------------------------------- ④ 非 JSON 响应 */
  {
    stubMode = "badjson";
    calls.length = 0;
    const bad = await callVision();
    record(
      "④ 桩返回**非 JSON** → 仍是 HTTP 200 且 ok:true（**不 500**），scores 为空数组",
      bad.status === 200 && bad.body?.ok === true && Array.isArray(bad.body?.scores) && bad.body.scores.length === 0,
      `HTTP ${bad.status} ${JSON.stringify(bad.body)}`,
    );
    record(
      "④ 解析不出 JSON 时**带上 raw**（把模型原话交回前端，便于老师判断/人工补）",
      typeof bad.body?.raw === "string" && bad.body.raw.length > 0 && /看不清/.test(bad.body.raw),
      `raw=${JSON.stringify(String(bad.body?.raw ?? "").slice(0, 60))}`,
    );
  }

  /* ---------------------------------------------------------------- 附：上游报错仍走 502（不属于清单，只做兜底记录） */
  {
    stubMode = "upstream500";
    calls.length = 0;
    const up = await callVision();
    record(
      "附：上游 5xx → 502 且不透传上游原文（错误口径没变）",
      up.status === 502 && up.body?.ok === false && !/stub upstream boom/.test(JSON.stringify(up.body)),
      `HTTP ${up.status} ${JSON.stringify(up.body)}`,
    );
    stubMode = "ok";
  }
} finally {
  if (srvB?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srvB.pid} -Force`], { encoding: "utf8" });
  killPort3000();
  stub.close();
}

process.exit(summary() ? 0 : 1);
