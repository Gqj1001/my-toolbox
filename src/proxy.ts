import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { createThreeStateCache, readCacheTtlMs } from "@/lib/three-state-cache";
import {
  authRefreshOnce,
  authSingleFlight,
  hideStaleSessionFromAuthJs,
  isFreshSession,
  persistRefreshedSession,
  readSessionFromCookies,
  refreshSessionWithAuthService,
  rememberAuthUser,
  userFromJwt,
  validateTokenWithAuthService,
  type CookieSession,
  type SourceUser,
} from "@/lib/session-freshness";

/** 无需登录即可访问的路径前缀 */
const PUBLIC_PATHS = ["/login", "/signup", "/auth"];

/**
 * 被封禁用户仍可访问的路径。
 * 必须包含 /banned 本身，否则会无限重定向。
 */
const BANNED_ALLOWED_PATHS = ["/banned", "/login", "/logout", "/signup", "/auth"];

/** 需要 admin 角色才能访问的路径前缀（工具级的会员要求在各页面与 Server Action 中判定） */
const ADMIN_PATHS = ["/admin"];

// ============================================================
// 进程内短 TTL 缓存（本文件是**中间件**，与页面侧不是同一个执行环境）
// ============================================================
//
// 为什么中间件要自己缓存一遍：
//   · 打开一个工具页，中间件要跑 2–4 次（页面壳 + iframe 里的工具 HTML + 各 API 请求）；
//   · **每次带 cookie 的请求都要 2 次外网往返**：`auth.getUser()`（校验 token）
//     与 `user_roles`（封禁/管理员判定）。香港→新加坡每次约 400–500ms
//     —— 这正是用户实测「进入 /tools/feedback 要 5–6 秒、其中等待服务器 4.31 秒」的主因。
//   · 页面侧（`src/lib/viewer.ts`）的 `user_roles` 缓存**帮不到这里**：
//     中间件不在 React 渲染树里，而且很可能跑在 Edge runtime，与 Node 侧各有各的内存。
//     两边都缓存不是重复劳动，是各修各的那一份。
//
// ⚠️ 两台缓存都以**「存下来的 token」**为 key 语义（user 缓存直接用 token 当 key）：
//    token 一变 key 就变 → 自动 miss；登出后浏览器不再带该 token → 也自然 miss。
//    所以**不需要额外设计失效机制**。
//
// ⚠️ 安全取舍（用户已确认接受）：token 被吊销 / 改密码导致会话失效时，
//    最多延迟一个 TTL（默认 30 秒）才被这里察觉。
//    **做不到主动清缓存**：发起刷新的中间件与读取缓存的页面侧未必在同一时刻执行，
//    在 logout 路由里 clear 这里的内存也可能是无效的。
//
// ⚠️ token **只用作缓存 key**，绝不参与身份判定 —— 认证缓存里存的用户来自
//    `getUser()` 的返回值或**已验证够新**的 token，**不是**用 `getSession()` 冒充校验。
//
// ⚠️ 认证缓存与刷新单飞**已经搬进 `src/lib/session-freshness.ts`**，与页面侧
//    （`src/lib/viewer.ts`）**共用同一份**：实测中间件与页面侧是同一个进程的同一份内存，
//    所以「中间件刚校验过谁」页面侧可以**直接复用**，不必再各付一次校验与刷新。
//    这正是 A-2 后半场要压掉的那 8 次并发刷新。
const TTL_MS = readCacheTtlMs(process.env.MIDDLEWARE_CACHE_TTL);

/** 角色/封禁缓存：key = user id；值 = { role, status } */
const roleCache = createThreeStateCache<{ role: string | null; status: string | null }>(TTL_MS, 500);

/** 从**响应** Cookie 里读出会话 —— 刷新后的新会话是 auth-js 写进 response 的 Set-Cookie，
 *  而不是请求里那份（请求里的还是旧的、快过期的那个）。
 *  用来把**轮换后的新 token** 也写进共享认证缓存，让同一波并发里后续请求直接命中。 */
function readSessionFromResponse(response: NextResponse): CookieSession | null {
  return readSessionFromCookies(response.cookies);
}

