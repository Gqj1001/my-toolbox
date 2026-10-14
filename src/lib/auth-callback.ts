/**
 * 邮件回调参数的解析 —— **纯函数，唯一来源**（2026-10 第十六批）
 *
 * 背景（实测踩到，务必先读）：Supabase 现在把**会话或错误放在 URL 的 `#` 片段里**：
 *
 *   https://<项目>.supabase.co/auth/v1/verify?token=pkce_…&type=recovery&redirect_to=…
 *     ↓ 303 跳回我们站点
 *   https://010034.xyz/auth/confirm?next=/reset-password#access_token=…&refresh_token=…&type=recovery
 *   或（链接过期/已用过）
 *   https://010034.xyz/auth/confirm?next=/reset-password#error=access_denied&error_code=otp_expired&…
 *
 * ⚠️ **`#` 后面的东西永远不会发给服务器** —— 所以原来那个"服务端路由 `/auth/confirm`"
 *    （只读 `?token_hash=` / `?code=`）什么都看不到，于是**一律跳登录页**，
 *    老师点重置链接后看到的正是登录界面、根本没法重置密码。这就是本轮修的那个 bug。
 *    ⇒ 修复方向：把它换成**客户端**回调页（浏览器能读 `#`，而且浏览器端 client
 *      会把会话写进 cookie，之后中间件/服务端就认得）。
 *
 * 这个文件只负责"把 URL 里那堆东西解析成结构"，不碰网络、不认 React —— 好写好测。
 */

export type AuthCallbackParams = {
  /** 从 `#` 片段里拿到的会话（新版邮件链接走这条） */
  accessToken: string | null;
  refreshToken: string | null;
  /** PKCE 流程的授权码（`?code=…`，放在**查询串**里） */
  code: string | null;
  /** 旧式一次性令牌（`?token_hash=…&type=…`），Supabase 也仍支持 */
  tokenHash: string | null;
  type: string | null;
  /** `#error=…`：链接无效/过期时 Supabase 放在片段的错误码 */
  error: string | null;
  errorCode: string | null;
  /** 成功后要去哪（站内相对路径，默认 `/`） */
  next: string;
};

/** 只认站内相对路径，避免开放重定向（与 `auth/actions.ts` 同一口径） */
export function safeNextPath(value: string | null | undefined): string {
  const v = String(value ?? "");
  if (!v.startsWith("/") || v.startsWith("//")) return "/";
  return v;
}

/**
 * 从页面 URL 里解析出回调参数。
 *
 * @param url   完整地址（`location.href`）
 * @param hash  单独的片段串（`location.hash`，带不带 `#` 都行）。分开传是为了**可测**：
 *              纯函数不该依赖 `window`。
 */
export function parseAuthCallback(url: string, hash: string): AuthCallbackParams {
  let search: URLSearchParams;
  try {
    search = new URL(url).searchParams;
  } catch {
    search = new URLSearchParams();
  }
  const frag = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));

  // ⚠️ 片段与查询串**都要看**：会话在片段里，`next` 在查询串里（我们拼 redirect_to 时带的）；
  //    但 Supabase 也可能把 error 放查询串，所以两边都查一遍。
  const pick = (key: string) => frag.get(key) ?? search.get(key);

  return {
    accessToken: pick("access_token"),
    refreshToken: pick("refresh_token"),
    code: search.get("code"),
    tokenHash: search.get("token_hash"),
    type: pick("type"),
    error: pick("error"),
    errorCode: pick("error_code"),
    next: safeNextPath(pick("next")),
  };
}

/**
 * 这个 URL 里有没有"可以换出会话"的东西。
 * 没有 + 也没有 error ⇒ 说明用户是**直接打开**这个地址的（不是从邮件点进来的）。
 */
export function hasSessionPayload(p: AuthCallbackParams): boolean {
  if (p.accessToken && p.refreshToken) return true;
  if (p.code) return true;
  if (p.tokenHash && p.type) return true;
  return false;
}

/**
 * 给老师看的那句人话（**别把上游错误原文直接甩出去**，只按 error_code 说清楚怎么办）。
 */
export function authCallbackMessage(p: AuthCallbackParams): { ok: boolean; text: string } {
  if (p.error || p.errorCode) {
    const expired = /expired|otp_expired/i.test(`${p.errorCode ?? ""} ${p.error ?? ""}`);
    return {
      ok: false,
      text: expired
        ? "这条链接已经失效（重置链接只能用一次、而且有时效）。请在登录页重新申请一封重置邮件。"
        : "这条链接无效或已经用过。请在登录页重新申请一封重置邮件。",
    };
  }
  if (!hasSessionPayload(p)) {
    return {
      ok: false,
      text: "这个地址需要从邮件里的链接进入（直接打开是没用的）。如果是在重置密码，请重新申请一封重置邮件。",
    };
  }
  return { ok: true, text: "正在验证，请稍候…" };
}
