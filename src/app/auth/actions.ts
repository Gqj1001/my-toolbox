"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { translateAuthError } from "@/lib/auth-errors";

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

/* ⚠️ `translateAuthError()` 已经搬到 `src/lib/auth-errors.ts`（2026-10 第十五批）。
 *    原因：本文件顶部有 `"use server"`，而**该指令下每一个 export 都会变成 Server Action**
 *    ⇒ 同步函数不能 export（构建直接报 `Server Actions must be async functions`）。
 *    密码相关那两个动作（`app/auth/password-actions.ts`）与本文件都从新位置 import 它。
 *    **不要**把它复制回来 —— 那会变成两份中文口径。 */
