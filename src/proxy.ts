import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { createThreeStateCache, readCacheTtlMs } from "@/lib/three-state-cache";

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
//    **做不到主动清缓存**：中间件与 API 路由/Server Action 不是同一个执行环境
//    （Edge vs Node 内存不共享），在 logout 路由里 clear 这里的内存是无效的。
//
// ⚠️ token **只用作缓存 key**，绝不参与身份判定 —— 缓存里存的 user 仍然来自
//    被 Auth 服务校验过的 `getUser()` 返回值，**不是**用 `getSession()` 读 cookie 冒充校验。
const TTL_MS = readCacheTtlMs(process.env.MIDDLEWARE_CACHE_TTL);

/** 认证结果缓存：key = access token；值 = 最小用户信息（只保留代码实际用到的字段） */
type CachedUser = { id: string; email?: string };
const authCache = createThreeStateCache<CachedUser>(TTL_MS, 500);
/** 角色/封禁缓存：key = user id；值 = { role, status } */
const roleCache = createThreeStateCache<{ role: string | null; status: string | null }>(TTL_MS, 500);

/**
 * 从请求 Cookie 里取出会话的 access token（仅用作缓存 key）。
 *
 * `@supabase/ssr` 把会话存成 `sb-<ref>-auth-token`，值可能是
 * `base64-<base64url 的 JSON>`，超过 3180 字符时切成 `.0`/`.1`… 分片。
 * 该包 0.12.7 没有公开这项读取工具（只导出了 `clearAuthCookiesAtScopes`），
 * 所以这里自己拼一次。**取不到就返回 null → 不缓存**（宁可多查一次，也不猜）。
 */
const AUTH_COOKIE_SUFFIX = "-auth-token";

/**
 * base64url → 字符串。**优先用 Web 标准的 atob**，避免依赖 Node 专有的 Buffer
 * （中间件可能跑在 Edge runtime 上；万一两者都不可用，调用方会 catch 住并放弃缓存 ——
 * 也就是退化成「每次都查」，功能不受影响）。
 */
function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === "function") return atob(padded);
  return Buffer.from(b64, "base64").toString("binary");
}

function readAccessToken(request: NextRequest): string | null {
  try {
    const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0];
    const storageKey = `sb-${ref}${AUTH_COOKIE_SUFFIX}`;
    const chunks: string[] = [];
    for (const c of request.cookies.getAll()) {
      if (c.name === storageKey) {
        chunks.push(c.value);
      } else if (c.name.startsWith(`${storageKey}.`)) {
        const idx = Number(c.name.slice(storageKey.length + 1));
        if (Number.isInteger(idx)) chunks[idx] = c.value;
      }
    }
    const joined = chunks.filter((x) => typeof x === "string").join("");
    if (!joined) return null;
    const raw = joined.startsWith("base64-") ? joined.slice(7) : joined;
    const session = JSON.parse(decodeBase64Url(raw)) as { access_token?: unknown };
    return typeof session.access_token === "string" && session.access_token
      ? session.access_token
      : null;
  } catch {
    return null;
  }
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

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
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

  // 必须尽早调用：触发 Token 刷新，并把新会话写入上面的 response。
  // 使用 getUser() 而不是 getSession()，因为它会向 Auth 服务校验 Token。
  //
  // 缓存：key = 存下来的 access token。命中则**跳过这次外网往返**。
  // （token 变了 key 就变，所以不需要额外的失效逻辑；见文件上方长注释。）
  const token = readAccessToken(request);
  const cachedAuth = token ? authCache.get(token) : undefined;

  let user: CachedUser | null;
  if (cachedAuth !== undefined) {
    user = cachedAuth.value;
  } else {
    const {
      data: { user: fetched },
    } = await supabase.auth.getUser();
    user = fetched ? { id: fetched.id, email: fetched.email ?? undefined } : null;
    if (token) authCache.set(token, user);
  }

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
