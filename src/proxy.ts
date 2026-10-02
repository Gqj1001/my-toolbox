import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { TOOLS } from "@/lib/tools";

/** 无需登录即可访问的路径前缀 */
const PUBLIC_PATHS = ["/login", "/signup", "/auth"];

/**
 * 需要 admin 角色才能访问的路径。
 * 除固定的 /admin 外，还包括工具目录里标记为 access: "admin" 的工具，
 * 保证「目录声明的权限」与「服务端实际拦截」始终来自同一份数据。
 */
const ADMIN_PATHS = [
  "/admin",
  ...TOOLS.filter((tool) => tool.access === "admin").map((tool) => tool.href),
];

function matchesPath(pathname: string, paths: string[]) {
  return paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * 工具静态资源说明（如 public/tools/math-plan.html）：
 *
 * 这类文件由 Next 的静态文件服务直接返回，proxy 会在其之前执行。
 * 由于它们不在 PUBLIC_PATHS 中，**未登录用户会被拦到登录页**，
 * 而已登录用户放行 —— 因此不需要额外的白名单逻辑，
 * 也就避免了「白名单被误用成免登录通道」这类问题。
 */

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

  // 1) 未登录访问受保护页面 -> 跳转登录页，并记住原本要去的地址。
  //    未登录时只认 PUBLIC_PATHS：包括 .html 工具资源在内，一律拦截，避免内容泄露。
  if (!user && !matchesPath(pathname, PUBLIC_PATHS)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("redirectTo", `${pathname}${search}`);

    return redirectTo(loginUrl);
  }

  // 2) 已登录用户不必再看登录/注册页 -> 直接回主页面
  if (user && (pathname === "/login" || pathname === "/signup")) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = "/";
    homeUrl.search = "";

    return redirectTo(homeUrl);
  }

  // 3) 管理后台：必须是 admin
  if (user && matchesPath(pathname, ADMIN_PATHS)) {
    // 读取 user_roles（受 RLS "users read own role" 策略保护，只能读到自己那一行）
    const { data, error } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    // 出错时按最小权限处理（不放行），并允许应急名单兜底
    const role = error ? null : data?.role;
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
