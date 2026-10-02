import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * 邮箱确认 / 魔法链接回调。
 *
 * Supabase 的确认邮件会带上 token_hash 与 type 参数跳到本路由，
 * 校验通过后写入会话 Cookie 并跳转到主页面。
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  const supabase = await createClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });

    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  } else if (code) {
    // PKCE 流程（OAuth / 部分登录方式）使用 code 换取会话
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(new URL(next, request.url));
    }
  }

  const failureUrl = new URL("/login", request.url);
  failureUrl.searchParams.set("error", "邮箱确认链接无效或已过期，请重新登录或再次注册。");

  return NextResponse.redirect(failureUrl);
}
