/**
 * 会话「够不够新」的判断 + **中间件与页面侧共享**的进程内缓存（A-2 后半场）。
 *
 * 这个文件解决两件事，都源自同一个根因：**同一把 refresh token 被并发使用**，
 * 被 Supabase 判成「token 泄露」→ 撤销整个会话 → 用户体感「每次进网站都要登录」。
 *
 * ────────────────────────────────────────────────────────────
 * 一、为什么中间件与页面侧可以共用一份缓存（**实测推翻过旧结论**）
 * ────────────────────────────────────────────────────────────
 * 本项目文档以前反复写「中间件跑在 Edge、与页面侧内存不共享」（`perf-notes.md` 六之三、
 * `src/lib/viewer.ts` 旧注释）。**2026-10 实测推翻**：Next 16.3.8 下中间件与页面侧
 * 是**同一个进程的同一份模块内存**（中间件里 `globalThis` 上写的东西，页面侧的 API 路由
 * 读得到；且 `EdgeRuntime` 未定义 ⇒ 实际是 Node 运行时）。
 *
 * 所以 A-2 那句「要根治必须同时改 viewer.ts」是对的，但原因不是「内存不通」，
 * 而是**两边各写了一套、各刷了一次**。现在两边共用本文件：
 *   · 中间件校验过谁 → 页面侧直接复用，**不再重复校验、更不会重复刷新**；
 *   · 刷新单飞也共用 → 同一把 refresh token 在**整个进程**里只会被真正刷新一次。
 *
 * ⚠️ `globalThis` 上取槽位（而不是用模块级 `let`）是**故意的**：
 *    同一个模块可能被两个编译产物各带一份（服务端图 / 中间件图），
 *    模块级变量在那种情况下会出现**两份缓存**、静默失去全部收益。
 *    挂在 `globalThis` 上，即使代码被复制两份，**数据也只有一份**。
 *
 * ⚠️ 刻意**不 import `server-only`**：中间件会引用本文件，
 *    同类说明见 `src/lib/three-state-cache.ts` 的文件头。
 */

import { createThreeStateCache } from "@/lib/three-state-cache";

/** 会话「够新」的判据：剩余有效期 > 120 秒就不去问 Auth 服务。
 *
 *  必须 **≥ auth-js 内部的 `EXPIRY_MARGIN_MS`（90 秒）**，否则库会抢在我们前面刷新，
 *  这个判断就白做了（120 = 90 + 30 秒余量）。
 *  也不能太大：它同时是「过期未刷新」的窗口长度。 */
export const FRESH_MARGIN_MS = 120_000;

/** 共享缓存的 key 上限（token / user id 各自一份，互不干扰） */
const MAX_KEYS = 500;

export type CookieSession = {
  accessToken: string;
  /** 秒级时间戳（`@supabase/ssr` 把整个 session JSON 存在 cookie 里，含这个字段） */
  expiresAt: number;
  refreshToken: string | null;
};

/** 刷新成功后拿到的新会话（字段与 Auth 服务 `/token` 的返回一致） */
type RefreshedSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  [key: string]: unknown;
};

/**
 * 缓存里的用户 = 「谁」+「**凭什么**说他是谁」。
 *
 * `assurance` 是这个文件最重要的一条语义，**不能省**：
 *   · `"verified"` = Auth 服务校验过（`/auth/v1/user` 的返回值）；
 *   · `"jwt"`      = 只是从 cookie 里的 access token **解码**出来的（不验签）。
 *
 * 为什么要分开：中间件在「token 还够新」那条路上存的是 **`"jwt"`**。
 * 如果页面侧不加区分地复用它，就等于**用「没验签的自称」冒充「已校验的身份」** ——
 * 那会静默地把安全底线降一档，而且代码看起来完全正常。
 * 所以 `readAuthUser()` **只把 `"verified"` 当成「已经校验过」**（`"jwt"` 会被当成没缓存）。
 */
