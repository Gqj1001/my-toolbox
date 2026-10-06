#!/usr/bin/env node
/**
 * 中间件（src/proxy.ts）进程内短 TTL 缓存的回归测试
 *
 * 为什么必须有这个文件：
 *   中间件缓存是「模块级变量跨请求存活」这一假设的产物。这个假设**一旦不成立**
 *   （比如 Next 换了中间件运行时、或部署形态变成每个请求一个新 isolate），
 *   代码不会报错、功能也正常，只是**静默地失去全部收益** —— 没有任何迹象。
 *   而用户体感的 5–6 秒白屏正是这些往返造成的。所以必须用测试钉住「第 2 次真的少了查询」。
 *
 * 断言方式：用 `tests/_instrument.cjs` 数走向 Supabase 的真实请求次数
 *   （照 docs/perf-notes.md 的原则：**看调用次数，不看毫秒**），
 *   连续请求同一个受保护页面，比较第 1 次与第 2 次的
 *   `auth:user` / `user_roles` 次数。
 *
 * 跑法（需先 pnpm build）：
 *   & "<bundled node>" tests\middleware-cache.test.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder } from "./_helpers.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN =
  "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const INSTRUMENT = `${PROJECT}\\tests\\_instrument.cjs`;
const COUNTER = "http://127.0.0.1:4599";
const BASE = "http://127.0.0.1:3000";

const { record, summary } = makeRecorder();
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { userEmail, password } = readUsers(); // roleb

const stats = async () => (await fetch(`${COUNTER}/stats`)).json();
const reset = () => fetch(`${COUNTER}/reset`, { method: "POST" });

// ---- 起服务（带插桩；环境变量可用 EXTRA_ENV 覆盖，用于测「关掉缓存」） ----
const pid = spawnSync("powershell", ["-NoProfile", "-Command",
  "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"], { encoding: "utf8" }).stdout.trim();
if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
await sleep(1500);

const extraEnv = process.env.MW_TEST_TTL ? { MIDDLEWARE_CACHE_TTL: process.env.MW_TEST_TTL } : {};
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], {
  cwd: PROJECT,
  stdio: "ignore",
  env: { ...process.env, ...extraEnv, NODE_OPTIONS: `--require=${INSTRUMENT}` },
});
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch { /* 等 */ }
}

// ---- 会话 cookie ----
const sess = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: userEmail, password }),
})).json();
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(sess)).toString("base64url")}`;

async function hit(path) {
  await reset();
  const r = await fetch(BASE + path, { headers: { cookie } });
  const st = await stats();
  return { status: r.status, calls: st.total, byTable: st.byTable };
}

const TTL_DISABLED = process.env.MW_TEST_TTL === "0";

// ---------- 1) 受保护页面：第 2 次应少掉中间件的两次查询 ----------
const first = await hit("/tools/feedback");
const second = await hit("/tools/feedback");
console.log(
  `   第 1 次 [${Object.keys(first.byTable).join(",")}] 共 ${first.calls} 次\n` +
  `   第 2 次 [${Object.keys(second.byTable).join(",")}] 共 ${second.calls} 次`,
);

record("两次请求都成功（缓存没有把鉴权搞坏）", first.status === 200 && second.status === 200, `${first.status} / ${second.status}`);

if (TTL_DISABLED) {
  // MIDDLEWARE_CACHE_TTL=0：应当回到「每次都查」的行为
  record(
    "★关闭开关（MIDDLEWARE_CACHE_TTL=0）：第 2 次仍会查 user_roles（说明开关真的能关掉缓存）",
    (second.byTable["user_roles"] ?? 0) >= 1,
    `user_roles=${second.byTable["user_roles"] ?? 0}`,
  );
} else {
  record(
    "★中间件 user_roles 缓存生效：第 2 次不再查 user_roles",
    (second.byTable["user_roles"] ?? 0) === 0,
    `第 1 次 ${first.byTable["user_roles"] ?? 0} 次 → 第 2 次 ${second.byTable["user_roles"] ?? 0} 次`,
  );
  record(
    "★中间件 auth 缓存生效：auth:user 次数下降（剩下的那次来自页面侧 getViewer）",
    (second.byTable["auth:user"] ?? 0) < (first.byTable["auth:user"] ?? 0),
    `第 1 次 ${first.byTable["auth:user"] ?? 0} 次 → 第 2 次 ${second.byTable["auth:user"] ?? 0} 次`,
  );
  record(
    "第 2 次出网次数明显少于第 1 次",
    second.calls < first.calls,
    `${first.calls} → ${second.calls}`,
  );
}

// ---------- 2) 保护性：缓存没有削弱鉴权 ----------
const anon = await fetch(`${BASE}/tools/feedback`, { redirect: "manual" });
record("未登录访问仍被拦（重定向，不是 200）", anon.status === 307 || anon.status === 302, `HTTP ${anon.status}`);

const anonHtml = await fetch(`${BASE}/tools/feedback.html`, { redirect: "manual" });
record("未登录取工具 HTML 仍被拦（307）", anonHtml.status === 307, `HTTP ${anonHtml.status}`);

spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
process.exit(summary() ? 0 : 1);
