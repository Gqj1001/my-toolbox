"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AuthFormState = {
  status: "idle" | "error" | "success";
  message?: string;
};

/** 只允许站内相对路径，避免开放重定向 */
function safeRedirectPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

async function getOrigin() {
  const headersList = await headers();
  const host = headersList.get("x-forwarded-host") ?? headersList.get("host");
  const protocol = headersList.get("x-forwarded-proto") ?? "http";
  return `${protocol}://${host}`;
}

export async function signUp(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { status: "error", message: "请填写邮箱和密码。" };
  }
  if (password.length < 6) {
    return { status: "error", message: "密码至少需要 6 个字符。" };
  }

  const supabase = await createClient();
  const origin = await getOrigin();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // 邮箱确认邮件中的链接会回到本项目的 /auth/confirm
      emailRedirectTo: `${origin}/auth/confirm`,
    },
  });

  if (error) {
    return { status: "error", message: translateAuthError(error) };
  }

  // 项目开启了邮箱确认：此时还没有会话，需要用户去邮箱点确认链接
  if (!data.session) {
    return {
      status: "success",
      message: `确认邮件已发送到 ${email}，请点击邮件中的链接完成注册后返回登录。`,
    };
  }

  revalidatePath("/", "layout");
  redirect("/");
}

export async function logIn(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const redirectTo = safeRedirectPath(formData.get("redirectTo"));

  if (!email || !password) {
    return { status: "error", message: "请填写邮箱和密码。" };
  }

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return { status: "error", message: translateAuthError(error) };
  }

  if (!data.user) {
    return { status: "error", message: "登录失败，请稍后重试。" };
  }

  revalidatePath("/", "layout");
  redirect(redirectTo);
}

export async function logOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  revalidatePath("/", "layout");
  redirect("/login");
}

/** 把 Supabase 的英文报错转成中文提示 */
function translateAuthError(error: { message?: string; code?: string }): string {
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