export type SourceUser = {
  id: string;
  email?: string;
  assurance: "verified" | "jwt";
};

/** 从 Cookie 里读会话所需的最小接口（`NextRequest.cookies` 与 `next/headers` 的
 *  `cookies()` 都满足它 —— 所以中间件与页面侧能共用同一份实现）。 */
export type CookieReader = {
  getAll(): Array<{ name: string; value: string }>;
};

/** 把 `sb-<ref>-auth-token` 的分片拼起来、解码、解析成 `CookieSession`。
 *  取不到 / 解不出就返回 null（**宁可多查一次，也不猜**）。
 *
 *  ⚠️ **必须同时认两种形状**（这一点踩过：只认 base64 会让测试与任何手写的
 *     会话 cookie 全部变成「未登录」→ 401 / 跳登录页）：
 *    · **正式形状**（`@supabase/ssr` 写的）：`base64-` + base64url(JSON)，超过 3180 字符会切片；
 *    · **松散形状**：URL 编码过的 **JSON 明文**（`tests/paper-analysis.test.mjs` 的
 *      `signInCookie()` 就是这么造的，旧中间件靠 auth-js 的 `getUser()` 兜住了它）。
 *  先按正式形状解，失败再试松散形状；**两者都失败才返回 null**。 */
function parseSessionCookieValue(joined: string): CookieSession | null {
  if (!joined) return null;

  let session: { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown } | null = null;
  if (joined.startsWith("base64-")) {
    try {
      session = JSON.parse(decodeBase64Url(joined.slice(7)));
    } catch {
      session = null;
    }
  }
  if (!session) {
    // 松散形状：URL 编码的 JSON 明文
    try {
      session = JSON.parse(decodeURIComponent(joined));
    } catch {
      return null;
    }
  }
  if (!session || typeof session.access_token !== "string" || !session.access_token) return null;

  return {
    accessToken: session.access_token,
    expiresAt: typeof session.expires_at === "number" ? session.expires_at : 0,
    refreshToken: typeof session.refresh_token === "string" ? session.refresh_token : null,
  };
}

/** 从 Cookie 里读出会话。
 *
 *  ⚠️ 返回的东西**只用于「要不要刷新」的判断与缓存 key，绝不参与身份判定**。 */
export function readSessionFromCookies(cookies: CookieReader): CookieSession | null {
  try {
    const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0];
    const storageKey = `sb-${ref}-auth-token`;
    const chunks: string[] = [];
    for (const c of cookies.getAll()) {
      if (c.name === storageKey) {
        chunks.push(c.value);
      } else if (c.name.startsWith(`${storageKey}.`)) {
        const idx = Number(c.name.slice(storageKey.length + 1));
        if (Number.isInteger(idx)) chunks[idx] = c.value;
      }
    }
    return parseSessionCookieValue(chunks.filter((x) => typeof x === "string").join(""));
  } catch {
    return null;
  }
}

/**
 * 会话还够新吗（剩余有效期 > `FRESH_MARGIN_MS`）。
 *
 * **取不到会话、或时间戳不是有效数字时一律返回 `false`** —— 失败方向必须是
 * 「去问 Auth 服务」，绝不能是「以为还新」。这一点写反了会让过期会话一直被放行。
 */
export function isFreshSession(session: CookieSession | null, marginMs = FRESH_MARGIN_MS): boolean {
  if (!session) return false;
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= 0) return false;
  return session.expiresAt * 1000 - Date.now() > marginMs;
}

/**
 * 把 token 中的 JSON 负载解出来（只解码，**不验签**）。
 * 验签是 Auth 服务的事；这里取到的身份只叫 `"jwt"` 级，见 `SourceUser`。
 */
function decodeJwtPayload(token: string): { sub?: string; email?: string } | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(decodeBase64Url(part)) as { sub?: string; email?: string };
  } catch {
    return null;
  }
}

