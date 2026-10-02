import { createClient } from "@/lib/supabase/server";

/** 应用层角色：数据库 user_role 枚举的超集，未建行的用户按 'user' 处理 */
export type AppRole = "admin" | "user";

export const DEFAULT_ROLE: AppRole = "user";

export function isAdminRole(role: AppRole | null | undefined): boolean {
  return role === "admin";
}

/**
 * 读取当前登录用户的角色。
 * 读取的是 user_roles 表自身的数据，受 RLS "users read own role" 策略保护。
 * 尚未写入角色行的用户视为普通用户。
 */
export async function getCurrentUserRole(): Promise<AppRole | null> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) return DEFAULT_ROLE;

  return data.role === "admin" ? "admin" : "user";
}

/** 一次性拿到当前用户与其角色，避免重复请求 */
export async function getCurrentUserWithRole() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, role: null as AppRole | null };

  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  const role: AppRole = data?.role === "admin" ? "admin" : DEFAULT_ROLE;

  return { user, role };
}

/**
 * 校验调用者身份（Server Action / Route Handler 的权威校验）。
 * 前端隐藏 UI 不构成安全边界，所有管理操作都必须先过这里。
 */
export async function requireAdmin() {
  const { user, role } = await getCurrentUserWithRole();

  if (!user) {
    return { ok: false as const, reason: "unauthenticated" as const };
  }
  if (!isAdminRole(role)) {
    return { ok: false as const, reason: "forbidden" as const };
  }

  return { ok: true as const, user, role };
}
