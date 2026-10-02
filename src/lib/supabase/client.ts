import { createBrowserClient } from "@supabase/ssr";

/**
 * 浏览器端的 Supabase 客户端。
 * 只能在 Client Component 中使用，使用 anon key，受 RLS 保护。
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY，请检查 .env.local",
    );
  }

  return createBrowserClient(url, anonKey);
}