/**
 * base64url → 字符串。**优先用 Web 标准的 atob**，避免依赖 Node 专有的 Buffer
 * （万一在 Edge runtime 上跑；两者都不可用时调用方会 catch 住并放弃缓存 ——
 * 也就是退化成「每次都查」，功能不受影响）。
 */
function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === "function") return atob(padded);
  return Buffer.from(b64, "base64").toString("binary");
}

/** 从 access token 解出「自称的身份」（`assurance: "jwt"`，**未验签**）。
 *
 *  只有**已经确认 token 够新**时才可以用它当身份；那种情况下中间件也在同一请求里
 *  做同样的判断，所以并不会引入新的信任假设。 */
export function userFromJwt(accessToken: string): SourceUser | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload?.sub) return null;
  return { id: payload.sub, email: payload.email, assurance: "jwt" };
}

// ============================================================
// 进程内共享状态（挂在 globalThis 上，见文件头「为什么」）
// ============================================================

function readCacheTtlMs(envValue: string | undefined): number {
  // 与中间件的既有开关同名、同语义（秒；0 / 非法 = 关掉缓存）。
  // 一起复用它，是为了保住「线上出问题时不改代码就能摘掉缓存」这个退路。
  if (envValue === undefined || envValue.trim() === "") return 30_000;
  const secs = Number(envValue);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return secs * 1000;
}

type AuthEntry = { user: SourceUser | null; at: number };

type SharedAuthState = {
  /** key = access token（token 一变 key 就变 → 自动 miss，不需要额外失效机制） */
  users: ReturnType<typeof createThreeStateCache<AuthEntry>>;
  /** 同一把 refresh token 的刷新结果（避免**错峰的**并发各自再刷一次） */
  refreshes: ReturnType<typeof createThreeStateCache<AuthEntry>>;
  /** 刷新单飞：key = refresh_token（要防的正是「同一把 refresh token 被并发使用」） */
  refreshInflight: Map<string, Promise<SourceUser | null>>;
};

const STATE_SLOT = "__dshAuthState";

function getState(): SharedAuthState {
  const g = globalThis as unknown as Record<string, SharedAuthState | undefined>;
  if (!g[STATE_SLOT]) {
    const ttlMs = readCacheTtlMs(process.env.MIDDLEWARE_CACHE_TTL);
    g[STATE_SLOT] = {
      users: createThreeStateCache<AuthEntry>(ttlMs, MAX_KEYS),
      refreshes: createThreeStateCache<AuthEntry>(ttlMs, MAX_KEYS),
      refreshInflight: new Map(),
    };
  }
  return g[STATE_SLOT];
}

/**
 * 记下「这把 token 对应谁、凭什么」。`assurance` 必须如实填，别为了省一次往返写 `"verified"`。
 */
export function rememberAuthUser(accessToken: string, user: SourceUser | null) {
  getState().users.set(accessToken, { user, at: Date.now() });
}

/**
 * 有没有「**已经被 Auth 服务校验过**」的当前用户（键 = access token）。
 *
 * 三种返回值的区别**必须分清**（写错会让用户莫名被登出）：
 *   · `undefined` = **没缓存过** → 调用方应该自己去校验；
 *   · `null`      = **校验过，确实没有这个人**（token 无效）→ 调用方不该再试；
 *   · `SourceUser`= 校验通过。
 */
export function readAuthUser(accessToken: string): SourceUser | null | undefined {
  const hit = getState().users.get(accessToken);
  if (hit === undefined) return undefined; // 没缓存过
  const entry = hit.value;
  if (!entry || !entry.user) return null; // 缓存过「查无此人」
  return entry.user.assurance === "verified" ? entry.user : undefined;
}

