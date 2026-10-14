/**
 * 认证类报错的中文翻译 —— **全站唯一来源**
 *
 * 为什么单独成文件（2026-10 第十五批）：
 *   它原来住在 `src/app/auth/actions.ts` 里，而那个文件顶部有 `"use server"`。
 *   本轮想把它 export 给"忘记密码 / 修改密码"复用时，构建直接报
 *   **`Server Actions must be async functions`** —— 因为 `"use server"` 文件里的
 *   **每一个 export 都会变成 Server Action**，而它是同步函数。
 *   ⇒ 所以：**同步的纯函数不能放在 `"use server"` 文件里**，要单独一个文件。
 *
 * ⚠️ 不要再把这份翻译复制到别的页面/动作里：同一个错误在不同页面显示成两种说法，
 *    正是本项目反复踩过的"同一件事两个来源"。
 */

/** 把 Supabase 的英文报错转成中文提示 */
export function translateAuthError(error: { message?: string; code?: string }): string {
  const message = error.message ?? "";
  const code = error.code ?? "";
  const normalized = message.toLowerCase();

  if (code === "invalid_credentials" || normalized.includes("invalid login credentials")) {
    return "邮箱或密码不正确。";
  }
  if (code === "email_not_confirmed" || normalized.includes("email not confirmed")) {
    return "邮箱尚未确认，请先点击确认邮件中的链接。";
  }
  if (
    code === "user_already_exists" ||
    normalized.includes("user already registered") ||
    normalized.includes("already been registered") ||
    normalized.includes("user already exists")
  ) {
    return "该邮箱已注册，请直接登录。";
  }
  // 覆盖 "Unable to validate email address: invalid format" / "invalid domain" 等
  if (
    code === "validation_failed" ||
    normalized.includes("unable to validate email") ||
    normalized.includes("invalid format")
  ) {
    return "邮箱格式不正确，请检查后重新输入。";
  }
  // 实测 Supabase 返回 "Password should be at least 6 characters."
  if (code === "weak_password" || normalized.includes("password should be at least")) {
    return "密码长度不足，至少需要 6 个字符。";
  }
  if (normalized.includes("password is too weak")) {
    return "密码强度不足，请使用更复杂的密码（建议包含大小写字母与数字）。";
  }
  // 2026 起 Supabase 默认启用泄露密码检测（HaveIBeenPwned）
  if (code === "weak_password_pwned" || normalized.includes("pwned") || normalized.includes("compromised")) {
    return "该密码已在数据泄露库中出现，请更换一个更安全的密码。";
  }
  if (
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit" ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests")
  ) {
    return "请求过于频繁（可能是邮件发送限额），请稍后再试。";
  }
  if (
    code === "signup_disabled" ||
    normalized.includes("signups not allowed") ||
    normalized.includes("signup is disabled")
  ) {
    return "当前项目已关闭注册功能，请联系管理员。";
  }
  if (normalized.includes("failed to fetch") || normalized.includes("network")) {
    return "无法连接认证服务，请检查网络后重试。";
  }

  return message || "操作失败，请稍后重试。";
}