function matchesPath(pathname: string, paths: string[]) {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * API 路径：未登录时返回 401 JSON，而不是重定向到登录页。
 * 否则前端 fetch 拿到的是 HTML 登录页，且无法按状态码区分 401/403。
 * （各 API Route 内部仍会自行校验身份，这里是第一道防线。）
 */
function isApiPath(pathname: string) {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * 应急管理员名单（可选）：逗号分隔的邮箱。
 * 用途仅限「user_roles 表尚未建好 / 尚未把自己设为 admin」时进入后台完成初始化。
 * 权限判定仍以数据库中的 role 为准。
 */
function isBootstrapAdmin(email: string | undefined) {
  if (!email) return false;
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

export default async function proxy(request: NextRequest) {
  // 默认响应：会把刷新后的会话 Cookie 写回浏览器
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY，请检查 .env.local",
    );
  }

  // ============================================================
  // A-2：只有「快过期 / 已过期」时才刷新，且同一把 refresh token 只刷一次
  // ============================================================
  //
  // 背景（实测）：只要 auth-js **读到**一个 `expires_at` 进入最后 90 秒的会话，
  //   它就会自己去刷新 —— 走的是 `__loadSession()` 与 `_recoverAndRefresh()`，
  //   **`autoRefreshToken: false` 挡不住这两条路径**。而 `_refreshAccessToken()`
  //   内部还带**指数退避重试**（200/400/800…ms）。于是「每个请求新建一个 client」
  //   的写法会炸成一串 `/auth/v1/token`：实测并发 8 个请求最多 **24 次**。
  //   同一把 refresh token 被重复使用，正是 Supabase 判定「token 泄露 → 撤销会话」
  //   的依据 —— 用户体感就是「每次进网站都要登录」。
  //
  // 所以这里**完全绕开 auth-js 做身份与刷新**（`src/lib/session-freshness.ts` 直连
  // `/auth/v1/user` 与 `/auth/v1/token`），并且：
  //   ① token 还够新（剩余 > `FRESH_MARGIN_MS`）→ **0 次外网**：只解码 JWT 取 sub/email
  //      （不验签，验签是 Auth 服务的事）→ 不可能触发刷新；
  //   ② 进入最后 120 秒 / 已过期 → **自己做一次刷新**，单飞 + 结果缓存保证一波并发只刷一次，
  //      并把轮换后的新会话写回响应 Cookie（浏览器与页面侧都拿到新的）。
  //
  // 上面那个 `createServerClient` 因此**排在刷新之后**创建：那时 `request.cookies`
  // 已经是新 token，它读到的会话是新鲜的，不会再去刷新。
  //
  // ⚠️ 安全取舍（用户已确认接受，2026-10）：
  //    分支① 不再逐请求向 Auth 服务确认「token 是否被吊销」，改为**每个 token 生命周期确认一次**
  //    （token 1 小时一轮换，进入 120 秒窗口时必然走到分支②）。
  //    封禁**不受影响** —— 它走下面的 `user_roles` 查询，与这里无关。
  //    代价是「改密码 / 主动吊销」最多延迟到该 token 过期才生效（≤1 小时）。
  const session = readSessionFromCookies(request.cookies);

  let user: SourceUser | null = null;

  if (isFreshSession(session) && session) {
    // ① 够新 → 只解码，不问 Auth 服务（0 次外网 ⇒ 也就不可能触发刷新）。
    user = userFromJwt(session.accessToken);
  }

  if (!user && session?.refreshToken) {
    // ② 快过期 / 已过期 → 自己做一次刷新。单飞 + 结果缓存：一波并发只真刷一次。
    user = await authRefreshOnce(session.refreshToken, async () => {
      const refreshed = await refreshSessionWithAuthService(session.refreshToken as string);
      if (!refreshed) return null;
      await persistRefreshedSession(response, refreshed);
      return validateTokenWithAuthService(refreshed.access_token);
    });
    if (user) {
      // 让**本次请求**的页面侧（getViewer）直接复用这个已校验结果，不再重复校验。
      rememberAuthUser(session.accessToken, user);
      const minted = readSessionFromResponse(response);
      if (minted?.accessToken) rememberAuthUser(minted.accessToken, user);
    }
  } else if (!user && session?.accessToken) {
    // ③ 有 token 但没有 refresh token（少见）→ 只能**直接校验**，不做刷新。
    user = await authSingleFlight(session.accessToken, () =>
      validateTokenWithAuthService(session.accessToken as string),
    );
    if (user) rememberAuthUser(session.accessToken, user);
  }

  // ⚠️ **必须在身份/刷新处理之后**才创建这个 client：
  //    它读的是 `request.cookies`，而刷新会把新 token 同步进去；
  //    读到的会话是新鲜的，auth-js 才不会自己去刷新（少这一层实测多 1 次刷新）。
  const supabase = createServerClient(url, anonKey, {
    // 这个 client 只用来查 `user_roles`（RLS 用请求里的 token 做鉴权）。
    // **不要**拿它调 `auth.getUser()` / `refreshSession()`，原因见上面那段说明。
    auth: { autoRefreshToken: false },
    cookies: {
      // 兜底：万一仍有「快过期」的会话（例如并发下页面侧先跑到），对它藏起来，
      // 让 auth-js 彻底没有机会自己发起刷新。**只过滤「读」**，写路径原样保留。
      getAll() {
        return hideStaleSessionFromAuthJs(request.cookies).getAll();
      },
      setAll(cookiesToSet, headers) {
        // 先同步到本次请求，让后续的 Server Component 也能读到新 Token
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }

        // 设置了鉴权 Cookie 的响应不能被 CDN / 反向代理缓存
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  const { pathname, search } = request.nextUrl;

  /** 把会话 Cookie 的变更带到重定向响应上，避免刷新结果丢失 */
  const redirectTo = (target: URL) => {
    const redirectResponse = NextResponse.redirect(target);
    for (const cookie of response.cookies.getAll()) {
      redirectResponse.cookies.set(cookie);
    }
    return redirectResponse;
  };

  // 1) 未登录访问受保护页面 / API -> 跳转登录页（页面）或返回 401 JSON（API）。
  //    未登录时只认 PUBLIC_PATHS：包括 .html 工具资源在内，一律拦截，避免内容泄露。
  if (!user && !matchesPath(pathname, PUBLIC_PATHS)) {
    if (isApiPath(pathname)) {
      const unauthorized = NextResponse.json(
        { ok: false, error: "请先登录。", code: "unauthenticated" },
        { status: 401 },
      );
      for (const cookie of response.cookies.getAll()) {
        unauthorized.cookies.set(cookie);
      }
      return unauthorized;
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("redirectTo", `${pathname}${search}`);

    return redirectTo(loginUrl);
  }

  // 2) 已登录用户不必再看登录/注册页 -> 直接回百宝箱
  if (user && (pathname === "/login" || pathname === "/signup")) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/dashboard";
    homeUrl.search = "";

    return redirectTo(homeUrl);
  }

  // 已登录用户：读取一次 user_roles，供封禁判定与管理员判定共用（一次查询）
  let role: string | null = null;
  let status: string | null = null;

  if (user && !matchesPath(pathname, BANNED_ALLOWED_PATHS)) {
    // 缓存：key = user id（这里已经没有 token 了，但 user.id 同样稳定）。
    // 命中则跳过这次查询；未命中才查库。
    const cachedRole = roleCache.get(user.id);
    if (cachedRole !== undefined) {
      role = cachedRole.value?.role ?? null;
      status = cachedRole.value?.status ?? null;
    } else {
      // 受 RLS "users read own role" 策略保护，只能读到自己那一行
      const { data } = await supabase
        .from("user_roles")
        .select("role, status")
        .eq("user_id", user.id)
        .maybeSingle();

      role = data?.role ?? null;
      status = data?.status ?? null;
      roleCache.set(user.id, { role, status });
    }

    // 3) 封禁拦截：status='banned' 的用户访问任何页面都跳到 /banned
    //    API 路径返回 403 JSON，避免前端 fetch 拿到 HTML
    if (status === "banned") {
      if (isApiPath(pathname)) {
        const forbidden = NextResponse.json(
          { ok: false, error: "账号已被封禁。", code: "banned" },
          { status: 403 },
        );
        for (const cookie of response.cookies.getAll()) {
          forbidden.cookies.set(cookie);
        }
        return forbidden;
      }

      const bannedUrl = request.nextUrl.clone();
      bannedUrl.pathname = "/banned";
      bannedUrl.search = "";

      return redirectTo(bannedUrl);
    }
  }

  // 4) 管理后台：必须是 admin（出错时按最小权限处理，并允许应急名单兜底）
  if (user && matchesPath(pathname, ADMIN_PATHS)) {
    const allowed = role === "admin" || isBootstrapAdmin(user.email);

    if (!allowed) {
      const homeUrl = request.nextUrl.clone();
      homeUrl.pathname = "/dashboard";
      homeUrl.search = "";
      homeUrl.searchParams.set("error", "admin_required");

      return redirectTo(homeUrl);
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * 匹配所有路径，但排除：
     * - _next/static、_next/image（构建产物与图片优化）
     * - favicon.ico 等静态文件
     * - 公开目录下的图片资源
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