/**
 * 刷新单飞：同一瞬间、**同一把 refresh_token** 的并发请求只真正发一次刷新。
 *
 * 为什么必需：`auth.getUser()` 在 access token 剩 < 90 秒（auth-js 的 `EXPIRY_MARGIN_MS`）
 *   时**每个调用方都会各自去刷新**，而 auth-js 自己的去重（`refreshingDeferred` /
 *   `_acquireLock`）都是**实例级内存** —— 本项目每个请求都新建一个 `GoTrueClient`，
 *   所以跨请求零去重。
 *
 * ⚠️ 单飞**只挡「同一瞬间」**。实测（2026-10）这不够：8 个并发请求如果**错峰**到达
 *    （前一个刷新已经返回、条目已被清掉），后面的会各自再刷一次 —— 实测仍产生 8 次刷新。
 *    所以调用方必须再叠一层「**同一把 refresh token 只刷一次**」的结果缓存，
 *    见 `authRefreshOnce()`。**别把那一层去掉，只留单飞是不够的。**
 *
 * ⚠️ 只去重**同一把钥匙**：refresh_token 真的轮换了就是新的一次刷新，不该被合并。
 * ⚠️ 这是**进程内**的。多实例时最坏每个实例各 1 次 —— 仍远好于「每个请求各 1 次」。
 */
export function authSingleFlight(
  key: string,
  fn: () => Promise<SourceUser | null>,
): Promise<SourceUser | null> {
  const state = getState();
  const flying = state.refreshInflight.get(key);
  if (flying) return flying;
  const run = fn().finally(() => {
    // 只清「还是自己这一条」的，避免把别人新发起的顶掉
    if (state.refreshInflight.get(key) === run) state.refreshInflight.delete(key);
  });
  state.refreshInflight.set(key, run);
  return run;
}

/**
 * **同一把 refresh token 只真正刷新一次**（TTL 内后续请求直接复用那次的结果）。
 *
 * 为什么必须是「结果缓存」而不只是「单飞」：
 *   并发风暴里的请求往往**错峰**到达。单飞只能合并「同一瞬间」那些；
 *   错峰的那些会在前一个刷新完成后各自再刷一次 —— 实测那样仍有 **8 次** `/token`，
 *   而 Supabase 对同一把 refresh token 的重复使用正是它判定「token 泄露 → 撤销会话」
 *   的依据（用户体感就是「每次进网站都要登录」）。
 *
 * ⚠️ 只要 token 已经进入「快过期 / 已过期」区间（即调用方决定要刷新），就可以用这层缓存：
 *    这种 token 本来**马上就要被刷掉**，复用几秒前那次刷新的结果不会让用户看到过期的身份。
 *    （反过来，如果 token 还**够新**，就根本不该走刷新这条路 —— 直接解码 JWT 即可。）
 *
 * ⚠️ 缓存的是**那次刷新的结果**（谁），不是 token 轮换结果 —— 轮换后的新 token 由
 *    `persistRefreshedSession()` 写进响应 Cookie，仍然照常回给浏览器。
 * ⚠️ 代价：拿到旧结果的那几个请求**看不到「这次刷新才生效的新登录」**（TTL 内，默认 30 秒）。
 *    真过期/快过期的 token 刷出来的本来就是同一个身份，这是可接受的取舍。
 */
export async function authRefreshOnce(
  key: string,
  fn: () => Promise<SourceUser | null>,
): Promise<SourceUser | null> {
  const state = getState();
  const hit = state.refreshes.get(key);
  if (hit !== undefined) return hit.value?.user ?? null;

  const result = await authSingleFlight(key, fn);
  state.refreshes.set(key, { user: result, at: Date.now() });
  return result;
}

