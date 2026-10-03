import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** 无需登录即可访问的路径前缀 */
const PUBLIC_PATHS = ["/login", "/signup", "/auth"];

/**
 * 被封禁用户仍可访问的路径。
 * 必须包含 /banned 本身，否则会无限重定向。
 */
const BANNED_ALLOWED_PATHS = ["/banned", "/login", "/logout", "/signup", "/auth"];

/** 需要 admin 角色才能访问的路径前缀（工具级的会员要求在各页面与 Server Action 中判定） */
const ADMIN_PATHS = ["/admin"];

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
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
    // 受 RLS "users read own role" 策略保护，只能读到自己那一行
    const { data } = await supabase
      .from("user_roles")
      .select("role, status")
      .eq("user_id", user.id)
      .maybeSingle();

    role = data?.role ?? null;
    status = data?.status ?? null;

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
