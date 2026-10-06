#!/usr/bin/env node
/**
 * AI 路由「思考模式」修复的回归测试
 *
 * 背景（线上实测定位的根因）：
 *   `deepseek-flash` 默认开启思考模式，思考内容 `reasoning_content` 与正文**共享** max_tokens。
 *   线上真实失败样本：`finish_reason:"length", contentLen:0, reasoningLen:3414, inputChars:275`
 *   —— 输入才 275 字符，模型先想了 3414 字符，把 max_tokens 吃光，正文为空。
 *   同一个原因也导致「AI 润色很慢」。
 *
 * 本套件用**本地桩上游**钉住四件事：
 *   1. 请求体里确实带了 `thinking:{type:"disabled"}`（核心修复，删掉就复发）
 *   2. max_tokens 已提到 6000（不再是 2000/2800/3000/1500）
 *   3. 「思考吃光预算」时**自动重试一次**，并且重试后能拿到正文（不返回 502）
 *   4. 正常响应**不会**触发重试
 * 另外对比「一次调用 vs 两次调用」的耗时，作为「关掉思考能省多少」的量化参考。
 *
 * 跑法（需先 pnpm build）：
 *   & "<bundled node>" tests\ai-thinking-mode.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder } from "./_helpers.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN =
  "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const STUB_PORT = 4586;
const BASE = "http://127.0.0.1:3000";

const { record, summary } = makeRecorder();

const { SUPABASE_URL, ANON_KEY } = readEnv();
const { userEmail, password } = readUsers(); // roleb = 会员版

// ---------------------------------------------------------------- 桩上游
/** 每个 label 被请求了几次（用来判「有没有重试」） */
const hits = new Map();
/** 每次请求的原始 body（用来断言 thinking / max_tokens） */
const bodies = [];
/** 每次请求的耗时（模拟上游处理时间，用于对比「一次 vs 两次」） */
const ARTIFICIAL_DELAY_MS = 300;

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let label = "ok";
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
      const userMsg = parsed.messages?.[parsed.messages.length - 1]?.content ?? "";
      label = String(userMsg).trim().slice(0, 30) || "ok";
    } catch { /* 忽略 */ }
    bodies.push(parsed);
    const n = (hits.get(label) ?? 0) + 1;
    hits.set(label, n);

    await sleep(ARTIFICIAL_DELAY_MS); // 模拟上游处理耗时

    const truncated = {
      choices: [{
        finish_reason: "length",
        message: { role: "assistant", content: "", reasoning_content: "思考过程".repeat(200) },
      }],
      usage: { prompt_tokens: 300, completion_tokens: 6000, completion_tokens_details: { reasoning_tokens: 6000 } },
    };
    const okBody = (text) => ({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
      usage: { prompt_tokens: 300, completion_tokens: 120 },
    });

    res.setHeader("content-type", "application/json");
    if (label === "RETRY") {
      // 第一次：思考吃光预算；第二次：正常给正文
      res.end(JSON.stringify(n === 1 ? truncated : okBody("重试后拿到的正文。")));
    } else if (label === "ALWAYS_EMPTY") {
      res.end(JSON.stringify(truncated));
    } else {
      res.end(JSON.stringify(okBody("正常润色后的正文。")));
    }
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

// ---------------------------------------------------------------- 起服务
const pid = spawnSync("powershell", ["-NoProfile", "-Command",
  "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { encoding: "utf8" }).stdout.trim();
if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
await sleep(1500);

// ⚠️ AI_MODEL 必须是 deepseek-* —— 否则 thinkingDisabled() 会（正确地）不带 thinking 字段
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

// VIP 会话 cookie
const sess = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: userEmail, password }),
})).json();
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(sess)).toString("base64url")}`;

/** 打一次 feedback/ai，返回耗时与响应 */
async function callAi(label, text = label) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/feedback/ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ text, prompt: "润色这段" }),
  });
  const ms = Math.round(performance.now() - t0);
  const j = await r.json().catch(() => null);
  return { status: r.status, body: j, ms };
}

// ---------------------------------------------------------------- 1) 正常响应
const normal = await callAi("NORMAL");
record("正常响应：HTTP 200 且拿到正文", normal.status === 200 && normal.body?.ok === true, `HTTP ${normal.status} ${JSON.stringify(normal.body?.text ?? normal.body?.error)}`);
record("正常响应：**不**触发重试（上游只被调用 1 次）", hits.get("NORMAL") === 1, `调用 ${hits.get("NORMAL")} 次`);
record("正常响应：正文与桩返回一致", normal.body?.text === "正常润色后的正文。", String(normal.body?.text));

// ---------------------------------------------------------------- 2) 请求体断言（核心修复）
const lastBody = bodies[bodies.length - 1];
record(
  "★请求体带上了 thinking:{type:\"disabled\"}（核心修复，删掉就会复发）",
  lastBody?.thinking?.type === "disabled",
  JSON.stringify(lastBody?.thinking ?? null),
);
record("★max_tokens 已提到 6000（not 2000）", lastBody?.max_tokens === 6000, String(lastBody?.max_tokens));
record("model 透传正确", lastBody?.model === "deepseek-flash", String(lastBody?.model));

// ---------------------------------------------------------------- 3) 兜底重试
const retry = await callAi("RETRY", "RETRY");
record("思考吃光预算：**不**返回 502，而是拿到重试后的正文", retry.status === 200 && retry.body?.text === "重试后拿到的正文。", `HTTP ${retry.status} text=${JSON.stringify(retry.body?.text ?? retry.body?.error)}`);
record("★重试确实被触发（上游被调用 2 次）", hits.get("RETRY") === 2, `调用 ${hits.get("RETRY")} 次`);

// ---------------------------------------------------------------- 4) 重试后仍为空 → 报错并留日志
const always = await callAi("ALWAYS_EMPTY", "ALWAYS_EMPTY");
record("重试后仍为空：返回 502（不静默返回空文本）", always.status === 502 && always.body?.ok === false, `HTTP ${always.status} ${JSON.stringify(always.body?.error)}`);
record("重试后仍为空：重试只做一次（上游共 2 次，不无限重试）", hits.get("ALWAYS_EMPTY") === 2, `调用 ${hits.get("ALWAYS_EMPTY")} 次`);

// ---------------------------------------------------------------- 5) 耗时（只记录，不做断言）
// ⚠️ 这里**故意不断言**「谁比谁快」。实测踩过：第一次调用会吸收 Next 的冷启动，
//    于是「1 次调用」反而比「2 次调用」慢（2261ms vs 1330ms）—— 量到的是脚手架噪声，
//    不是修复效果。真实提速来自**不再生成 3414 个思考 token**，那只能由真 Key 上线验证。
//    所以毫秒只打印给人看；能不能拦住退化由上面的**调用次数**断言负责。
console.log(
  `\n   耗时参考（桩每次固定延迟 ${ARTIFICIAL_DELAY_MS}ms，含冷启动噪声，不作判据）：` +
  `正常 1 次调用 ${normal.ms}ms / 触发重试 2 次调用 ${retry.ms}ms`,
);
record(
  "重试的代价被量化（多一次上游往返，且仅此一次）",
  hits.get("RETRY") === 2 && hits.get("NORMAL") === 1,
  `NORMAL=${hits.get("NORMAL")} 次 / RETRY=${hits.get("RETRY")} 次`,
);

// ---------------------------------------------------------------- 收尾
spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
stub.close();
process.exit(summary() ? 0 : 1);