/**
 * 直接拿 access token 去问 Auth 服务「这人是谁」。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么**不能**用 `supabase.auth.getUser()` 做这件事（2026-10 实测的根因）
 * ────────────────────────────────────────────────────────────
 * `getUser()` 内部走 `_useSession()` → `__loadSession()`，而后者有这么一段
 * （`@supabase/auth-js` 2.117.2 `GoTrueClient.js:2537-2544`）：
 *
 *     const hasExpired = expires_at * 1000 - Date.now() < EXPIRY_MARGIN_MS;  // 90 秒
 *     if (!hasExpired) return 已经有效的会话;
 *     const { data, error } = await this._callRefreshToken(refresh_token);   // ← 刷新
 *
 * 也就是说：**只要 token 进入最后 90 秒，每次 `getUser()` 都会触发一次刷新**，
 * 而且**`autoRefreshToken: false` 挡不住它**（那个开关只管后台定时器，不管这条路径）。
 * 更糟的是 `_refreshAccessToken()` 内部还带**指数退避重试**（`retryable`，
 * 200/400/800…ms，上限 30 秒）。于是「一个请求里的一次 getUser」实测会放大成
 * **18–24 次** `/auth/v1/token`；而重试过程中一旦某次拿到 `null`，
 * 中间件就把用户**送去登录页** —— 这正是「每次进网站都要登录」。
 *
 * 换成直接打 `/auth/v1/user`（就是 perf-notes 六之六保留下来的那条已验证方案）：
 *   · 它**只校验**，不碰会话管理、不刷新、没有重试风暴；
 *   · 校验仍然由 **Auth 服务**完成（不是本地解码冒充），安全边界不变。
 *
 * 返回值契约：**拿不到就是 `null`**（调用方据此按未登录处理）。
 * ⚠️ 刻意**不**把网络失败与 401 分开返回：两种情况都不该放行，
 *    而且分开了调用方很容易写成「网络抖动 → 当成已登录」（失败方向必须是关闭）。
 */
export async function validateTokenWithAuthService(accessToken: string): Promise<SourceUser | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !accessToken) return null;

  try {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      // 校验结果要跟请求本身同生共死，不能被任何缓存层留住
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown; email?: unknown };
    if (typeof body?.id !== "string" || !body.id) return null;
    return {
      id: body.id,
      email: typeof body.email === "string" ? body.email : undefined,
      assurance: "verified",
    };
  } catch {
    return null;
  }
}

/**
 * 用 refresh token 换一份**新的**会话。
 *
 * ⚠️ 为什么不用 `supabase.auth.refreshSession()` / `getUser()` 让 auth-js 来刷：
 *    它内部带**指数退避重试**（`_refreshAccessToken` 的 `retryable`），实测一个请求能
 *    放大成 18–24 次 `/auth/v1/token`（详见 `validateTokenWithAuthService` 的说明）。
 *    这里直接打一次 `/token`，失败就是失败，**不重试**。
 *
 * 返回 `null` = 刷新失败（refresh token 失效 / 网络问题）→ 调用方按未登录处理。
 * ⚠️ 失败方向必须是「关」：绝不能猜一个身份出来。
 */
export async function refreshSessionWithAuthService(
  refreshToken: string,
): Promise<RefreshedSession | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey || !refreshToken) return null;

  try {
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<RefreshedSession>;
    if (
      typeof body?.access_token !== "string" ||
      typeof body?.refresh_token !== "string" ||
      typeof body?.expires_at !== "number"
    ) {
      return null;
    }
    return body as RefreshedSession;
  } catch {
    return null;
  }
}

/**
 * 把刷新后的会话**写回响应的 Cookie**（格式与 `@supabase/ssr` 完全一致）。
 *
 * 为什么要自己拼：`@supabase/ssr` **没有**导出它的写入器 `applyServerStorage`
 * （只在内部 `cookies.js` 里，且该包没有声明 `exports` 子路径 ——
 * 深层 import 会在升级时静默失效，正是本项目最忌讳的「第二个来源」）。
 * 所以这里只用它**公开**导出的三样东西复刻那两行编码逻辑：
 *   `DEFAULT_COOKIE_OPTIONS` / `stringToBase64URL` / `createChunks`
 * —— 与 `cookies.js` 的行为逐条对齐（含 `base64-` 前缀、3180 字符切片、清理旧分片）。
 *
 * ⚠️ 值必须是 `JSON.stringify(session)`：auth-js 的存储层写入前会自己 stringify，
 *    这里存的是同一层的内容，格式对不上就会「写进去、读不出来」。
 * ⚠️ 写失败不能抛：刷新本身已经成功、身份照样可用；只是这次没能把新 token 落盘，
 *    下一个请求会再刷一次而已。抛出去会把整站鉴权入口搞崩。
 */
