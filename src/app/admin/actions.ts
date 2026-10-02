"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-role";
import { createClient } from "@/lib/supabase/server";

export type AdminUser = {
  user_id: string;
  email: string | null;
  role: "admin" | "user";
  created_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed: boolean;
};

export type RoleActionState = {
  status: "idle" | "success" | "error";
  message?: string;
};

/**
 * 列出全部注册用户。
 * 通过 SECURITY DEFINER 函数 admin_list_users() 读取 auth.users，
 * 函数内部会再次校验调用者是否为管理员。
 */
export async function fetchAllUsers(): Promise<
  { ok: true; users: AdminUser[] } | { ok: false; message: string }
> {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_list_users");

  if (error) {
    return { ok: false, message: describeRpcError(error.message, error.code) };
  }

  return { ok: true, users: (data ?? []) as AdminUser[] };
}

/** 修改指定用户的角色（仅服务端可信调用点） */
export async function setUserRole(
  _prevState: RoleActionState,
  formData: FormData,
): Promise<RoleActionState> {
  // 权威校验：前端隐藏按钮不构成安全边界
  const guard = await requireAdmin();
  if (!guard.ok) {
    return {
      status: "error",
      message: guard.reason === "unauthenticated" ? "登录已过期，请重新登录。" : "没有权限执行该操作。",
    };
  }

  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");

  if (!userId) {
    return { status: "error", message: "缺少用户 ID。" };
  }
  if (role !== "admin" && role !== "user") {
    return { status: "error", message: "角色只能是 admin 或 user。" };
  }

  // 由数据库函数保证「不能降级最后一个管理员」
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_user_role", {
    p_user_id: userId,
    p_role: role,
  });

  if (error) {
    return { status: "error", message: describeRpcError(error.message, error.code) };
  }

  revalidatePath("/admin");
  revalidatePath("/tools");
  revalidatePath("/");

  // 管理员把自己降级了：失去后台权限，直接送回百宝箱并提示
  if (userId === guard.user.id && role === "user") {
    redirect("/dashboard?error=self_demoted");
  }

  return {
    status: "success",
    message: role === "admin" ? "已设为管理员。" : "已设为普通用户。",
  };
}

function describeRpcError(message: string, code?: string): string {
  const normalized = message.toLowerCase();

  if (normalized.includes("permission denied") || code === "42501") {
    return "没有权限执行该操作（仅管理员可用）。";
  }
  if (message.includes("最后一个管理员")) {
    return "不能降级最后一个管理员，请先指定另一位管理员。";
  }
  if (normalized.includes("does not exist") || code === "42883" || code === "42P01") {
    return "数据库函数或表尚不存在，请先在 Supabase SQL Editor 中执行 supabase/migrations/0001_user_roles.sql。";
  }
  if (normalized.includes("invalid input value for enum")) {
    return "角色取值无效。";
  }

  return message;
}
