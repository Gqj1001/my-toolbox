import AuthConfirmClient from "@/components/auth-confirm-client";

/**
 * 邮件链接回调（客户端页，2026-10 第十六批）
 *
 * ⚠️ 这里原来是 `route.ts`（服务端路由），**已删除** —— 原因见
 *    `src/lib/auth-callback.ts` 的文件头：Supabase 把会话放在 URL 的 `#` 片段里，
 *    而 `#` 不发给服务器，服务端那条路**永远看不到会话** ⇒ 一律跳登录页。
 *
 * 两种邮件都会回到这里：
 *   · **注册确认**（`signUp` 的 `emailRedirectTo`）→ 换出会话后去 `/`；
 *   · **重置密码**（`resetPasswordForEmail` 的 `redirectTo` + `?next=/reset-password`）
 *     → 换出会话后去 `/reset-password` 设新密码。
 *
 * ⚠️ 这个路径必须在 `src/proxy.ts` 的 `PUBLIC_PATHS` 里（`/auth` 前缀已覆盖）：
 *    点邮件链接的人**一定还没登录**。
 * ⚠️ 真正的逻辑全在客户端组件里（读 `#` + 落 Cookie），这个文件只是个壳。
 */
export default function AuthConfirmPage() {
  return <AuthConfirmClient />;
}