export async function persistRefreshedSession(
  response: {
    cookies: {
      getAll(): Array<{ name: string; value: string }>;
      set(name: string, value: string, options?: Record<string, unknown>): unknown;
    };
    headers?: { set(name: string, value: string): unknown };
  },
  session: RefreshedSession,
) {
  try {
    const { DEFAULT_COOKIE_OPTIONS, stringToBase64URL, createChunks, isChunkLike } = await import(
      "@supabase/ssr"
    );
    const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0];
    const storageKey = `sb-${ref}-auth-token`;

    const encoded = `base64-${stringToBase64URL(JSON.stringify(session))}`;
    const chunks = createChunks(storageKey, encoded);

    // 先把这一项**旧的**所有分片清掉（新分片数量可能比旧的少）
    const newNames = new Set(chunks.map((c) => c.name));
    for (const { name } of response.cookies.getAll()) {
      if (isChunkLike(name, storageKey) && !newNames.has(name)) {
        response.cookies.set(name, "", { ...DEFAULT_COOKIE_OPTIONS, maxAge: 0 });
      }
    }
    for (const { name, value } of chunks) {
      response.cookies.set(name, value, { ...DEFAULT_COOKIE_OPTIONS });
    }

    // 带会话的响应不能被 CDN / 反向代理缓存（与 supabase/ssr 的做法一致）
    response.headers?.set(
      "Cache-Control",
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
  } catch {
    // 见上：落盘失败不影响本次身份
  }
}

/**
 * 包一层 Cookie 读法，让 **auth-js 看不见「快过期 / 已过期」的会话**。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么需要这个（这是 A-2 真正收口的那一刀）
 * ────────────────────────────────────────────────────────────
 * 只要 auth-js 从存储里**读到**一个 `expires_at` 进入最后 90 秒的会话，它就会自己去刷新：
 *   · `__loadSession()`：`expires_at * 1000 - now < EXPIRY_MARGIN_MS(90s)` → `_callRefreshToken()`；
 *   · `_recoverAndRefresh()`：同样的判断（初始化时）。
 * 而 `_refreshAccessToken()` 内部还带**指数退避重试**，于是「读到一个快过期的会话」
 * 就会炸成一串 `/auth/v1/token`。
 *
 * ⚠️ **`autoRefreshToken: false` 挡不住这两条路径**（它只管后台定时器）。
 *    本项目实测：8 个并发请求 → 24 次 `/auth/v1/token`。
 *
 * 做法：读的时候把这类会话**当成不存在**（返回 `null`）——
 *   · auth-js 看不到会话 ⇒ 不会刷新，也不会去 `/user`；
 *   · 刷新由**中间件**统一负责一次（只有它能写响应 Cookie）；
 *   · 中间件刷完会把新会话写回 Cookie，下一个请求 auth-js 读到的就是**新鲜的**会话，
 *     那时 `getUser()` / RLS 查询都照常工作。
 *
 * ⚠️ **只改「读」，不改「写」**：`setAll` 必须原样透传 ——
 *    登录 / 注册 / 登出都靠它把会话写进 Cookie（`logIn` 走的正是这条路）。
 *    早先一版把它写成了空实现（想「只让中间件写会话」），结果**登录直接失效**，
 *    被 `admin-grant90` 与 `feedback-client-cache` 两个套件抓出来。
 *    刷新确实不会走写路径：会话一旦对 auth-js 不可见，它就没有可刷新的对象。
 */
