"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth-role";
import { createClient } from "@/lib/supabase/server";
import type { AccountStatus, PlanId } from "@/lib/membership-types";

/** 用户在管理后台中的完整视图 */
export type AdminUserRow = {
  user_id: string;
  email: string | null;
  role: "admin" | "user";
  plan: PlanId;
  expires_at: string | null;
  status: AccountStatus;
  created_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed: boolean;
  /** 会员是否仍有效 */
  vipActive: boolean;
};

export type ActionResult = {
  status: "idle" | "success" | "error";
  message?: string;
};

type RawAdminUser = {
  user_id: string;
  email: string | null;
  role: "admin" | "user";
  created_at: string | null;
  last_sign_in_at: string | null;
  email_confirmed: boolean;
};

/**
 * 列出全部注册用户及其会员信息。
 *
 * 用户基础信息来自 SECURITY DEFINER 函数 admin_list_users()（内部校验管理员）；
 * 会员字段来自 user_roles 表 —— 管理员可读取全表（RLS "admins read all roles"）。
 */
export async function fetchAllUsers(): Promise<
  { ok: true; users: AdminUserRow[] } | { ok: false; message: string }
> {
  const supabase = await createClient();

  const { data: baseUsers, error } = await supabase.rpc("admin_list_users");
  if (error) {
    return { ok: false, message: describeDbError(error.message, error.code) };
  }

  const { data: roleRows, error: roleError } = await supabase
    .from("user_roles")
    .select("user_id, plan, expires_at, status");

  if (roleError) {
    return { ok: false, message: describeDbError(roleError.message, roleError.code) };
  }

  const membershipMap = new Map(
    (roleRows ?? []).map((row) => [
      row.user_id as string,
      {
        plan: (row.plan === "vip" ? "vip" : "free") as PlanId,
        expires_at: (row.expires_at as string | null) ?? null,
        status: (row.status === "banned" ? "banned" : "active") as AccountStatus,
      },
    ]),
  );

  const users: AdminUserRow[] = ((baseUsers ?? []) as RawAdminUser[]).map((u) => {
    const membership = membershipMap.get(u.user_id) ?? {
      plan: "free" as PlanId,
      expires_at: null,
      status: "active" as AccountStatus,
    };

    const expiresMs = membership.expires_at ? new Date(membership.expires_at).getTime() : 0;
    const vipActive =
      membership.plan === "vip" &&
      membership.status === "active" &&
      !Number.isNaN(expiresMs) &&
      expiresMs > Date.now();

    return { ...u, ...membership, vipActive };
  });

  return { ok: true, users };
}

/** 开通 30 天会员 */
export async function grantVip(
  _prevState: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return denyFor(guard.reason);

  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { status: "error", message: "缺少用户 ID。" };

  const days = Number(formData.get("days") ?? 30);
  const safeDays = Number.isFinite(days) && days > 0 && days <= 3650 ? Math.floor(days) : 30;

  const expiresAt = new Date(Date.now() + safeDays * 86_400_000).toISOString();

  const supabase = await createClient();
  const { error } = await supabase.from("user_roles").upsert(
    {
      user_id: userId,
      plan: "vip",
      expires_at: expiresAt,
      status: "active",
    },
    { onConflict: "user_id" },
  );

  if (error) return { status: "error", message: describeDbError(error.message, error.code) };

  revalidateAll();
  return { status: "success", message: `已开通 ${safeDays} 天会员。` };
}

/** 取消会员（保留账号，仅把 plan 设回 free） */
export async function cancelVip(
  _prevState: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return denyFor(guard.reason);

  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { status: "error", message: "缺少用户 ID。" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("user_roles")
    .update({ plan: "free", expires_at: null })
    .eq("user_id", userId);

  if (error) return { status: "error", message: describeDbError(error.message, error.code) };

  revalidateAll();
  return { status: "success", message: "已取消会员。" };
}

/** 封禁 / 解封 账号 */
export async function toggleBan(
  _prevState: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const guard = await requireAdmin();
  if (!guard.ok) return denyFor(guard.reason);

  const userId = String(formData.get("userId") ?? "");
  const nextStatus = String(formData.get("nextStatus") ?? "");

  if (!userId) return { status: "error", message: "缺少用户 ID。" };
  if (nextStatus !== "banned" && nextStatus !== "active") {
    return { status: "error", message: "状态取值无效。" };
  }

  // 不允许封禁自己，避免管理员把自己锁在门外
  if (userId === guard.user.id && nextStatus === "banned") {
    return { status: "error", message: "不能封禁当前登录的管理员自己。" };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("user_roles")
    .upsert({ user_id: userId, status: nextStatus }, { onConflict: "user_id" });

  if (error) return { status: "error", message: describeDbError(error.message, error.code) };

  revalidateAll();
  return {
    status: "success",
    message: nextStatus === "banned" ? "已封禁该账号。" : "已解封该账号。",
  };
}

function revalidateAll() {
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath("/tools");
}

function denyFor(reason: "unauthenticated" | "forbidden"): ActionResult {
  return {
    status: "error",
    message: reason === "unauthenticated" ? "登录已过期，请重新登录。" : "没有权限执行该操作。",
  };
}

/** 把数据库错误翻译成可操作的中文提示 */
function describeDbError(message: string, code?: string): string {
  const normalized = message.toLowerCase();

  if (code === "42501" || normalized.includes("permission denied") || normalized.includes("row-level security")) {
    return "数据库拒绝了该操作（RLS 策略不允许）。请在 Supabase SQL Editor 中执行 supabase/migrations/0002_membership_admin_policies.sql 补充管理员策略。";
  }
  if (code === "42P01" || normalized.includes("does not exist")) {
    return "缺少数据库对象（表或函数）。请先执行 supabase/migrations 下的建表 SQL。";
  }
  if (code === "42883" || normalized.includes("could not find the function")) {
    return "缺少数据库函数，请先执行建表 SQL。";
  }
  if (normalized.includes("invalid input value for enum")) {
    return "字段取值无效（枚举类型不匹配）。";
  }

  return message;
}
