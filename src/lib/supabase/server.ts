import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { hideStaleSessionFromAuthJs } from "@/lib/session-freshness";

/**
 * 服务端的 Supabase 客户端（Server Component / Server Action / Route Handler）。
 *
 * 每次请求都必须新建一个实例，绝不能在请求之间复用。
 */
export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY，请检查 .env.local",
    );
  }

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    // ⚠️ 关掉 auth-js 的「自动刷新」定时器。
    //    **但这一条并不能阻止刷新** —— 真正的刷新来自 `__loadSession()` /
    //    `_recoverAndRefresh()`（它们不看这个开关）。真正挡住它的是下面的
    //    `hideStaleSessionFromAuthJs()`，两者一起才有效。详见该函数说明。
    auth: { autoRefreshToken: false },
    // ⚠️ 把「快过期 / 已过期」的会话对 auth-js **藏起来**：否则它一读到就会去刷新，
    //    而它的刷新带指数退避重试 —— 实测 8 个并发请求能炸成 24 次 `/auth/v1/token`，
    //    这正是「每次进网站都要登录」的根因。刷新统一交给中间件做一次。
    //    ⚠️ **只包「读」**：`setAll`（写）必须原样保留，否则**登录会直接失效**
    //    （`logIn` 就是靠它把会话写进 Cookie 的）。
    cookies: {
      ...hideStaleSessionFromAuthJs(cookieStore),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component 中无法写 Cookie（`cookies().set` 会抛）。
          // 登录/登出走 Server Action，那里是可以写的；会话的刷新由 src/proxy.ts 负责。
        }
      },
    },
  });
}