export function hideStaleSessionFromAuthJs(cookieStore: CookieReader, marginMs = FRESH_MARGIN_MS) {
  return {
    getAll(): Array<{ name: string; value: string }> {
      if (isFreshSession(readSessionFromCookies(cookieStore), marginMs)) {
        return cookieStore.getAll();
      }

      // 会话不新鲜（或压根没有 / 解析不出）→ 把这项整体藏起来。
      // ⚠️ 判断用**同一套** `readSessionFromCookies`：cookie 可能是
      //    `sb-xxx-auth-token` + `.0`/`.1` 分片，只过滤单个名字会漏或误伤。
      const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0];
      const storageKey = `sb-${ref}-auth-token`;
      return cookieStore
        .getAll()
        .filter((c) => !(c.name === storageKey || c.name.startsWith(`${storageKey}.`)));
    },
  };
}

/**
 * 页面侧（`src/lib/viewer.ts`）用它拿到「当前用户」而不必**重复**校验会话。
 *
 * 顺序即优先级，**不要调换**：
 *
 *   ① **中间件本次请求已经校验过的结果**（`readAuthUser`）
 *      → 直接复用。这是压掉并发刷新的关键一步：同一个请求里中间件刚向 Auth 服务
 *        确认过这把 token，页面侧再确认一次纯属白付一次跨洋往返。
 *   ② **token 还够新** → 只解码 JWT 取身份（`assurance: "jwt"`，**不验签**）。
 *      与中间件分支① 的口径完全一致，不引入新的信任假设。
 *   ③ 前两步都不成立（中间件没跑到 / JWT 解不出来）→ 向 Auth 服务**直接校验**。
 *
 * ⚠️ 返回 `null` 的语义是「**没有已登录的用户**」——调用方（`loadViewer`）会据此
 *    按未登录处理。所以第 ③ 步**必须真问**，不能拿①②的失败去猜。
 *
 * ⚠️ 本函数**不做刷新**。刷新只在中间件里发生一次（`src/proxy.ts`），
 *    因为只有中间件能把轮换后的新 token 写回响应 Cookie。
 *    页面侧（Server Component）**写不了 Cookie** —— 它在这里刷新等于白刷
 *    （新 token 落不了盘，下个请求还得再刷），那正是旧实现把刷新次数放大的原因。
 */
export async function resolveViewerUser(cookies: CookieReader): Promise<SourceUser | null> {
  const session = readSessionFromCookies(cookies);
  if (!session) return null;

  // ① 中间件本次请求已经校验过同一把 token → 直接复用（省掉一次重复校验）。
  const cached = readAuthUser(session.accessToken);
  if (cached !== undefined) return cached; // 含「校验过但查无此人」的 null

  // ② token 还够新 → 只解码 JWT（与中间件分支① 同口径，不引入新的信任假设）。
  if (isFreshSession(session)) {
    const fromJwt = userFromJwt(session.accessToken);
    if (fromJwt) {
      rememberAuthUser(session.accessToken, fromJwt);
      return fromJwt;
    }
  }

  // ③ 真去问 Auth 服务 —— 用**直接校验**而不是 `supabase.auth.getUser()`：
  //    后者在「还剩 < 90 秒」时会触发刷新 + 指数退避重试风暴（见
  //    `validateTokenWithAuthService` 的说明），那是本项目最贵的一次出网。
  //    ⚠️ **不要**为「省一次往返」把它换成 `getUser()`：本机测出来是 1 次 vs 18 次。
  const run = async (): Promise<SourceUser | null> => {
    const result = await validateTokenWithAuthService(session.accessToken);
    rememberAuthUser(session.accessToken, result);
    return result;
  };
  const key = session.refreshToken ?? session.accessToken;
  return authSingleFlight(key, run);
}
