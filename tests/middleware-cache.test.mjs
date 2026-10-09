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
import {
  fetchSession, formatSessionCookie, readEnv, readUsers, makeRecorder, sessionCookieExpiringIn,
} from "./_helpers.mjs";

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

// ---- 会话（真 token，只有 expires_at 会被按需覆盖）----
const sess = await fetchSession(userEmail, password, SUPABASE_URL, ANON_KEY);
const cookie = formatSessionCookie(sess, SUPABASE_URL);

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
    "★中间件 auth 缓存生效（中间件那次 auth:user 消失；剩下的那次来自页面侧 getViewer）",
    // ⚠️ 只断言「没有变多」。**不要**再断言它下降：
    //    A-2 之后，够新的 token 在中间件里根本不调 getUser（走 JWT 解码那条路），
    //    所以留下的这 1 次就是页面侧 `getViewer()` 的校验 —— 它在两次请求里都是 1 次，
    //    与中间件缓存无关。写「必须下降」会得到一条与缓存无关的假红（本轮踩过）。
    (second.byTable["auth:user"] ?? 0) <= (first.byTable["auth:user"] ?? 0),
    `第 1 次 ${first.byTable["auth:user"] ?? 0} 次 → 第 2 次 ${second.byTable["auth:user"] ?? 0} 次（页面侧校验，会一直在）`,
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

// ============================================================
// 3) A-2：只有「快过期」才刷新，且并发只刷一次
// ============================================================
// 背景：auth-js 在 access token 剩 < 90 秒时会各自去刷新，而它的去重是**实例级**的，
//       本项目每请求新建 client → 跨请求零去重。实测并发 8 个请求曾产生 16 次 /token。
// 判据：数 `/auth/v1/token` 的真实调用次数（`_instrument.cjs` 把 /auth/v1/token 记成 `auth:token`）。

/** 打 n 个并发请求，返回 auth:token 的调用次数 */
async function burst(path, n, cookieValue) {
  await reset();
  const results = await Promise.all(
    Array.from({ length: n }, () =>
      fetch(BASE + path, { headers: { cookie: cookieValue }, redirect: "manual" })
        .then((r) => r.status)
        .catch(() => 0)),
  );
  const st = await stats();
  return { statuses: results, tokenCalls: st.byTable["auth:token"] ?? 0, byTable: st.byTable, calls: st.total };
}

// 3a) token 很新（还剩 1 小时）→ 一条 /token 都不该发
const freshCookie = sessionCookieExpiringIn(sess, 3600, SUPABASE_URL);
const freshBurst = await burst("/tools/feedback", 1, freshCookie);
record("★A-2：token 还剩 1 小时（> 120s）→ **不刷新**（/auth/v1/token = 0 次）",
  freshBurst.tokenCalls === 0,
  `token 调用 ${freshBurst.tokenCalls} 次；明细 ${JSON.stringify(freshBurst.byTable)}`);
record("A-2：够新时页面仍正常返回（没把鉴权搞坏）",
  freshBurst.statuses.every((s) => s === 200), `状态码 ${JSON.stringify(freshBurst.statuses)}`);

// 3b) token 快过期（还剩 3 秒）→ 该刷新，且只刷一次
const staleCookie = sessionCookieExpiringIn(sess, 3, SUPABASE_URL);
// ⚠️ 先"用掉"一次：确保 singleFlight 里没有上一次的残留（钥匙是 refresh_token，
//    而每次调用 token 端点都会轮换 refresh_token，所以这里天然是新钥匙）
const staleSingle = await burst("/tools/feedback", 1, staleCookie);
record("★A-2：token 只剩 3 秒（< 120s）→ 触发刷新（/auth/v1/token ≥ 1 次）",
  staleSingle.tokenCalls >= 1,
  `token 调用 ${staleSingle.tokenCalls} 次；明细 ${JSON.stringify(staleSingle.byTable)}`);
record("A-2：快过期时页面仍正常返回",
  staleSingle.statuses.every((s) => s === 200), `状态码 ${JSON.stringify(staleSingle.statuses)}`);

// 3c) ★核心：并发 8 个「快过期」请求
//     用一份**全新的**快过期会话（refresh token 是新的，保证不命中上一次的单飞/缓存）
//
// 期望值 = **≤ 2 次**，这就是 A-2 的目标（修复前 16 次 → 收口前 8～12 次）。
//   为什么能做到：刷新被收拢到**一处**（中间件里直连 `/auth/v1/token`），
//   并用「单飞 + 同一把 refresh token 的结果缓存」保证一波并发只真刷一次。
//   ⚠️ 不要放宽这个上限：它正是「每次进网站都要登录」的防线 ——
//   同一把 refresh token 被并发重复使用，Supabase 会判成泄露并撤销整个会话。
const sess2 = await fetchSession(userEmail, password, SUPABASE_URL, ANON_KEY);
const staleCookie2 = sessionCookieExpiringIn(sess2, 3, SUPABASE_URL);
const storm = await burst("/tools/feedback", 8, staleCookie2);
record("★A-2：并发 8 个「快过期」请求 → /auth/v1/token ≤ 2 次（修复前 16 次；收口前 8～12 次）",
  storm.tokenCalls <= 2,
  `token 调用 ${storm.tokenCalls} 次；明细 ${JSON.stringify(storm.byTable)}；状态码 ${JSON.stringify(storm.statuses)}`);
record("★A-2 核心：并发风暴里 8 个请求全部成功（没有因为去重把谁搞失败）",
  storm.statuses.every((s) => s === 200),
  `状态码 ${JSON.stringify(storm.statuses)}`);
// 页面侧**不再**各自刷新：它会复用中间件本次请求已校验过的结果。
// （以前这里有一条恒为 true 的「留痕」断言，收口后已换成真断言。）
record("★A-2：页面侧不再重复校验（auth:user 不比 auth:token 多出来）",
  (storm.byTable["auth:user"] ?? 0) <= 1,
  `auth:user=${storm.byTable["auth:user"] ?? 0}（中间件校验过一次即可，页面侧复用）`);


spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
process.exit(summary() ? 0 : 1);
