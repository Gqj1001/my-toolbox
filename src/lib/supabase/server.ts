import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component 中无法写 Cookie。会话刷新由 src/proxy.ts 负责，
          // 因此这里可以安全地忽略该错误。
        }
      },
    },
  });
}
